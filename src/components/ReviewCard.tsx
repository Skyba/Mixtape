import { useEffect, useMemo, useRef, useState } from "react";
import { GestureResponderEvent, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { Recording, INBOX } from "../types";
import { SOURCE_WORD, TRUST_COLOR, trustOf, duplicateNames, flagOpen } from "../attribution";

const mine = (by?: string) => by === "user" || by === "auto";
import type { Utterance } from "../transcription";
import NamePicker from "./NamePicker";

const CLIP_MS = 6000;

type Props = {
  rec: Recording;
  utterances: Utterance[] | null;
  /** Local file or a signed URL; null hides the play buttons. */
  audioSource: string | null;
  folderIcon: string;
  /** Everyone named before, most recent first. */
  history: string[];
  editable: boolean;
  onSetName: (key: string, name: string) => void;
  onRemoveName: (key: string) => void;
  /** Every voice on screen as shown — named ones (including those AssemblyAI
   *  named directly, which carry no stored label yet) and, with an empty
   *  name, the ones you leave unnamed. */
  onConfirmAll: (named: { letter: string; name: string }[]) => void;
  onAcceptFolder: (folder: string) => void;
  onChangeFolder: () => void;
  onRerun: () => void;
};

/**
 * Picks where a voice's clip starts: inside a turn of 3-20 s with the most
 * words per second, at its first word — so the clip opens on speech, not on
 * the pause or noise before it.
 */
function clipStart(us: Utterance[]): number {
  let best: { at: number; score: number } | null = null;
  for (const u of us) {
    const d = ((u.end ?? u.start) - u.start) / 1000;
    if (d < 3 || d > 20) continue;
    const words = (u as any).words as { start: number }[] | undefined;
    const rate = (words?.length ?? u.text.split(/\s+/).length) / d;
    const at = words?.[0]?.start ?? u.start;
    if (!best || rate > best.score) best = { at, score: rate };
  }
  if (best) return best.at;
  const longest = [...us].sort((a, b) => ((b.end ?? b.start) - b.start) - ((a.end ?? a.start) - a.start))[0];
  return ((longest as any)?.words?.[0]?.start ?? longest?.start) || 0;
}

/**
 * The review, at the top of a transcribed recording: which folder, and who
 * each voice is. ▶ plays a few seconds of that voice; the line under a name
 * says how it was inferred; tapping it opens the name picker (any name, a new
 * one, merge into another voice, remove).
 */
const unnamedCount = (ss: { left: boolean }[]) => ss.filter((x) => x.left).length;

export default function ReviewCard(p: Props) {
  const { rec, utterances } = p;
  const trust = trustOf(rec);
  const [picking, setPicking] = useState<string | null>(null);
  const player = useAudioPlayer(p.audioSource ?? undefined);
  const status = useAudioPlayerStatus(player);
  const [playing, setPlaying] = useState<string | null>(null);
  const stopAt = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (stopAt.current) clearTimeout(stopAt.current); }, []);
  useEffect(() => { if (!status.playing) setPlaying(null); }, [status.playing]);

  const speakers = useMemo(() => {
    const by: Record<string, Utterance[]> = Object.create(null);
    for (const u of utterances ?? []) (by[u.speaker] ??= []).push(u);
    return Object.entries(by).map(([L, us]) => {
      const secs = us.reduce((t, u) => t + ((u.end ?? u.start) - u.start) / 1000, 0);
      const lab = rec.speakerLabels?.[L];
      // An empty name you gave means "leave this voice unnamed": settled.
      const left = lab?.by === "user" && !lab.name;
      const name = left ? `Voice ${L}` : lab?.name || rec.speakerMap?.[L] || (/^[A-Z]$/.test(L) ? `Speaker ${L}` : L);
      const by = lab?.by ?? (!/^[A-Z]$/.test(L) ? "aai" : undefined);
      const how = left ? "left unnamed by you"
        : by === "user" ? (lab?.evidence ? `named by you · ${lab.evidence}` : "named by you")
        : by === "auto" ? `matched · ${lab?.evidence || "your names + voice"}`
        : `suggested · ${lab?.evidence || (by ? SOURCE_WORD[by] : "")}`;
      return { L, name, by, how, secs, us, clip: clipStart(us), left, unnamed: !left && /^Speaker /.test(name) };
    }).sort((a, b) => b.secs - a.secs);
  }, [utterances, rec.speakerLabels, rec.speakerMap]);
  const total = useMemo(() => Math.max(1, ...(utterances ?? []).map((u) => u.end ?? u.start)), [utterances]);
  const [laneW, setLaneW] = useState(0);

  function play(L: string, startMs: number, ms = CLIP_MS, toggle = true) {
    if (toggle && playing === L) { player.pause(); setPlaying(null); return; }
    if (stopAt.current) clearTimeout(stopAt.current);
    player.seekTo(startMs / 1000);
    player.play();
    setPlaying(L);
    stopAt.current = setTimeout(() => { player.pause(); setPlaying(null); }, ms);
  }
  /** A tap on a voice's lane plays that voice's turn nearest the tap. */
  function playAt(s: { L: string; us: Utterance[] }, e: GestureResponderEvent) {
    if (!laneW) return;
    const t = (e.nativeEvent.locationX / laneW) * total;
    // The turn under the finger, else the nearest one.
    const gap = (x: Utterance) => (t < x.start ? x.start - t : t > (x.end ?? x.start) ? t - (x.end ?? x.start) : 0);
    const u = s.us.reduce((best, x) => (gap(x) < gap(best) ? x : best), s.us[0]);
    play(s.L, u.start, Math.max(1500, Math.min(20000, (u.end ?? u.start) - u.start)), false);
  }

  const toConfirm = speakers.filter((s) => !mine(s.by) && !s.unnamed);
  const unnamed = speakers.filter((s) => s.unnamed);
  const fmtSecs = (x: number) => (x < 60 ? `${Math.max(1, Math.round(x))} s` : `${Math.round(x / 60)} min`);
  // One voice filed under "self": the folder line says nothing the voice
  // line does not, so it is not shown.
  const soloSelf = speakers.length === 1 && rec.folder === "self" && mine(speakers[0].by);
  const here = Array.from(new Set(speakers.filter((s) => !s.unnamed).map((s) => s.name).concat(rec.speakers.filter((n) => !/^Speaker \d+$/.test(n)))));
  const pickFor = speakers.find((s) => s.L === picking);
  const suggested = rec.folder === INBOX && rec.folderSuggestion;

  return (
    <View style={[styles.card, { borderColor: TRUST_COLOR[trust] }, trust === "green" && styles.glow]}>
      <View style={styles.head}>
        <View style={[styles.dot, { backgroundColor: TRUST_COLOR[trust] }]} />
        <Text style={styles.headTxt}>
          {{ green: unnamedCount(speakers) ? `Confirmed · ${unnamedCount(speakers)} left unnamed` : "Confirmed", yellow: "Suggestions to confirm", red: "Something doesn't add up — have a listen", grey: rec.folder !== INBOX ? "Speakers not named yet" : "Nothing known yet" }[trust]}
        </Text>
      </View>
      {flagOpen(rec) ? <Text style={styles.flag}>{rec.reviewFlag!.reason}</Text> : null}
      {duplicateNames({ ...rec, speakerKeys: speakers.map((x) => x.L) }).map((n) => (
        <Text key={n} style={styles.flag}>Two voices are called {n}: listen to both and rename the wrong one.</Text>
      ))}

      {soloSelf ? null : <>
      <View style={styles.row}>
        <Text style={styles.icon}>{p.folderIcon}</Text>
        <TouchableOpacity style={{ flex: 1 }} onPress={p.onChangeFolder}>
          <Text style={[styles.name, suggested ? styles.inferred : rec.folder === INBOX ? styles.muted : null]} numberOfLines={1}>
            {suggested ? suggested.folder : rec.folder === INBOX ? "Inbox — tap to file" : rec.folder}
          </Text>
          {suggested ? <Text style={styles.how}>suggested · {suggested.why}</Text> : null}
        </TouchableOpacity>
        {suggested ? (
          <TouchableOpacity style={styles.unchecked} onPress={() => p.onAcceptFolder(suggested.folder)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Text style={styles.uncheckedTxt}>✓</Text>
          </TouchableOpacity>
        ) : rec.folder !== INBOX ? <View style={styles.checked}><Text style={styles.checkedTxt}>✓</Text></View> : null}
      </View>

      <View style={styles.sep} />
      </>}
      {speakers.length === 0 ? <Text style={styles.muted}>{rec.transcriptStatus === "done" ? "No speech found in this recording." : "No transcript yet."}</Text> : null}
      {speakers.map((s) => (
        <View key={s.L} style={styles.voice}>
          <View style={styles.row}>
            {p.audioSource ? (
              <TouchableOpacity style={styles.play} onPress={() => play(s.L, s.clip)}>
                <Text style={styles.playTxt}>{playing === s.L ? "■" : "▶"}</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity style={{ flex: 1 }} disabled={!p.editable} onPress={() => setPicking(s.L)}>
              <Text style={[styles.name, !mine(s.by) && (s.unnamed ? styles.muted : styles.inferred), s.left && styles.muted]} numberOfLines={1}>
                {s.name}
                <Text style={styles.mins}>  {fmtSecs(s.secs)}</Text>
              </Text>
              <Text style={styles.how} numberOfLines={1}>{s.unnamed ? "not named · tap to name or merge" : s.how}</Text>
            </TouchableOpacity>
            {mine(s.by) ? (
              <View style={styles.checked}><Text style={styles.checkedTxt}>✓</Text></View>
            ) : p.editable && !s.unnamed ? (
              <TouchableOpacity style={styles.unchecked} onPress={() => p.onSetName(s.L, s.name)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Text style={styles.uncheckedTxt}>✓</Text>
              </TouchableOpacity>
            ) : null}
          </View>
          {/* When this voice speaks across the recording; tap to hear it there. */}
          <TouchableOpacity activeOpacity={0.7} disabled={!p.audioSource} onPress={(e) => playAt(s, e)}
            style={[styles.lane, p.audioSource ? { marginLeft: 44 } : null]} onLayout={(e) => setLaneW(e.nativeEvent.layout.width)}>
            {s.us.map((u, i) => (
              <View key={i} pointerEvents="none" style={[styles.seg, {
                left: `${(u.start / total) * 100}%`,
                width: `${Math.max(0.4, (((u.end ?? u.start) - u.start) / total) * 100)}%`,
                backgroundColor: mine(s.by) && !s.left ? "#4ade80" : s.unnamed || s.left ? "#6b7280" : "#facc15",
              }]} />
            ))}
            {playing === s.L ? <View pointerEvents="none" style={[styles.cursor, { left: `${Math.min(100, (status.currentTime * 1000 / total) * 100)}%` }]} /> : null}
          </TouchableOpacity>
        </View>
      ))}

      {p.editable && (toConfirm.length || unnamed.length) ? (
        <TouchableOpacity style={styles.primary}
          onPress={() => p.onConfirmAll([...toConfirm.map((x) => ({ letter: x.L, name: x.name })), ...unnamed.map((x) => ({ letter: x.L, name: "" }))])}>
          <Text style={styles.primaryTxt}>
            {unnamed.length
              ? `✓ Confirm${toConfirm.length ? " the names" : ""} — leave ${unnamed.length} voice${unnamed.length > 1 ? "s" : ""} unnamed`
              : toConfirm.length > 1 ? "✓ Confirm all" : "✓ Confirm"}
          </Text>
        </TouchableOpacity>
      ) : null}
      {p.editable && speakers.length ? (
        <View style={styles.actions}>
          <View style={{ flex: 1 }} />
          <TouchableOpacity style={styles.link} onPress={p.onRerun}>
            <Text style={styles.linkTxt}>Wrong number of voices?</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <NamePicker
        visible={!!pickFor}
        title={pickFor ? `Who is ${pickFor.unnamed ? pickFor.name.replace("Speaker ", "voice ") : `“${pickFor.name}”`}?` : ""}
        here={here}
        history={p.history}
        mergeInto={speakers.filter((s) => s.L !== picking && !s.unnamed && !s.left).map((s) => ({ key: s.L, name: s.name }))}
        canRemove={!!pickFor && !pickFor.unnamed && !!rec.speakerLabels?.[pickFor.L] && /^[A-Z]$/.test(pickFor.L)}
        canLeaveUnnamed={!!pickFor && !pickFor.left}
        onLeaveUnnamed={() => { const L = picking!; setPicking(null); p.onConfirmAll([{ letter: L, name: "" }]); }}
        onPick={(name) => { const L = picking!; setPicking(null); p.onSetName(L, name); }}
        onMerge={(target, name) => {
          // Merging confirms both voices: the target's name was perhaps only a
          // suggestion, and a name on two voices is accepted only when both are yours.
          const L = picking!; setPicking(null);
          p.onConfirmAll([{ letter: L, name }, { letter: target, name }]);
        }}
        onRemove={() => { const L = picking!; setPicking(null); p.onRemoveName(L); }}
        onClose={() => setPicking(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: "#15181d", borderRadius: 12, borderWidth: 1.5, padding: 12, marginTop: 12 },
  glow: { boxShadow: "0 0 18px 3px rgba(74, 222, 128, 0.45), inset 0 0 12px rgba(74, 222, 128, 0.12)" },
  voice: { paddingVertical: 3 },
  lane: { height: 10, borderRadius: 5, backgroundColor: "#23262d", overflow: "hidden", marginTop: 2, marginBottom: 4 },
  seg: { position: "absolute", top: 0, bottom: 0, borderRadius: 1, opacity: 0.85 },
  cursor: { position: "absolute", top: -2, bottom: -2, width: 2, backgroundColor: "#fff" },
  checked: { width: 30, height: 30, borderRadius: 15, backgroundColor: "#4ade80", alignItems: "center", justifyContent: "center", marginRight: 6 },
  checkedTxt: { color: "#0f1115", fontWeight: "900", fontSize: 15 },
  unchecked: { width: 30, height: 30, borderRadius: 15, borderWidth: 2, borderColor: "#6b7280", alignItems: "center", justifyContent: "center", marginRight: 6 },
  uncheckedTxt: { color: "#6b7280", fontWeight: "700", fontSize: 14 },
  head: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  headTxt: { color: "#e8eaed", fontSize: 14, fontWeight: "700" },
  flag: { color: "#fca5a5", fontSize: 12, marginBottom: 6 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 5 },
  icon: { fontSize: 20, width: 34, textAlign: "center" },
  play: { width: 34, height: 34, borderRadius: 17, backgroundColor: "#23262d", alignItems: "center", justifyContent: "center" },
  playTxt: { color: "#fff", fontSize: 13 },
  name: { color: "#fff", fontSize: 15 },
  mins: { color: "#7c828a", fontSize: 12 },
  how: { color: "#7c828a", fontSize: 12, marginTop: 1 },
  inferred: { color: "#facc15" },
  muted: { color: "#9aa0a6" },
  sep: { height: 1, backgroundColor: "#23262d", marginVertical: 6 },
  actions: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8 },
  primary: { backgroundColor: "#2f6fd0", borderRadius: 10, padding: 11, alignItems: "center", marginTop: 10 },
  primaryTxt: { color: "#fff", fontWeight: "700" },
  link: { paddingHorizontal: 6, paddingVertical: 8 },
  linkTxt: { color: "#93c5fd", fontSize: 13 },
});

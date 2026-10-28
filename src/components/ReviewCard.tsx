import { useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { Recording, INBOX } from "../types";
import { SOURCE_WORD, TRUST_COLOR, trustOf } from "../attribution";
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
  /** Every named voice on screen, as shown — including ones AssemblyAI
   *  named directly, which carry no stored label yet. */
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
    const by: Record<string, Utterance[]> = {};
    for (const u of utterances ?? []) (by[u.speaker] ??= []).push(u);
    return Object.entries(by).map(([L, us]) => {
      const secs = us.reduce((t, u) => t + ((u.end ?? u.start) - u.start) / 1000, 0);
      const lab = rec.speakerLabels?.[L];
      const name = lab?.name ?? rec.speakerMap?.[L] ?? (/^[A-Z]$/.test(L) ? `Speaker ${L}` : L);
      const by = lab?.by ?? (!/^[A-Z]$/.test(L) ? "aai" : undefined);
      const how = by === "user" ? "you" : lab?.evidence || (by ? SOURCE_WORD[by] : "");
      return { L, name, by, how, secs, clip: clipStart(us), unnamed: /^Speaker /.test(name) };
    }).sort((a, b) => b.secs - a.secs);
  }, [utterances, rec.speakerLabels, rec.speakerMap]);

  function play(L: string, startMs: number) {
    if (playing === L) { player.pause(); setPlaying(null); return; }
    if (stopAt.current) clearTimeout(stopAt.current);
    player.seekTo(startMs / 1000);
    player.play();
    setPlaying(L);
    stopAt.current = setTimeout(() => { player.pause(); setPlaying(null); }, CLIP_MS);
  }

  const toConfirm = speakers.filter((s) => s.by !== "user" && !s.unnamed);
  const here = Array.from(new Set(speakers.filter((s) => !s.unnamed).map((s) => s.name).concat(rec.speakers.filter((n) => !/^Speaker \d+$/.test(n)))));
  const pickFor = speakers.find((s) => s.L === picking);
  const suggested = rec.folder === INBOX && rec.folderSuggestion;

  return (
    <View style={[styles.card, { borderColor: TRUST_COLOR[trust] }]}>
      <View style={styles.head}>
        <View style={[styles.dot, { backgroundColor: TRUST_COLOR[trust] }]} />
        <Text style={styles.headTxt}>
          {{ green: "Confirmed", yellow: "Suggestions to confirm", red: "Something doesn't add up — have a listen", grey: "Nothing known yet" }[trust]}
        </Text>
      </View>
      {rec.reviewFlag ? <Text style={styles.flag}>{rec.reviewFlag.reason}</Text> : null}

      <View style={styles.row}>
        <Text style={styles.icon}>{p.folderIcon}</Text>
        <TouchableOpacity style={{ flex: 1 }} onPress={p.onChangeFolder}>
          <Text style={[styles.name, suggested ? styles.inferred : rec.folder === INBOX ? styles.muted : null]} numberOfLines={1}>
            {suggested ? suggested.folder : rec.folder === INBOX ? "Inbox — tap to file" : rec.folder}
          </Text>
          {suggested ? <Text style={styles.how}>suggested · {suggested.why}</Text> : null}
        </TouchableOpacity>
        {suggested ? (
          <TouchableOpacity style={styles.ok} onPress={() => p.onAcceptFolder(suggested.folder)}>
            <Text style={styles.okTxt}>✓</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      <View style={styles.sep} />
      {speakers.length === 0 ? <Text style={styles.muted}>No transcript yet.</Text> : null}
      {speakers.map((s) => (
        <View key={s.L} style={styles.row}>
          {p.audioSource ? (
            <TouchableOpacity style={styles.play} onPress={() => play(s.L, s.clip)}>
              <Text style={styles.playTxt}>{playing === s.L ? "■" : "▶"}</Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity style={{ flex: 1 }} disabled={!p.editable} onPress={() => setPicking(s.L)}>
            <Text style={[styles.name, s.by !== "user" && (s.unnamed ? styles.muted : styles.inferred)]} numberOfLines={1}>
              {s.name}
              <Text style={styles.mins}>  {Math.round(s.secs / 60) || "<1"} min</Text>
            </Text>
            {s.how ? <Text style={styles.how} numberOfLines={1}>{s.how}</Text> : s.unnamed ? <Text style={styles.how}>tap to name or merge</Text> : null}
          </TouchableOpacity>
          {p.editable && s.by !== "user" && !s.unnamed ? (
            <TouchableOpacity style={styles.ok} onPress={() => p.onSetName(s.L, s.name)}>
              <Text style={styles.okTxt}>✓</Text>
            </TouchableOpacity>
          ) : s.by === "user" ? <Text style={styles.done}>✓</Text> : null}
        </View>
      ))}

      {p.editable && speakers.length ? (
        <View style={styles.actions}>
          {toConfirm.length > 1 ? (
            <TouchableOpacity style={styles.primary} onPress={() => p.onConfirmAll(toConfirm.map((x) => ({ letter: x.L, name: x.name })))}>
              <Text style={styles.primaryTxt}>Confirm all</Text>
            </TouchableOpacity>
          ) : <View style={{ flex: 1 }} />}
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
        mergeInto={speakers.filter((s) => s.L !== picking && !s.unnamed).map((s) => ({ key: s.L, name: s.name }))}
        canRemove={!!pickFor && !pickFor.unnamed}
        onPick={(name) => { const L = picking!; setPicking(null); p.onSetName(L, name); }}
        onMerge={(_, name) => { const L = picking!; setPicking(null); p.onSetName(L, name); }}
        onRemove={() => { const L = picking!; setPicking(null); p.onRemoveName(L); }}
        onClose={() => setPicking(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: "#15181d", borderRadius: 12, borderWidth: 1.5, padding: 12, marginTop: 12 },
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
  ok: { backgroundColor: "#16331f", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  okTxt: { color: "#4ade80", fontWeight: "700" },
  done: { color: "#4ade80", fontWeight: "700", paddingHorizontal: 12 },
  sep: { height: 1, backgroundColor: "#23262d", marginVertical: 6 },
  actions: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8 },
  primary: { flex: 1, backgroundColor: "#2f6fd0", borderRadius: 10, padding: 10, alignItems: "center" },
  primaryTxt: { color: "#fff", fontWeight: "700" },
  link: { paddingHorizontal: 6, paddingVertical: 8 },
  linkTxt: { color: "#93c5fd", fontSize: 13 },
});

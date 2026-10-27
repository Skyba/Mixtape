import { useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { Recording, INBOX } from "../types";
import { SOURCE_WORD, TRUST_COLOR, trustOf } from "../attribution";
import type { Utterance } from "../transcription";

const CLIP_MS = 6000;

type Props = {
  rec: Recording;
  utterances: Utterance[] | null;
  /** Local file or a signed URL; null hides the play buttons. */
  audioSource: string | null;
  /** Names to offer when a speaker is wrong. */
  options: string[];
  editable: boolean;
  onSetName: (letter: string, name: string) => void;
  /** Every named voice on screen, as shown — including ones AssemblyAI
   *  named directly, which carry no stored label yet. */
  onConfirmAll: (named: { letter: string; name: string }[]) => void;
  onNotMe: () => void;
  onAcceptFolder: (folder: string) => void;
  onChangeFolder: () => void;
};

/**
 * The review: who is speaking and which folder, at the top of a recording.
 * Each voice gets a play button (a few seconds of its longest turn) so it is
 * judged by ear, the name the system thinks it is, and where that name came
 * from. ✓ confirms, tapping the name picks another.
 */
export default function ReviewCard(p: Props) {
  const { rec, utterances } = p;
  const trust = trustOf(rec);
  const [editing, setEditing] = useState<string | null>(null);
  const player = useAudioPlayer(p.audioSource ?? undefined);
  const status = useAudioPlayerStatus(player);
  const [playing, setPlaying] = useState<string | null>(null);
  const stopAt = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (stopAt.current) clearTimeout(stopAt.current); }, []);
  useEffect(() => { if (!status.playing) setPlaying(null); }, [status.playing]);

  const speakers = useMemo(() => {
    const by: Record<string, { secs: number; clip: number }> = {};
    let best: Record<string, number> = {};
    for (const u of utterances ?? []) {
      const d = (u.end ?? u.start) - u.start;
      const x = (by[u.speaker] ??= { secs: 0, clip: u.start });
      x.secs += d / 1000;
      if (d > (best[u.speaker] ?? 0)) { best[u.speaker] = d; x.clip = u.start; }
    }
    return Object.entries(by).sort((a, b) => b[1].secs - a[1].secs).map(([L, v]) => {
      const lab = rec.speakerLabels?.[L];
      const name = lab?.name ?? rec.speakerMap?.[L] ?? (/^[A-Z]$/.test(L) ? `Speaker ${L}` : L);
      return { L, name, by: lab?.by ?? (L === name && !/^Speaker /.test(name) ? "aai" : undefined), ...v };
    });
  }, [utterances, rec.speakerLabels, rec.speakerMap]);

  function play(L: string, startMs: number) {
    if (playing === L) { player.pause(); setPlaying(null); return; }
    if (stopAt.current) clearTimeout(stopAt.current);
    player.seekTo(startMs / 1000);
    player.play();
    setPlaying(L);
    stopAt.current = setTimeout(() => { player.pause(); setPlaying(null); }, CLIP_MS);
  }

  const unconfirmed = speakers.filter((s) => s.by !== "user" && !/^Speaker /.test(s.name));
  const folderLine = rec.folder !== INBOX
    ? { text: rec.folder, ok: true }
    : rec.folderSuggestion
      ? { text: rec.folderSuggestion.folder, ok: false, why: rec.folderSuggestion.why }
      : { text: "Inbox — not filed", ok: false };

  return (
    <View style={[styles.card, { borderColor: TRUST_COLOR[trust] }]}>
      <View style={styles.head}>
        <View style={[styles.dot, { backgroundColor: TRUST_COLOR[trust] }]} />
        <Text style={styles.headTxt}>
          {{ green: "Confirmed", yellow: "Needs your confirmation", red: "The signals disagree — have a listen", grey: "Nothing known yet" }[trust]}
        </Text>
      </View>
      {rec.reviewFlag ? <Text style={styles.flag}>{rec.reviewFlag.reason}</Text> : null}

      <Text style={styles.label}>FOLDER</Text>
      <View style={styles.row}>
        <Text style={[styles.name, !folderLine.ok && styles.inferred]} numberOfLines={1}>
          {folderLine.text}{"why" in folderLine && folderLine.why ? <Text style={styles.src}>  · suggested</Text> : null}
        </Text>
        {!folderLine.ok && rec.folderSuggestion ? (
          <TouchableOpacity style={styles.ok} onPress={() => p.onAcceptFolder(rec.folderSuggestion!.folder)}>
            <Text style={styles.okTxt}>✓</Text>
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity style={styles.change} onPress={p.onChangeFolder}>
          <Text style={styles.changeTxt}>Change</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.label}>WHO IS SPEAKING</Text>
      {speakers.length === 0 ? <Text style={styles.empty}>No transcript yet.</Text> : null}
      {speakers.map((s) => (
        <View key={s.L}>
          <View style={styles.row}>
            {p.audioSource ? (
              <TouchableOpacity style={styles.play} onPress={() => play(s.L, s.clip)}>
                <Text style={styles.playTxt}>{playing === s.L ? "■" : "▶"}</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity style={{ flex: 1 }} disabled={!p.editable} onPress={() => setEditing(editing === s.L ? null : s.L)}>
              <Text style={[styles.name, s.by !== "user" && styles.inferred]} numberOfLines={1}>
                {s.name} <Text style={styles.src}>· {s.by ? SOURCE_WORD[s.by] : "unknown"} · {Math.round(s.secs / 60) || "<1"} min</Text>
              </Text>
            </TouchableOpacity>
            {p.editable && s.by !== "user" && !/^Speaker /.test(s.name) ? (
              <TouchableOpacity style={styles.ok} onPress={() => p.onSetName(s.L, s.name)}>
                <Text style={styles.okTxt}>✓</Text>
              </TouchableOpacity>
            ) : s.by === "user" ? <Text style={styles.done}>✓</Text> : null}
          </View>
          {editing === s.L ? (
            <View style={styles.chips}>
              {p.options.map((o) => (
                <TouchableOpacity key={o} style={styles.chip} onPress={() => { setEditing(null); p.onSetName(s.L, o); }}>
                  <Text style={styles.chipTxt}>{o}</Text>
                </TouchableOpacity>
              ))}
            </View>
          ) : null}
        </View>
      ))}

      {p.editable && speakers.length ? (
        <View style={styles.actions}>
          {unconfirmed.length ? (
            <TouchableOpacity style={styles.primary} onPress={() => p.onConfirmAll(unconfirmed.map((x) => ({ letter: x.L, name: x.name })))}>
              <Text style={styles.primaryTxt}>Confirm all speakers</Text>
            </TouchableOpacity>
          ) : null}
          {rec.meIncluded !== "no" ? (
            <TouchableOpacity style={styles.secondary} onPress={p.onNotMe}>
              <Text style={styles.secondaryTxt}>I'm not in this</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}
      <Text style={styles.hint}>▶ plays a few seconds of that voice. Tap a name to change it.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: "#15181d", borderRadius: 12, borderWidth: 1.5, padding: 12, marginTop: 12 },
  head: { flexDirection: "row", alignItems: "center", gap: 8 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  headTxt: { color: "#e8eaed", fontSize: 14, fontWeight: "700" },
  flag: { color: "#fca5a5", fontSize: 12, marginTop: 6 },
  label: { color: "#7c828a", fontSize: 11, letterSpacing: 1, marginTop: 12, marginBottom: 4 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 },
  play: { width: 34, height: 34, borderRadius: 17, backgroundColor: "#23262d", alignItems: "center", justifyContent: "center" },
  playTxt: { color: "#fff", fontSize: 13 },
  name: { color: "#fff", fontSize: 15, flex: 1 },
  inferred: { color: "#facc15" },
  src: { color: "#7c828a", fontSize: 12 },
  ok: { backgroundColor: "#16331f", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  okTxt: { color: "#4ade80", fontWeight: "700" },
  done: { color: "#4ade80", fontWeight: "700", paddingHorizontal: 12 },
  change: { paddingHorizontal: 8, paddingVertical: 6 },
  changeTxt: { color: "#93c5fd", fontSize: 13 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginLeft: 42, marginBottom: 6 },
  chip: { backgroundColor: "#23262d", borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5 },
  chipTxt: { color: "#e8eaed", fontSize: 13 },
  empty: { color: "#7c828a", fontSize: 13 },
  actions: { flexDirection: "row", gap: 8, marginTop: 10 },
  primary: { flex: 1, backgroundColor: "#2f6fd0", borderRadius: 10, padding: 10, alignItems: "center" },
  primaryTxt: { color: "#fff", fontWeight: "700" },
  secondary: { backgroundColor: "#23262d", borderRadius: 10, padding: 10, alignItems: "center" },
  secondaryTxt: { color: "#e8eaed" },
  hint: { color: "#6b7280", fontSize: 11, marginTop: 8 },
});

import { StyleSheet, Text, View } from "react-native";
import { Utterance } from "../transcription";
import { colorForLetter } from "../colors";

type Props = {
  utterances: Utterance[];
  nameFor: (letter: string) => string;
};

// Estimate an end time when AAI didn't store one (older recordings).
function endOf(u: Utterance, next?: Utterance): number {
  if (typeof u.end === "number") return u.end;
  if (next) return next.start;
  return u.start + 3000; // last utterance fallback: +3s
}

export default function SpeakerTimeline({ utterances, nameFor }: Props) {
  if (!utterances.length) return null;

  const totalEnd = endOf(
    utterances[utterances.length - 1],
    undefined
  );
  const total = Math.max(1, totalEnd - utterances[0].start);
  const t0 = utterances[0].start;

  // Build proportional segments (including silence gaps).
  type Seg = { color: string | null; frac: number };
  const segs: Seg[] = [];
  let cursor = t0;
  utterances.forEach((u, i) => {
    const e = endOf(u, utterances[i + 1]);
    if (u.start > cursor) {
      segs.push({ color: null, frac: (u.start - cursor) / total });
    }
    segs.push({ color: colorForLetter(u.speaker), frac: (e - u.start) / total });
    cursor = Math.max(cursor, e);
  });

  // Talk-time totals per speaker letter.
  const talk: Record<string, number> = {};
  utterances.forEach((u, i) => {
    const e = endOf(u, utterances[i + 1]);
    talk[u.speaker] = (talk[u.speaker] ?? 0) + Math.max(0, e - u.start);
  });
  const spoken = Object.values(talk).reduce((a, b) => a + b, 0) || 1;
  const letters = Object.keys(talk).sort();

  return (
    <View>
      <View style={styles.bar}>
        {segs.map((s, i) => (
          <View
            key={i}
            style={{
              flexGrow: s.frac,
              backgroundColor: s.color ?? "transparent",
            }}
          />
        ))}
      </View>
      <View style={styles.legend}>
        {letters.map((l) => (
          <View key={l} style={styles.legendItem}>
            <View style={[styles.dot, { backgroundColor: colorForLetter(l) }]} />
            <Text style={styles.legendName} numberOfLines={1}>
              {nameFor(l)}
            </Text>
            <Text style={styles.legendPct}>
              {Math.round((talk[l] / spoken) * 100)}%
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    height: 14,
    borderRadius: 7,
    overflow: "hidden",
    backgroundColor: "#1a1d23",
  },
  legend: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 14,
    marginTop: 12,
  },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 12, height: 12, borderRadius: 6 },
  legendName: { color: "#cdd1d6", fontSize: 13, maxWidth: 120 },
  legendPct: { color: "#fff", fontSize: 13, fontWeight: "700" },
});

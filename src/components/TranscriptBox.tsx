import { forwardRef, ReactNode, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { AudioPlayer, useAudioPlayerStatus } from "expo-audio";
import type { Utterance } from "../transcription";

export type TranscriptBoxHandle = { showAt: (ms: number) => void };

/** The turn playing at a time: the last one started by then. */
function turnAt(us: Utterance[], ms: number): number {
  let i = -1;
  for (let k = 0; k < us.length && us[k].start <= ms; k++) i = k;
  return i;
}

/**
 * The transcript in its own scrolling box. The turn at the position in play
 * is highlighted and kept in view, whether the audio is playing or the
 * position line is being dragged across the voice lanes.
 */
export default forwardRef<TranscriptBoxHandle, {
  utterances: Utterance[];
  player: AudioPlayer;
  head: (u: Utterance) => ReactNode;
}>(function TranscriptBox({ utterances, player, head }, ref) {
  const status = useAudioPlayerStatus(player);
  const box = useRef<ScrollView>(null);
  const ys = useRef<number[]>([]);
  const [active, setActive] = useState(-1);

  function show(i: number) {
    if (i < 0 || i === active) return;
    setActive(i);
    box.current?.scrollTo({ y: Math.max(0, (ys.current[i] ?? 0) - 40), animated: true });
  }
  useImperativeHandle(ref, () => ({ showAt: (ms) => show(turnAt(utterances, ms)) }));
  // Any move of the shared position: playing, or a seek from the play bar.
  useEffect(() => { show(turnAt(utterances, status.currentTime * 1000)); }, [status.currentTime]);
  // The rows only change with the active turn, not on every status tick.
  const rows = useMemo(() => utterances.map((u, i) => (
    <View key={i} style={[styles.row, i === active && styles.on]} onLayout={(e) => { ys.current[i] = e.nativeEvent.layout.y; }}>
      {head(u)}
      <Text style={styles.text}>{u.text}</Text>
    </View>
  )), [utterances, active, head]);

  return (
    <ScrollView ref={box} style={styles.box} nestedScrollEnabled>
      {rows}
    </ScrollView>
  );
});

const styles = StyleSheet.create({
  box: { backgroundColor: "#1a1d23", borderRadius: 12, padding: 14, marginTop: 18, maxHeight: 380 },
  row: { marginBottom: 14, borderLeftWidth: 3, borderLeftColor: "transparent", paddingLeft: 8, marginLeft: -11 },
  on: { borderLeftColor: "#fff", backgroundColor: "#22262e" },
  text: { color: "#cdd1d6", fontSize: 14, lineHeight: 21, marginTop: 2 },
});

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { AudioPlayer, useAudioPlayerStatus } from "expo-audio";

function mmss(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

const LEVEL_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";
const BARS = 90;

/** Play/pause + loudness overview + tap/drag scrub bar. The player is the
 *  screen's, shared with the voice lanes and the transcript. */
export default function AudioPlayerBar({ player, levels }: { player: AudioPlayer; levels?: string }) {
  const status = useAudioPlayerStatus(player);
  const [trackW, setTrackW] = useState(1);
  const [scrub, setScrub] = useState<number | null>(null); // fraction while dragging
  const lastSeek = useRef(0);
  // Seeks while dragging too (a few times a second), so the line across the
  // voices and the transcript move with the finger, not only on release.
  function drag(x: number, final = false) {
    const f = fracOf(x);
    setScrub(final ? null : f);
    const now = Date.now();
    if (final || now - lastSeek.current > 150) { lastSeek.current = now; player.seekTo(f * duration); }
  }

  // NOTE: deliberately no setAudioModeAsync here. The audio mode is GLOBAL, and
  // setting it without shouldPlayInBackground reset that flag to false — which
  // made the native recorder pause on screen-off for any recording started after
  // the player had been opened. Playback works fine under the recording mode set
  // by RecordScreen (allowsRecording has no effect on Android playback).

  // The audio mode is global and RecordScreen sets shouldPlayInBackground so
  // the recorder survives screen-off, which leaves playback free to carry on
  // after you have left the app — easy to start and forget. Pausing on the way
  // out gets the behaviour you want without touching the mode, which is what
  // the note above says not to do.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (next !== "active") player.pause();
    });
    return () => sub.remove();
  }, [player]);

  // restart from the top once playback reaches the end
  useEffect(() => {
    if (status.didJustFinish) player.seekTo(0);
  }, [status.didJustFinish]);

  // The cloud's buckets folded to what fits: the loudest of each group, so a
  // short burst of noise still shows.
  const bars = useMemo(() => {
    if (!levels) return null;
    const v = Array.from(levels, (c) => Math.max(0, LEVEL_CHARS.indexOf(c)));
    const raw = Array.from({ length: BARS }, (_, i) => Math.max(...v.slice(Math.floor((i * v.length) / BARS), Math.max(Math.floor((i * v.length) / BARS) + 1, Math.floor(((i + 1) * v.length) / BARS)))));
    // Speech sits in a narrow band of dB: stretch this recording's own range
    // so quiet and loud stretches actually differ.
    const lo = Math.min(...raw), hi = Math.max(...raw);
    return raw.map((x) => (hi > lo ? (x - lo) / (hi - lo) : 0.5));
  }, [levels]);

  const duration = status.duration || 0;
  const position = scrub != null ? scrub * duration : status.currentTime || 0;
  const frac = duration > 0 ? Math.min(1, position / duration) : 0;
  const fracOf = (x: number) => Math.max(0, Math.min(1, x / trackW));

  // One compact row: play, then the loudness bars with the progress drawn
  // over them (played bars in blue, a playhead line), then the times.
  return (
    <View style={styles.bar}>
      <TouchableOpacity
        style={styles.btn}
        onPress={() => (status.playing ? player.pause() : player.play())}
      >
        <Text style={styles.btnTxt}>{status.playing ? "❚❚" : "▶"}</Text>
      </TouchableOpacity>
      <View
        style={styles.scrub}
        onLayout={(e) => setTrackW(e.nativeEvent.layout.width)}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderTerminationRequest={() => false}
        onResponderGrant={(e) => drag(e.nativeEvent.locationX)}
        onResponderMove={(e) => drag(e.nativeEvent.locationX)}
        onResponderRelease={(e) => drag(e.nativeEvent.locationX, true)}
      >
        <View style={styles.wave} pointerEvents="none">
          {bars
            ? bars.map((h, i) => (
                <View key={i} style={[styles.waveBar, { height: `${Math.max(8, h * 100)}%`, backgroundColor: i / BARS < frac ? "#60a5fa" : "#3a404b" }]} />
              ))
            : null}
        </View>
        <View pointerEvents="none" style={styles.baseline} />
        <View pointerEvents="none" style={[styles.played, { width: `${frac * 100}%` }]} />
        <View pointerEvents="none" style={[styles.head, { left: `${frac * 100}%` }]} />
      </View>
      <Text style={styles.time}>
        {mmss(position)}
        <Text style={styles.timeDim}>{"\n"}{mmss(duration)}</Text>
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "#15171c",
    borderRadius: 14,
    paddingVertical: 6,
    paddingHorizontal: 8,
    marginTop: 2,
    marginBottom: 6,
  },
  btn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#3b82f6",
    alignItems: "center",
    justifyContent: "center",
  },
  btnTxt: { color: "#fff", fontSize: 13, fontWeight: "700" },
  scrub: { flex: 1, height: 40, justifyContent: "center" },
  wave: { position: "absolute", left: 0, right: 0, top: 4, bottom: 4, flexDirection: "row", alignItems: "center", gap: 1 },
  waveBar: { flex: 1, borderRadius: 1 },
  baseline: { position: "absolute", left: 0, right: 0, top: 19, height: 2, borderRadius: 1, backgroundColor: "#2a2e36" },
  played: { position: "absolute", left: 0, top: 19, height: 2, borderRadius: 1, backgroundColor: "#3b82f6" },
  head: { position: "absolute", top: 0, bottom: 0, width: 3, marginLeft: -1.5, borderRadius: 2, backgroundColor: "#fff" },
  time: { color: "#e8eaed", fontSize: 12, fontWeight: "600", textAlign: "right", minWidth: 38, fontVariant: ["tabular-nums"] },
  timeDim: { color: "#7c828a", fontWeight: "400" },
});

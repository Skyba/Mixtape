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

  return (
    <View style={styles.bar}>
      <TouchableOpacity
        style={styles.btn}
        onPress={() => (status.playing ? player.pause() : player.play())}
      >
        <Text style={styles.btnTxt}>{status.playing ? "⏸" : "▶"}</Text>
      </TouchableOpacity>
      <View style={styles.right}>
        <View
          onLayout={(e) => setTrackW(e.nativeEvent.layout.width)}
          onStartShouldSetResponder={() => true}
          onMoveShouldSetResponder={() => true}
          onResponderTerminationRequest={() => false}
          onResponderGrant={(e) => drag(e.nativeEvent.locationX)}
          onResponderMove={(e) => drag(e.nativeEvent.locationX)}
          onResponderRelease={(e) => drag(e.nativeEvent.locationX, true)}
        >
          {bars ? (
            <View style={styles.wave} pointerEvents="none">
              {bars.map((h, i) => (
                <View key={i} style={[styles.waveBar, { height: `${Math.max(4, h * 100)}%`, backgroundColor: i / BARS < frac ? "#3b82f6" : "#4b5563" }]} />
              ))}
            </View>
          ) : null}
          <View style={styles.track} pointerEvents="none">
            <View style={styles.trackLine} />
            <View style={[styles.fill, { width: `${frac * 100}%` }]} />
            <View style={[styles.knob, { left: `${frac * 100}%` }]} />
          </View>
        </View>
        <View style={styles.times}>
          <Text style={styles.time}>{mmss(position)}</Text>
          <Text style={styles.time}>{mmss(duration)}</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "#15171c",
    borderRadius: 12,
    padding: 12,
    marginTop: 4,
    marginBottom: 8,
  },
  btn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#3b82f6",
    alignItems: "center",
    justifyContent: "center",
  },
  btnTxt: { color: "#fff", fontSize: 18 },
  right: { flex: 1 },
  wave: { height: 36, flexDirection: "row", alignItems: "center", gap: 1 },
  waveBar: { flex: 1, borderRadius: 1 },
  track: {
    height: 30,
    justifyContent: "center",
  },
  trackLine: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 12,
    height: 6,
    borderRadius: 3,
    backgroundColor: "#2a2e36",
  },
  fill: {
    position: "absolute",
    left: 0,
    top: 12,
    height: 6,
    borderRadius: 3,
    backgroundColor: "#3b82f6",
  },
  knob: {
    position: "absolute",
    width: 24,
    height: 24,
    borderRadius: 12,
    marginLeft: -12,
    top: 3,
    backgroundColor: "#fff",
  },
  times: { flexDirection: "row", justifyContent: "space-between", marginTop: 2 },
  time: { color: "#9aa0a6", fontSize: 12 },
});

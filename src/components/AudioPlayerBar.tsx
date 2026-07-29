import { useEffect, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";

function mmss(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Minimal audio player: play/pause + tap/drag scrub bar + time labels. */
export default function AudioPlayerBar({ uri }: { uri: string }) {
  const player = useAudioPlayer(uri, { updateInterval: 250 });
  const status = useAudioPlayerStatus(player);
  const [trackW, setTrackW] = useState(1);
  const [scrub, setScrub] = useState<number | null>(null); // fraction while dragging

  // NOTE: deliberately no setAudioModeAsync here. The audio mode is GLOBAL, and
  // setting it without shouldPlayInBackground reset that flag to false — which
  // made the native recorder pause on screen-off for any recording started after
  // the player had been opened. Playback works fine under the recording mode set
  // by RecordScreen (allowsRecording has no effect on Android playback).

  // restart from the top once playback reaches the end
  useEffect(() => {
    if (status.didJustFinish) player.seekTo(0);
  }, [status.didJustFinish]);

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
          style={styles.track}
          onLayout={(e) => setTrackW(e.nativeEvent.layout.width)}
          onStartShouldSetResponder={() => true}
          onMoveShouldSetResponder={() => true}
          onResponderGrant={(e) => setScrub(fracOf(e.nativeEvent.locationX))}
          onResponderMove={(e) => setScrub(fracOf(e.nativeEvent.locationX))}
          onResponderRelease={(e) => {
            player.seekTo(fracOf(e.nativeEvent.locationX) * duration);
            setScrub(null);
          }}
        >
          <View style={styles.trackLine} />
          <View style={[styles.fill, { width: `${frac * 100}%` }]} />
          <View style={[styles.knob, { left: `${frac * 100}%` }]} />
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
  track: {
    height: 22,
    justifyContent: "center",
  },
  trackLine: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 8,
    height: 5,
    borderRadius: 3,
    backgroundColor: "#2a2e36",
  },
  fill: {
    position: "absolute",
    left: 0,
    top: 8,
    height: 5,
    borderRadius: 3,
    backgroundColor: "#3b82f6",
  },
  knob: {
    position: "absolute",
    width: 14,
    height: 14,
    borderRadius: 7,
    marginLeft: -7,
    top: 4,
    backgroundColor: "#fff",
  },
  times: { flexDirection: "row", justifyContent: "space-between", marginTop: 2 },
  time: { color: "#9aa0a6", fontSize: 12 },
});

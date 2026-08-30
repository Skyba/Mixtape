import { useEffect, useRef, useState } from "react";
import {
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
} from "expo-audio";
import { isFirebaseConfigured, isSignedIn, uploadToPath } from "../firebase";
import { getSettings, saveSettings } from "../storage";
import { logEvent } from "../log";

const TARGET_SECONDS = 60;
const HARD_CAP_SECONDS = 120;

/** Where the enrolled sample lives. Outside recordings/<folder>/, so it never
 *  shows up in the library and never triggers a transcription. */
export const VOICEPRINT_PATH = "_voiceprint/enroll.m4a";

const SCRIPT = [
  "Read this out loud at a normal speaking distance, the way you'd talk in a meeting — not into the mic.",
  "“I'm recording this so the app can learn my voice. I talk about my work, my projects, the people I'm building with, and what I want to do next. Some days that's software, some days it's fundraising, some days it's just thinking out loud.”",
  "Puis continue en français, quelques phrases, pour couvrir les deux langues : « Je parle souvent en français aussi, avec ma famille et mes associés. C'est utile que l'application reconnaisse ma voix dans les deux langues. »",
  "Then keep talking about anything at all until the timer passes 60 seconds — what you did today works fine. Natural speech matters more than the words.",
];

export default function VoiceEnrollScreen() {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [busy, setBusy] = useState("");
  const [enrolledAt, setEnrolledAt] = useState<string>("");
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    getSettings().then((s) => setEnrolledAt(s.voiceEnrolledAt));
    return () => {
      if (tick.current) clearInterval(tick.current);
    };
  }, []);

  async function start() {
    const perm = await AudioModule.requestRecordingPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Microphone permission denied");
      return;
    }
    try {
      await setAudioModeAsync({
        playsInSilentMode: true,
        allowsRecording: true,
        allowsBackgroundRecording: true,
        shouldPlayInBackground: true,
      });
      await recorder.prepareToRecordAsync();
      recorder.record({ forDuration: HARD_CAP_SECONDS });
      setElapsed(0);
      setRecording(true);
      tick.current = setInterval(() => {
        setElapsed((e) => {
          if (e + 1 >= HARD_CAP_SECONDS) stop();
          return e + 1;
        });
      }, 1000);
    } catch (e: any) {
      Alert.alert("Could not start", String(e?.message ?? e));
    }
  }

  async function stop() {
    if (tick.current) {
      clearInterval(tick.current);
      tick.current = null;
    }
    setRecording(false);
    try {
      await recorder.stop();
    } catch {}
    const uri = recorder.uri;
    if (!uri) {
      Alert.alert("No audio captured");
      return;
    }
    if (!isFirebaseConfigured || !isSignedIn()) {
      Alert.alert("Sign in first", "The sample is stored in your own cloud.");
      return;
    }
    setBusy("Uploading…");
    try {
      await uploadToPath(uri, VOICEPRINT_PATH);
      const when = new Date().toISOString();
      const s = await getSettings();
      await saveSettings({ ...s, voiceEnrolledAt: when });
      setEnrolledAt(when);
      logEvent(`voiceprint enrolled ${elapsed}s`);
      setBusy("");
      Alert.alert(
        "Voice sample saved",
        `${elapsed}s stored. It stays in your own storage and isn't added to your library.`
      );
    } catch (e: any) {
      setBusy("");
      Alert.alert("Upload failed", String(e?.message ?? e));
    }
  }

  const short = elapsed > 0 && elapsed < 25;

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 40 }}>
      <Text style={styles.title}>Your voice</Text>
      <Text style={styles.intro}>
        One clean sample of you speaking, so a recording can be matched against
        it instead of guessed at from what's said. Aim for {TARGET_SECONDS}{" "}
        seconds — more is better than less.
      </Text>

      {enrolledAt ? (
        <Text style={styles.enrolled}>
          ✓ Enrolled {new Date(enrolledAt).toLocaleDateString()} — recording
          again replaces it.
        </Text>
      ) : null}

      {SCRIPT.map((line, i) => (
        <Text key={i} style={i === 1 || i === 2 ? styles.quote : styles.step}>
          {line}
        </Text>
      ))}

      <Text style={[styles.timer, elapsed >= TARGET_SECONDS && styles.timerOk]}>
        {String(Math.floor(elapsed / 60)).padStart(2, "0")}:
        {String(elapsed % 60).padStart(2, "0")}
        {elapsed >= TARGET_SECONDS ? "  ✓ enough" : ""}
      </Text>

      <TouchableOpacity
        style={[styles.btn, recording && styles.btnOn]}
        onPress={recording ? stop : start}
        disabled={!!busy}
      >
        <Text style={styles.btnTxt}>
          {busy || (recording ? "Stop & save" : enrolledAt ? "Record again" : "Start")}
        </Text>
      </TouchableOpacity>

      {short && !recording ? (
        <Text style={styles.warn}>
          That was short — under about 25 seconds the match gets unreliable.
        </Text>
      ) : null}

      <Text style={styles.hint}>
        Quiet room, no other voices. The sample never leaves your own storage,
        and it isn't transcribed.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { backgroundColor: "#0f1115", flex: 1, padding: 20, paddingTop: 50 },
  title: { color: "#fff", fontSize: 22, fontWeight: "700" },
  intro: { color: "#9aa0a6", fontSize: 13, marginTop: 8, lineHeight: 19 },
  enrolled: { color: "#4ade80", fontSize: 13, marginTop: 14 },
  step: { color: "#c9cdd3", fontSize: 13, marginTop: 14, lineHeight: 19 },
  quote: {
    color: "#e8eaed",
    fontSize: 14,
    marginTop: 12,
    lineHeight: 21,
    backgroundColor: "#15181d",
    borderRadius: 10,
    padding: 12,
  },
  timer: {
    color: "#9aa0a6",
    fontSize: 34,
    fontWeight: "700",
    textAlign: "center",
    marginTop: 22,
  },
  timerOk: { color: "#4ade80" },
  btn: {
    backgroundColor: "#2f6fd0",
    borderRadius: 12,
    padding: 16,
    alignItems: "center",
    marginTop: 16,
  },
  btnOn: { backgroundColor: "#b3261e" },
  btnTxt: { color: "#fff", fontSize: 16, fontWeight: "700" },
  warn: { color: "#fbbf24", fontSize: 12, marginTop: 12, lineHeight: 17 },
  hint: { color: "#7c828a", fontSize: 12, marginTop: 16, lineHeight: 17 },
});

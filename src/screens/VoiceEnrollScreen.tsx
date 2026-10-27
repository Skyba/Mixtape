import { useEffect, useRef, useState } from "react";
import {
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
} from "expo-audio";
import { isFirebaseConfigured, isSignedIn, uploadToPath,
  userPath,
} from "../firebase";
import { getSettings, saveSettings } from "../storage";
import { logEvent } from "../log";

const TARGET_SECONDS = 60;
const HARD_CAP_SECONDS = 120;

/** Where the enrolled sample lives. Outside recordings/<folder>/, so it never
 *  shows up in the library and never triggers a transcription. */
// Relative to the user's own prefix. The old bucket-root path never matched
// storage.rules (recordings/{uid}/**), so enrollment 403'd on every attempt
// and no voiceprint was ever uploaded.
export const VOICEPRINT_PATH = "_voiceprint/enroll.m4a";
/** Someone else's sample: _voiceprint/people/<name>.m4a. The Mac matcher
 *  reads the name back from the file name, so the name is the key. */
export const personVoicePath = (name: string) =>
  `_voiceprint/people/${encodeURIComponent(name.trim())}.m4a`;

const SCRIPT = [
  "Read this out loud at a normal speaking distance, the way you'd talk in a meeting — not into the mic.",
  "“I'm recording this so the app can learn my voice. I talk about my work, my projects, the people I'm building with, and what I want to do next. Some days that's software, some days it's fundraising, some days it's just thinking out loud.”",
  "Puis continue en français, quelques phrases, pour couvrir les deux langues : « Je parle souvent en français aussi, avec ma famille et mes associés. C'est utile que l'application reconnaisse ma voix dans les deux langues. »",
  "Then keep talking about anything at all until the timer passes 60 seconds — what you did today works fine. Natural speech matters more than the words.",
];

export default function VoiceEnrollScreen() {
  const recorder = useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY, numberOfChannels: 1 });
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [busy, setBusy] = useState("");
  const [enrolledAt, setEnrolledAt] = useState<string>("");
  // Whose voice this take is: the owner's (default), or someone else's, by
  // name — the person sits next to the phone and reads the script.
  const [whose, setWhose] = useState<"me" | "other">("me");
  const [otherName, setOtherName] = useState("");
  const [savedOthers, setSavedOthers] = useState<string[]>([]);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    getSettings().then((s) => setEnrolledAt(s.voiceEnrolledAt));
    return () => {
      if (tick.current) clearInterval(tick.current);
    };
  }, []);

  async function start() {
    if (whose === "other" && !otherName.trim()) {
      Alert.alert("Whose voice?", "Type the person's name first — the same spelling you use for them as a speaker.");
      return;
    }
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
      if (whose === "other") {
        const name = otherName.trim();
        await uploadToPath(uri, userPath(personVoicePath(name)));
        setSavedOthers((x) => Array.from(new Set([...x, name])));
        logEvent(`voiceprint enrolled for ${name} ${elapsed}s`);
        setBusy("");
        Alert.alert("Voice sample saved", `${name}: ${elapsed}s stored. Recording again for the same name replaces it.`);
        return;
      }
      await uploadToPath(uri, userPath(VOICEPRINT_PATH));
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

      <View style={styles.whoRow}>
        {(["me", "other"] as const).map((w) => (
          <TouchableOpacity key={w} style={[styles.who, whose === w && styles.whoOn]} onPress={() => setWhose(w)} disabled={recording}>
            <Text style={styles.whoTxt}>{w === "me" ? "My voice" : "Someone else"}</Text>
          </TouchableOpacity>
        ))}
      </View>
      {whose === "other" ? (
        <>
          <TextInput
            style={styles.input}
            placeholder="Their name, as you label them (e.g. Erica)"
            placeholderTextColor="#6b7280"
            value={otherName}
            onChangeText={setOtherName}
            editable={!recording}
            autoCapitalize="words"
          />
          <Text style={styles.step}>Hand them the phone: they read the script below in their own voice.</Text>
          {savedOthers.length ? <Text style={styles.enrolled}>✓ Saved this session: {savedOthers.join(", ")}</Text> : null}
        </>
      ) : null}

      {whose === "me" && enrolledAt ? (
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
          {busy || (recording ? "Stop & save" : whose === "me" && enrolledAt ? "Record again" : "Start")}
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
  whoRow: { flexDirection: "row", gap: 8, marginTop: 16 },
  who: { flex: 1, borderRadius: 10, padding: 10, alignItems: "center", backgroundColor: "#15181d" },
  whoOn: { backgroundColor: "#2f6fd0" },
  whoTxt: { color: "#fff", fontWeight: "600" },
  input: { color: "#fff", backgroundColor: "#15181d", borderRadius: 10, padding: 12, marginTop: 10 },
});

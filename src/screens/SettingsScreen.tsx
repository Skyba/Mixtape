import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import * as Updates from "expo-updates";
import { Ionicons } from "@expo/vector-icons";
import Select from "../components/Select";
import { APP_VERSION } from "../version";

const MODEL_OPTIONS = [
  { label: "Haiku 4.5 — cheapest", value: "claude-haiku-4-5-20251001" },
  { label: "Sonnet 4.6 — balanced", value: "claude-sonnet-4-6" },
  { label: "Opus 4.8 — best", value: "claude-opus-4-8" },
];
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { getSettings, saveSettings } from "../storage";
import {
  isFirebaseConfigured,
  subscribeAuth,
  signOutFirebase,
} from "../firebase";
import { uploadDebugLog } from "../firebase";
import { exportLog, getLogText } from "../log";
import { DEFAULT_SETTINGS, Settings } from "../types";
import type { RootStackParamList } from "../../App";

type Nav = NativeStackNavigationProp<RootStackParamList>;

function maskKey(v: string): string {
  if (!v) return "";
  if (v.length <= 6) return "••••••";
  return `${v.slice(0, 3)}••••••${v.slice(-3)}`;
}

/**
 * Stores an API key but never reveals or allows copying it. Once set, only the
 * first/last 3 chars show. "Replace" opens a blank secure input to set a new one.
 */
function MaskedKeyField({
  value,
  onChangeText,
  placeholder,
}: {
  value: string;
  onChangeText: (v: string) => void;
  placeholder: string;
}) {
  const [replacing, setReplacing] = useState(false);
  const [draft, setDraft] = useState("");
  const [revealed, setRevealed] = useState(false);

  if (value && !replacing) {
    return (
      <View style={styles.secretRow}>
        <View style={styles.maskedBox}>
          <Text style={styles.maskedTxt}>
            {revealed ? maskKey(value) : "•••••••••  set"}
          </Text>
        </View>
        <TouchableOpacity
          style={styles.eye}
          onPress={() => setRevealed((v) => !v)}
        >
          <Ionicons
            name={revealed ? "eye-off" : "eye"}
            size={18}
            color="#9aa0a6"
          />
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.replaceBtn}
          onPress={() => {
            setDraft("");
            setReplacing(true);
            setRevealed(false);
          }}
        >
          <Text style={styles.replaceTxt}>Replace</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.secretRow}>
      <TextInput
        style={styles.secretInput}
        value={draft}
        onChangeText={setDraft}
        placeholder={placeholder}
        placeholderTextColor="#6b7280"
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        autoFocus={replacing}
      />
      <TouchableOpacity
        style={styles.replaceBtn}
        onPress={() => {
          onChangeText(draft.trim());
          setReplacing(false);
        }}
      >
        <Text style={styles.replaceTxt}>Set</Text>
      </TouchableOpacity>
      {value ? (
        <TouchableOpacity
          style={styles.eye}
          onPress={() => {
            setReplacing(false);
            setDraft("");
          }}
        >
          <Ionicons name="close" size={18} color="#9aa0a6" />
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

export default function SettingsScreen() {
  const navigation = useNavigation<Nav>();
  const [s, setS] = useState<Settings>(DEFAULT_SETTINGS);
  const [saved, setSaved] = useState(false);
  const [authEmail, setAuthEmail] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);

  useEffect(() => {
    getSettings().then(setS);
    return subscribeAuth(setAuthEmail);
  }, []);

  async function save() {
    await saveSettings(s);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  async function doSignOut() {
    setAuthBusy(true);
    try {
      await signOutFirebase();
    } catch {}
    setAuthBusy(false);
  }

  const [updating, setUpdating] = useState(false);
  async function checkForUpdate() {
    if (!Updates.isEnabled) {
      Alert.alert("Updates unavailable", "Only works in an installed build.");
      return;
    }
    setUpdating(true);
    try {
      const res = await Updates.checkForUpdateAsync();
      if (res.isAvailable) {
        await Updates.fetchUpdateAsync();
        await Updates.reloadAsync(); // restarts into the new version
      } else {
        Alert.alert("Up to date", "You're on the latest version.");
      }
    } catch (e: any) {
      Alert.alert("Update failed", String(e?.message ?? e));
    }
    setUpdating(false);
  }

  return (
    <ScrollView style={styles.container}>
      <Text style={styles.title}>Settings</Text>

      <Text style={styles.label}>AssemblyAI API key</Text>
      <MaskedKeyField
        value={s.assemblyAiKey}
        onChangeText={(v) => setS({ ...s, assemblyAiKey: v })}
        placeholder="paste key"
      />

      <Text style={styles.label}>Anthropic API key (topic + summaries)</Text>
      <MaskedKeyField
        value={s.anthropicKey}
        onChangeText={(v) => setS({ ...s, anthropicKey: v })}
        placeholder="paste key"
      />

      <Text style={styles.label}>Topic / summary model</Text>
      <Select
        value={
          MODEL_OPTIONS.some((o) => o.value === s.topicModel)
            ? s.topicModel
            : MODEL_OPTIONS[0].value
        }
        options={MODEL_OPTIONS}
        onChange={(v) => setS({ ...s, topicModel: v })}
      />

      <View style={styles.switchRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.switchLabel}>Upload on cellular</Text>
          <Text style={styles.hint}>
            Off = upload only on Wi-Fi (recommended)
          </Text>
        </View>
        <Switch
          value={s.uploadOnCellular}
          onValueChange={(v) => setS({ ...s, uploadOnCellular: v })}
        />
      </View>

      <TouchableOpacity style={styles.save} onPress={save}>
        <Text style={styles.saveTxt}>{saved ? "Saved ✓" : "Save"}</Text>
      </TouchableOpacity>

      <Text style={styles.label}>Cloud account</Text>
      {!isFirebaseConfigured ? (
        <Text style={styles.hint}>
          Firebase not configured — app works local-only.
        </Text>
      ) : authEmail ? (
        <View style={styles.authCard}>
          <View style={styles.authRow}>
            <Ionicons name="cloud-done" size={22} color="#4ade80" />
            <View style={{ flex: 1 }}>
              <Text style={styles.authOk}>Signed in</Text>
              <Text style={styles.authEmail}>{authEmail}</Text>
            </View>
          </View>
          <TouchableOpacity
            style={styles.signOut}
            onPress={doSignOut}
            disabled={authBusy}
          >
            <Text style={styles.saveTxt}>
              {authBusy ? "…" : "Sign out"}
            </Text>
          </TouchableOpacity>
        </View>
      ) : (
        <TouchableOpacity
          style={styles.signInBtn}
          onPress={() => navigation.navigate("Login")}
        >
          <Ionicons name="log-in-outline" size={20} color="#fff" />
          <Text style={styles.saveTxt}>Sign in to enable cloud</Text>
        </TouchableOpacity>
      )}

      <Text style={styles.label}>Developer</Text>
      {authEmail ? (
        <TouchableOpacity
          style={styles.updateBtn}
          onPress={() => navigation.navigate("ApiKeys")}
        >
          <Ionicons name="key-outline" size={20} color="#fff" />
          <Text style={styles.saveTxt}>API access & keys</Text>
        </TouchableOpacity>
      ) : null}
      <View style={styles.devRow}>
        <TouchableOpacity
          style={[styles.updateBtn, { flex: 1, marginTop: 10 }]}
          onPress={() => exportLog()}
        >
          <Ionicons name="document-text-outline" size={18} color="#fff" />
          <Text style={styles.saveTxt}>Export logs</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.updateBtn, { flex: 1, marginTop: 10 }]}
          onPress={async () => {
            try {
              await uploadDebugLog(await getLogText());
              Alert.alert("Logs uploaded");
            } catch (e: any) {
              Alert.alert("Upload failed", String(e?.message ?? e));
            }
          }}
        >
          <Ionicons name="cloud-upload-outline" size={18} color="#fff" />
          <Text style={styles.saveTxt}>Send logs</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.label}>App</Text>
      <TouchableOpacity
        style={styles.updateBtn}
        onPress={checkForUpdate}
        disabled={updating}
      >
        {updating ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <>
            <Ionicons name="cloud-download-outline" size={20} color="#fff" />
            <Text style={styles.saveTxt}>Check for updates</Text>
          </>
        )}
      </TouchableOpacity>
      <Text style={styles.hint}>
        Pulls the latest version over-the-air and restarts.
      </Text>

      <Text style={styles.version}>
        Mixtape v{APP_VERSION}
        {"\n"}
        {Updates.isEmbeddedLaunch
          ? "build base"
          : `update ${(Updates.updateId ?? "").slice(0, 8)}${
              Updates.createdAt
                ? " · " + new Date(Updates.createdAt).toLocaleDateString()
                : ""
            }`}
      </Text>
      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { backgroundColor: "#0f1115", flex: 1, padding: 20, paddingTop: 60 },
  title: { color: "#fff", fontSize: 26, fontWeight: "700", marginBottom: 10 },
  label: {
    color: "#9aa0a6",
    fontSize: 13,
    marginTop: 18,
    marginBottom: 6,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  input: {
    backgroundColor: "#1a1d23",
    color: "#fff",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  secretRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  secretInput: {
    flex: 1,
    backgroundColor: "#1a1d23",
    color: "#fff",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  eye: {
    backgroundColor: "#1a1d23",
    borderRadius: 10,
    padding: 12,
  },
  maskedBox: {
    flex: 1,
    backgroundColor: "#1a1d23",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  maskedTxt: { color: "#cdd1d6", fontSize: 15, letterSpacing: 1 },
  replaceBtn: {
    backgroundColor: "#23262d",
    borderRadius: 10,
    paddingHorizontal: 16,
    justifyContent: "center",
    alignSelf: "stretch",
  },
  replaceTxt: { color: "#fff", fontWeight: "600" },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 24,
    gap: 12,
  },
  switchLabel: { color: "#fff", fontSize: 15 },
  hint: { color: "#6b7280", fontSize: 12, marginTop: 8 },
  version: {
    color: "#4b5159",
    fontSize: 12,
    textAlign: "center",
    marginTop: 28,
    lineHeight: 18,
  },
  save: {
    backgroundColor: "#3b82f6",
    padding: 16,
    borderRadius: 12,
    alignItems: "center",
    marginTop: 28,
  },
  saveTxt: { color: "#fff", fontWeight: "700", fontSize: 16 },
  authCard: {
    backgroundColor: "#1a1d23",
    borderRadius: 12,
    padding: 16,
    marginTop: 10,
  },
  authRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  authOk: { color: "#4ade80", fontWeight: "700", fontSize: 13 },
  authEmail: { color: "#fff", fontSize: 15, marginTop: 2 },
  signOut: {
    backgroundColor: "#7f1d1d",
    padding: 12,
    borderRadius: 10,
    alignItems: "center",
    marginTop: 14,
  },
  signInBtn: {
    backgroundColor: "#3b82f6",
    padding: 14,
    borderRadius: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    marginTop: 10,
  },
  updateBtn: {
    backgroundColor: "#23262d",
    padding: 14,
    borderRadius: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    marginTop: 10,
  },
  devRow: { flexDirection: "row", gap: 10 },
});

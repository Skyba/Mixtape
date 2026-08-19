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
import {
  listOrphanAudio,
  importOrphanAudio,
  clearAllCacheAudio,
  CacheAudio,
} from "../recover";
import { isRecordingInProgress } from "../recordingFlow";
import { FOLDERS, INBOX, iconFor } from "../placement";
import { getFolderIcons, setFolderIcon } from "../storage";
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

  const [orphans, setOrphans] = useState<CacheAudio[]>([]);
  const [cacheBusy, setCacheBusy] = useState("");
  const [cacheOpen, setCacheOpen] = useState(false);
  const [icons, setIcons] = useState<Record<string, string>>({});
  const [iconsOpen, setIconsOpen] = useState(false);

  useEffect(() => {
    getSettings().then(setS);
    getFolderIcons().then(setIcons);
    return subscribeAuth(setAuthEmail);
  }, []);

  async function changeIcon(folder: string, icon: string) {
    setIcons((cur) => ({ ...cur, [folder]: icon }));
    await setFolderIcon(folder, icon);
  }

  // Scanning the cache tree costs a stat per file, so it only runs when the
  // section is actually opened.
  function toggleCache() {
    const next = !cacheOpen;
    setCacheOpen(next);
    if (next) refreshOrphans();
  }

  async function refreshOrphans() {
    // Never list the take that's being recorded right now — it lives in the
    // same cache directory and is very much still wanted.
    if (isRecordingInProgress()) return setOrphans([]);
    try {
      setOrphans(await listOrphanAudio());
    } catch {
      setOrphans([]);
    }
  }

  async function importOrphan(o: CacheAudio) {
    setCacheBusy("Importing…");
    try {
      const rec = await importOrphanAudio(o, s);
      await refreshOrphans();
      setCacheBusy("");
      Alert.alert(
        "Recovered",
        `Saved as "${rec.base}".\n\nOpen it in the library to set the speakers, then transcribe.`
      );
    } catch (e: any) {
      setCacheBusy("");
      Alert.alert("Import failed", String(e?.message ?? e));
    }
  }

  function clearCachedAudio() {
    const mb = orphans.reduce((n, o) => n + o.size, 0) / 1048576;
    Alert.alert(
      "Delete cached audio?",
      `Frees the ${mb.toFixed(1)} MB listed here plus the recorder's working copies. Any recording you haven't imported is gone for good.`,
      [
        { text: "Keep", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            setCacheBusy("Deleting…");
            const freed = await clearAllCacheAudio();
            await refreshOrphans();
            setCacheBusy("");
            Alert.alert("Cleared", `${(freed / 1048576).toFixed(1)} MB freed.`);
          },
        },
      ]
    );
  }

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

      <TouchableOpacity
        style={[styles.updateBtn, { marginTop: 10 }]}
        onPress={() => setIconsOpen((v) => !v)}
      >
        <Ionicons
          name={iconsOpen ? "chevron-down" : "chevron-forward"}
          size={18}
          color="#fff"
        />
        <Text style={styles.saveTxt}>Folder icons</Text>
      </TouchableOpacity>

      {iconsOpen ? (
        <>
          <Text style={styles.hint}>
            Shown on the Record screen and in the library. Any emoji; clear it
            to go back to the default.
          </Text>
          {[INBOX, ...FOLDERS.map((f) => f.name)].map((f) => (
            <View key={f} style={styles.iconRow}>
              <TextInput
                style={styles.iconInput}
                value={icons[f] ?? ""}
                onChangeText={(v) => changeIcon(f, v)}
                placeholder={iconFor(f, {})}
                placeholderTextColor="#4b5563"
                maxLength={4}
              />
              <Text style={styles.iconName}>{f}</Text>
            </View>
          ))}
        </>
      ) : null}

      <TouchableOpacity
        style={[styles.updateBtn, { marginTop: 10 }]}
        onPress={toggleCache}
      >
        <Ionicons
          name={cacheOpen ? "chevron-down" : "chevron-forward"}
          size={18}
          color="#fff"
        />
        <Text style={styles.saveTxt}>Unsaved audio in cache</Text>
      </TouchableOpacity>

      {cacheOpen ? (
        <>
          <Text style={styles.hint}>
            Recordings that were discarded or never saved. Android clears this
            cache on its own when storage runs low.
          </Text>

          {orphans.map((o) => (
            <TouchableOpacity
              key={o.uri}
              style={styles.cacheRow}
              onPress={() => importOrphan(o)}
              disabled={!!cacheBusy}
            >
              <Text style={styles.cacheTxt}>
                {o.modTime
                  ? new Date(o.modTime).toLocaleString()
                  : "unknown time"}
                {" · "}
                {(o.size / 1048576).toFixed(1)} MB
                {o.segments ? ` · ${o.segments.length} chunks` : ""}
                {o.damaged ? " · interrupted" : ""}
              </Text>
              <Text style={styles.cacheAction}>Import →</Text>
            </TouchableOpacity>
          ))}

          {orphans.length ? (
            <TouchableOpacity
              style={[styles.updateBtn, { marginTop: 10 }]}
              onPress={clearCachedAudio}
              disabled={!!cacheBusy}
            >
              <Ionicons name="trash-outline" size={18} color="#f28b82" />
              <Text style={[styles.saveTxt, { color: "#f28b82" }]}>
                Clear cached audio (
                {(orphans.reduce((n, o) => n + o.size, 0) / 1048576).toFixed(1)}{" "}
                MB)
              </Text>
            </TouchableOpacity>
          ) : (
            <Text style={styles.hint}>
              {cacheBusy ? "" : "Nothing unsaved — everything is in your library."}
            </Text>
          )}
          {cacheBusy ? <Text style={styles.hint}>{cacheBusy}</Text> : null}
        </>
      ) : null}

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
  iconRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 8 },
  iconInput: {
    width: 56,
    textAlign: "center",
    backgroundColor: "#1a1d23",
    borderRadius: 8,
    color: "#fff",
    paddingVertical: 7,
    fontSize: 18,
  },
  iconName: { color: "#c9cdd3", fontSize: 13 },
  cacheRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: "#23262d",
    borderRadius: 10,
    padding: 12,
    marginTop: 8,
  },
  cacheTxt: { color: "#e8eaed", fontSize: 13, flex: 1 },
  cacheAction: { color: "#8ab4f8", fontSize: 13, fontWeight: "700" },
});

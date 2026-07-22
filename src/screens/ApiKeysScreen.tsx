import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import {
  ApiKeyInfo,
  createApiKey,
  listApiKeys,
  revokeApiKey,
  isSignedIn,
} from "../firebase";
import { firebaseConfig } from "../../firebaseConfig";

const SCOPES = [
  { key: "read:meta", label: "Metadata" },
  { key: "read:transcripts", label: "Transcripts" },
  { key: "read:json", label: "Raw JSON" },
  { key: "read:audio", label: "Audio" },
];
const API_BASE = `https://${firebaseConfig.projectId}.web.app/api/v1`;

export default function ApiKeysScreen() {
  const [keys, setKeys] = useState<ApiKeyInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      setKeys(await listApiKeys());
    } catch {
      setKeys([]);
    }
    setLoading(false);
  }
  useEffect(() => {
    load();
  }, []);

  async function generate() {
    if (!isSignedIn()) {
      Alert.alert("Sign in first", "Cloud sign-in is required.");
      return;
    }
    setBusy(true);
    try {
      const { key } = await createApiKey(
        "Key " + new Date().toISOString().slice(0, 10),
        SCOPES.map((s) => s.key)
      );
      setNewKey(key);
      await load();
    } catch (e: any) {
      Alert.alert("Couldn't create key", String(e?.message ?? e));
    }
    setBusy(false);
  }

  function confirmRevoke(k: ApiKeyInfo) {
    Alert.alert("Revoke this key?", `${k.label} (${k.prefix}…)`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Revoke",
        style: "destructive",
        onPress: async () => {
          await revokeApiKey(k.id);
          load();
        },
      },
    ]);
  }

  return (
    <ScrollView style={styles.container}>
      <Text style={styles.title}>API access</Text>
      <Text style={styles.intro}>
        Generate a key to read your recordings from a script or agent. The key
        is shown once — store it safely.
      </Text>

      {newKey ? (
        <View style={styles.newKeyCard}>
          <Text style={styles.newKeyLabel}>New key (copy now — shown once)</Text>
          <Text style={styles.newKeyValue} selectable>
            {newKey}
          </Text>
          <View style={styles.row}>
            <TouchableOpacity
              style={styles.copyBtn}
              onPress={async () => {
                await Clipboard.setStringAsync(newKey);
                Alert.alert("Copied");
              }}
            >
              <Text style={styles.btnTxt}>Copy key</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.copyBtn, styles.dim]}
              onPress={() => setNewKey(null)}
            >
              <Text style={styles.btnTxt}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        <TouchableOpacity
          style={styles.generate}
          onPress={generate}
          disabled={busy}
        >
          {busy ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.btnTxt}>Generate new key</Text>
          )}
        </TouchableOpacity>
      )}

      <Text style={styles.section}>Your keys</Text>
      {loading ? (
        <ActivityIndicator color="#fff" style={{ marginTop: 20 }} />
      ) : keys.length === 0 ? (
        <Text style={styles.hint}>No keys yet.</Text>
      ) : (
        keys.map((k) => (
          <View key={k.id} style={styles.keyRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.keyLabel}>{k.label}</Text>
              <Text style={styles.keyMeta}>
                {k.prefix}… · {k.scopes.length} scopes
              </Text>
              <Text style={styles.keyMeta}>
                last used: {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : "never"}
              </Text>
            </View>
            <TouchableOpacity onPress={() => confirmRevoke(k)}>
              <Text style={styles.revoke}>Revoke</Text>
            </TouchableOpacity>
          </View>
        ))
      )}

      <Text style={styles.section}>Endpoints</Text>
      <Text style={styles.code}>{`GET ${API_BASE}/recordings?since=<iso>
GET ${API_BASE}/transcript?folder=&base=&format=md
GET ${API_BASE}/utterances?folder=&base=
GET ${API_BASE}/meta?folder=&base=
GET ${API_BASE}/audio?folder=&base=

Header: Authorization: Bearer <key>`}</Text>
      <View style={{ height: 50 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { backgroundColor: "#0f1115", flex: 1, padding: 20, paddingTop: 50 },
  title: { color: "#fff", fontSize: 24, fontWeight: "700" },
  intro: { color: "#9aa0a6", fontSize: 13, marginTop: 8, lineHeight: 19 },
  generate: {
    backgroundColor: "#3b82f6",
    padding: 15,
    borderRadius: 12,
    alignItems: "center",
    marginTop: 18,
  },
  btnTxt: { color: "#fff", fontWeight: "700" },
  newKeyCard: {
    backgroundColor: "#16331f",
    borderRadius: 12,
    padding: 16,
    marginTop: 18,
  },
  newKeyLabel: { color: "#4ade80", fontWeight: "700", fontSize: 13 },
  newKeyValue: { color: "#fff", fontSize: 13, marginTop: 8, fontFamily: "monospace" },
  row: { flexDirection: "row", gap: 10, marginTop: 14 },
  copyBtn: {
    flex: 1,
    backgroundColor: "#1f5132",
    padding: 12,
    borderRadius: 10,
    alignItems: "center",
  },
  dim: { backgroundColor: "#23262d" },
  section: {
    color: "#6b7280",
    fontSize: 13,
    marginTop: 26,
    marginBottom: 8,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  hint: { color: "#6b7280", fontSize: 13 },
  keyRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#1a1d23",
    borderRadius: 12,
    padding: 14,
    marginBottom: 8,
  },
  keyLabel: { color: "#fff", fontSize: 15, fontWeight: "600" },
  keyMeta: { color: "#6b7280", fontSize: 12, marginTop: 3 },
  revoke: { color: "#f87171", fontWeight: "700", fontSize: 13 },
  code: {
    color: "#cdd1d6",
    fontSize: 12,
    fontFamily: "monospace",
    backgroundColor: "#1a1d23",
    borderRadius: 10,
    padding: 14,
    lineHeight: 20,
  },
});

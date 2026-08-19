import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Ionicons } from "@expo/vector-icons";
import {
  listRecordings,
  deleteRecording,
  moveToFolder,
} from "../recordings";
import {
  isFirebaseConfigured,
  isSignedIn,
  subscribeAuth,
  listRemote,
  fetchRemoteMeta,
  deleteRemoteRecording,
  uploadRecording,
} from "../firebase";
import { flushPendingUploads, retryPendingMerges } from "../recordingFlow";
import { iconFor } from "../placement";
import { getFolderIcons, getSettings } from "../storage";
import { INBOX, Recording } from "../types";
import type { RootStackParamList } from "../../App";

type Nav = NativeStackNavigationProp<RootStackParamList>;

export default function LibraryScreen() {
  const navigation = useNavigation<Nav>();
  const [local, setLocal] = useState<Recording[]>([]);
  const [remote, setRemote] = useState<Recording[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [authEmail, setAuthEmail] = useState<string | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [folderFilter, setFolderFilter] = useState<string | null>(null);
  const [icons, setIcons] = useState<Record<string, string>>({});
  const insets = useSafeAreaInsets();

  useEffect(() => subscribeAuth(setAuthEmail), []);
  useEffect(() => {
    getFolderIcons().then(setIcons);
  }, []);

  function sortRecs(arr: Recording[]): Recording[] {
    return [...arr].sort((x, y) =>
      (y.recordedAt || "").localeCompare(x.recordedAt || "")
    );
  }

  const load = useCallback(async () => {
    setBusy(true);
    const recs = await listRecordings();
    setLocal(recs);
    if (isFirebaseConfigured) {
      try {
        const localIds = new Set(recs.map((r) => r.id));
        const entries = await listRemote();
        const onlyRemote: Recording[] = [];
        for (const e of entries) {
          const meta = await fetchRemoteMeta(e.jsonPath);
          if (!localIds.has(meta.id)) onlyRemote.push(meta);
        }
        setRemote(onlyRemote);
      } catch {
        setRemote([]);
      }
    }
    setBusy(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  async function sync() {
    if (isFirebaseConfigured && !isSignedIn()) {
      setMsg("Sign in (Settings tab) to enable cloud sync.");
      return;
    }
    setMsg("Syncing…");
    const s = await getSettings();
    const n = await flushPendingUploads(s);
    const merged = await retryPendingMerges(s);
    setMsg(
      `Uploaded ${n} pending` + (merged ? ` · recovered ${merged} audio` : "")
    );
    load();
  }

  function remove(rec: Recording, isRemoteOnly: boolean) {
    Alert.alert(
      "Delete recording?",
      `${rec.base}\n\nDeletes the audio + transcript${
        isRemoteOnly ? " from the cloud." : " from this phone (and cloud if synced)."
      }`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            setMsg("Deleting…");
            try {
              if (!isRemoteOnly) await deleteRecording(rec);
              if (isFirebaseConfigured && isSignedIn()) {
                await deleteRemoteRecording(rec).catch(() => {});
              }
              setMsg("Deleted.");
            } catch (e: any) {
              setMsg("Delete failed: " + String(e?.message ?? e));
            }
            load();
          },
        },
      ]
    );
  }

  function exitSelect() {
    setSelectMode(false);
    setSelected(new Set());
  }
  function toggleSelect(id: string) {
    setSelected((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }
  const allIds = [...local, ...remote].map((r) => r.id);
  function selectAllToggle() {
    setSelected((prev) =>
      prev.size === allIds.length ? new Set() : new Set(allIds)
    );
  }
  function deleteSelected() {
    const all = [...local, ...remote];
    const targets = all.filter((r) => selected.has(r.id));
    if (!targets.length) return;
    Alert.alert(
      `Delete ${targets.length} recording${targets.length === 1 ? "" : "s"}?`,
      "Removes audio + transcript from this phone and the cloud.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            setMsg(`Deleting ${targets.length}…`);
            for (const r of targets) {
              const isRemoteOnly = !local.some((l) => l.id === r.id);
              try {
                if (!isRemoteOnly) await deleteRecording(r);
                if (isFirebaseConfigured && isSignedIn()) {
                  await deleteRemoteRecording(r).catch(() => {});
                }
              } catch {}
            }
            setMsg(`Deleted ${targets.length}.`);
            exitSelect();
            load();
          },
        },
      ]
    );
  }

  function moveSelected() {
    const all = [...local, ...remote];
    const targets = all.filter((r) => selected.has(r.id));
    const localTargets = targets.filter((r) => local.some((l) => l.id === r.id));
    if (!localTargets.length) {
      setMsg("Cloud-only recordings can't be moved — download them first.");
      return;
    }
    const folderOpts = Array.from(new Set([INBOX, ...local.map((r) => r.folder)]));
    Alert.alert(
      "Move to folder",
      `${localTargets.length} recording${localTargets.length === 1 ? "" : "s"}`,
      [
        ...folderOpts.map((f) => ({
          text: f,
          onPress: async () => {
            setMsg("Moving…");
            for (const r of localTargets) {
              try {
                if (r.folder === f) continue;
                const moved = await moveToFolder(r, f);
                if (isFirebaseConfigured && isSignedIn()) {
                  await deleteRemoteRecording(r).catch(() => {});
                  await uploadRecording(moved).catch(() => {});
                }
              } catch {}
            }
            setMsg(`Moved ${localTargets.length}.`);
            exitSelect();
            load();
          },
        })),
        { text: "Cancel", style: "cancel" as const },
      ]
    );
  }

  const folders = Array.from(new Set(local.map((r) => r.folder))).sort();

  const hasAny = local.length + remote.length > 0;

  return (
    <View style={styles.screen}>
    <ScrollView
      style={styles.container}
      refreshControl={
        <RefreshControl refreshing={busy} onRefresh={load} tintColor="#fff" />
      }
    >
      <View style={styles.header}>
        <Text style={styles.title}>Library</Text>
        <View style={styles.headerBtns}>
          {hasAny ? (
            <TouchableOpacity
              style={styles.sync}
              onPress={() => (selectMode ? exitSelect() : setSelectMode(true))}
            >
              <Text style={styles.syncTxt}>
                {selectMode ? "Cancel" : "Select"}
              </Text>
            </TouchableOpacity>
          ) : null}
          {!selectMode ? (
            <TouchableOpacity style={styles.sync} onPress={sync}>
              <Text style={styles.syncTxt}>Sync now</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={styles.sync} onPress={selectAllToggle}>
              <Text style={styles.syncTxt}>
                {selected.size === allIds.length ? "None" : "All"}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
      {isFirebaseConfigured && !authEmail ? (
        <TouchableOpacity
          style={styles.signedOut}
          onPress={() => navigation.navigate("Login")}
        >
          <Text style={styles.signedOutTxt}>
            ☁ Signed out — recordings stay on this phone.
          </Text>
          <Text style={styles.signedOutCta}>Tap to sign in →</Text>
        </TouchableOpacity>
      ) : null}
      {msg ? <Text style={styles.msg}>{msg}</Text> : null}
      {hasAny && !selectMode ? (
        <View style={styles.sortRow}>
          <TouchableOpacity
            style={[styles.sortChip, !folderFilter && styles.sortChipOn]}
            onPress={() => setFolderFilter(null)}
          >
            <Text
              style={[
                styles.sortChipTxt,
                !folderFilter && styles.sortChipTxtOn,
              ]}
            >
              all {local.length}
            </Text>
          </TouchableOpacity>
          {folders.map((f) => (
            <TouchableOpacity
              key={f}
              style={[styles.sortChip, folderFilter === f && styles.sortChipOn]}
              onPress={() => setFolderFilter(folderFilter === f ? null : f)}
            >
              <Text
                style={[
                  styles.sortChipTxt,
                  folderFilter === f && styles.sortChipTxtOn,
                ]}
              >
                {iconFor(f, icons)} {f}{" "}
                {local.filter((r) => r.folder === f).length}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      ) : null}
      {busy && local.length === 0 ? (
        <ActivityIndicator color="#fff" style={{ marginTop: 40 }} />
      ) : null}

      {sortRecs(
        folderFilter ? local.filter((r) => r.folder === folderFilter) : local
      ).map((r) => (
        <Row
          key={r.id}
          rec={r}
          icon={iconFor(r.folder, icons)}
          onPress={() => navigation.navigate("Detail", { rec: r })}
          onDelete={() => remove(r, false)}
          selectMode={selectMode}
          selected={selected.has(r.id)}
          onToggle={() => toggleSelect(r.id)}
        />
      ))}

      {remote.length > 0 && (
        <View>
          <Text style={styles.section}>☁ In cloud only</Text>
          {sortRecs(remote).map((r) => (
            <Row
              key={r.id}
              rec={r}
              icon={iconFor(r.folder, icons)}
              remote
              onPress={() =>
                navigation.navigate("Detail", { rec: r, remote: true })
              }
              onDelete={() => remove(r, true)}
              selectMode={selectMode}
              selected={selected.has(r.id)}
              onToggle={() => toggleSelect(r.id)}
            />
          ))}
        </View>
      )}

      {!busy && local.length === 0 && remote.length === 0 ? (
        <Text style={styles.empty}>No recordings yet.</Text>
      ) : null}
      <View style={{ height: selectMode ? 110 + insets.bottom : 40 }} />
    </ScrollView>
    {selectMode ? (
      <View style={[styles.actionBar, { paddingBottom: 14 + insets.bottom }]}>
        <Text style={styles.actionCount}>{selected.size} selected</Text>
        <View style={styles.actionBtns}>
          <TouchableOpacity
            style={[styles.moveBtn, selected.size === 0 && styles.delAllOff]}
            onPress={moveSelected}
            disabled={selected.size === 0}
          >
            <Ionicons name="folder-outline" size={18} color="#fff" />
            <Text style={styles.delAllTxt}>Move</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.delAll, selected.size === 0 && styles.delAllOff]}
            onPress={deleteSelected}
            disabled={selected.size === 0}
          >
            <Ionicons name="trash" size={18} color="#fff" />
            <Text style={styles.delAllTxt}>Delete ({selected.size})</Text>
          </TouchableOpacity>
        </View>
      </View>
    ) : null}
    </View>
  );
}

function syncInfo(
  rec: Recording,
  remote?: boolean
): { label: string; color: string } {
  if (remote) return { label: "Cloud", color: "#60a5fa" };
  if (rec.uploadStatus === "uploaded") return { label: "Synced", color: "#4ade80" };
  if (!isFirebaseConfigured || rec.uploadStatus === "skipped")
    return { label: "Phone", color: "#6b7280" };
  return { label: "Not synced", color: "#fbbf24" }; // pending
}

function Row({
  rec,
  icon,
  onPress,
  onDelete,
  remote,
  selectMode,
  selected,
  onToggle,
}: {
  rec: Recording;
  icon: string;
  onPress: () => void;
  onDelete?: () => void;
  remote?: boolean;
  selectMode?: boolean;
  selected?: boolean;
  onToggle?: () => void;
}) {
  const sync = syncInfo(rec, remote);
  const split = splitBase(rec.base);
  const date = split.date;
  // Prefer the AI topic — cloud recordings keep a provisional filename, so the
  // real title lives in the topic field rather than in the base.
  const title = rec.topic || split.title;
  return (
    <View>
    <View style={[styles.row, selected && styles.rowSel]}>
      {selectMode ? (
        <TouchableOpacity style={styles.play} onPress={onToggle}>
          <Ionicons
            name={selected ? "checkmark-circle" : "ellipse-outline"}
            size={28}
            color={selected ? "#3b82f6" : "#6b7280"}
          />
        </TouchableOpacity>
      ) : (
        <View style={styles.play}>
          <Text style={styles.folderIcon}>{icon}</Text>
        </View>
      )}
      <TouchableOpacity
        style={styles.rowBody}
        onPress={selectMode ? onToggle : onPress}
      >
        <Text style={styles.rowTitle} numberOfLines={1}>
          {title}
        </Text>
        <Text style={styles.rowSub} numberOfLines={1}>
          {(rec.speakers ?? []).join(", ") || "no speakers"}
          {rec.private ? "  🔒" : ""}
        </Text>
        <Text style={styles.rowFiling} numberOfLines={1}>
          {rec.folder}
          {rec.tags?.length ? `  ${rec.tags.map((t) => `#${t}`).join(" ")}` : ""}
        </Text>
        <View style={styles.metaRow}>
          {date ? <Text style={styles.rowDate}>{date}</Text> : null}
          <Text style={styles.rowMeta}>{fmtDur(rec.durationSeconds)}</Text>
          <View style={[styles.pill, { borderColor: sync.color }]}>
            <Text style={[styles.pillTxt, { color: sync.color }]}>
              {sync.label}
            </Text>
          </View>
          {rec.transcriptStatus === "done" ? (
            <View style={[styles.pill, { borderColor: "#4ade80" }]}>
              <Text style={[styles.pillTxt, { color: "#4ade80" }]}>Transcript</Text>
            </View>
          ) : rec.transcriptStatus === "pending" ||
            rec.transcriptStatus === "processing" ? (
            <View style={[styles.pill, { borderColor: "#fbbf24" }]}>
              <Text style={[styles.pillTxt, { color: "#fbbf24" }]}>Transcribing</Text>
            </View>
          ) : null}
          {rec.mergePending ? (
            <Text style={styles.rowMeta}>⏳ finishing (Sync)</Text>
          ) : null}
        </View>
      </TouchableOpacity>
      {!selectMode && onDelete ? (
        <TouchableOpacity
          style={styles.del}
          onPress={onDelete}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="trash-outline" size={20} color="#9aa0a6" />
        </TouchableOpacity>
      ) : null}
    </View>
    </View>
  );
}

function fmtDur(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// Splits the "YYYY-MM-DD <rest>" filename for display: a small readable date +
// the legible title. The stored base (and API filename) keep the full format.
function splitBase(base: string): { date: string; title: string } {
  const m = base.match(/^(\d{4})-(\d{2})-(\d{2})\s+(.*)$/);
  if (!m) return { date: "", title: base };
  // rest is "<speakers> - <topic>"; show only the topic (speakers are in the
  // gray subtitle). Split on the first " - ".
  const rest = m[4];
  const i = rest.indexOf(" - ");
  const title = i >= 0 ? rest.slice(i + 3) : rest;
  return {
    date: `${MONTHS[+m[2] - 1]} ${+m[3]}, ${m[1]}`,
    title: title || rest,
  };
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#0f1115" },
  container: { backgroundColor: "#0f1115", flex: 1, padding: 20, paddingTop: 60 },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  headerBtns: { flexDirection: "row", gap: 8 },
  title: { color: "#fff", fontSize: 26, fontWeight: "700" },
  sync: {
    backgroundColor: "#23262d",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 16,
  },
  syncTxt: { color: "#fff", fontWeight: "600" },
  msg: { color: "#9aa0a6", marginTop: 10 },
  sortRow: { flexDirection: "row", gap: 8, marginTop: 14 },
  sortChip: {
    backgroundColor: "#1a1d23",
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 16,
  },
  sortChipOn: { backgroundColor: "#3b82f6" },
  sortChipTxt: { color: "#9aa0a6", fontSize: 13, fontWeight: "600" },
  sortChipTxtOn: { color: "#fff" },
  signedOut: {
    backgroundColor: "#3a2f12",
    padding: 12,
    borderRadius: 8,
    marginTop: 12,
  },
  signedOutTxt: { color: "#fbbf24", fontSize: 12, lineHeight: 17 },
  signedOutCta: {
    color: "#fbbf24",
    fontSize: 13,
    fontWeight: "700",
    marginTop: 6,
  },
  section: {
    color: "#6b7280",
    fontSize: 13,
    marginTop: 22,
    marginBottom: 6,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  row: {
    backgroundColor: "#1a1d23",
    borderRadius: 12,
    padding: 14,
    marginBottom: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  play: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#23262d",
    alignItems: "center",
    justifyContent: "center",
  },
  playOn: { backgroundColor: "#3b82f6" },
  folderIcon: { fontSize: 22 },
  rowFiling: { color: "#7c828a", fontSize: 11.5, marginTop: 2 },
  playTxt: { color: "#fff", fontSize: 16 },
  rowSel: { backgroundColor: "#1e2740" },
  rowBody: { flex: 1 },
  rowTitle: { color: "#fff", fontSize: 15, fontWeight: "600" },
  rowSub: { color: "#9aa0a6", fontSize: 13, marginTop: 4 },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 5,
    marginTop: 6,
  },
  rowDate: { color: "#6b7280", fontSize: 11, fontWeight: "600" },
  rowMeta: { color: "#6b7280", fontSize: 11 },
  pill: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  pillTxt: { fontSize: 9.5, fontWeight: "700" },
  del: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  actionBar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#15171c",
    borderTopColor: "#23262d",
    borderTopWidth: 1,
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 26,
  },
  actionCount: { color: "#cdd1d6", fontSize: 14, fontWeight: "600" },
  actionBtns: { flexDirection: "row", gap: 10 },
  moveBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#3b82f6",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 12,
  },
  delAll: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#ef4444",
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 12,
  },
  delAllOff: { backgroundColor: "#3f2326" },
  delAllTxt: { color: "#fff", fontWeight: "700", fontSize: 15 },
  empty: { color: "#6b7280", textAlign: "center", marginTop: 60 },
});

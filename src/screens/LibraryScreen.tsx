import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
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
import { writeMeta, commitMeta } from "../recordings";
import { isCanonical, isCanonicalSync, deleteRemote, flushUploads, onCloudChange } from "../cloud";
import { canUploadNow } from "../network";
import { pushMeta, recordEdit, sendEdits } from "../outbox";
import { iconOf, useFolderIcons } from "../folderIcons";
import { placeLabel } from "../place";
import { isGreen, touch, adopt, changedKeys, trustOf, TRUST_COLOR, type Trust } from "../attribution";
import { fmtWhen, fmtLength } from "../when";
import { enqueue, replayOutbox } from "../outbox";
import { getSettings } from "../storage";
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
  const [trustFilter, setTrustFilter] = useState<"all" | "review" | "confirmed">("all");
  const [folderPick, setFolderPick] = useState(false);
  const icons = useFolderIcons();
  // Tapping a row's icon files that one recording. It used to open the folder
  // icon editor, which changed the badge on every recording in the folder —
  // one tap on one line visibly rewrote a dozen others. Folder icons are
  // edited in Settings, where the thing being edited is a folder.
  const [moveFor, setMoveFor] = useState<Recording | null>(null);
  const insets = useSafeAreaInsets();

  useEffect(() => subscribeAuth(setAuthEmail), []);
  // The listener rewrites sidecars under us; redraw when it does.
  useEffect(() => onCloudChange(() => { load(); }), []);

  function sortRecs(arr: Recording[]): Recording[] {
    return [...arr].sort((x, y) =>
      (y.recordedAt || "").localeCompare(x.recordedAt || "")
    );
  }

  const load = useCallback(async () => {
    setBusy(true);
    const recs = await listRecordings();
    setLocal(recs);
    // Under canonical every document already has a local entry (the
    // listener writes one), and the legacy prefix would list the old copies
    // as cloud-only duplicates until they are deleted.
    if (isFirebaseConfigured && !isCanonicalSync()) {
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
    const n = (await isCanonical()) ? await flushUploads(await canUploadNow(s)) : await flushPendingUploads(s);
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
              if (isFirebaseConfigured && isSignedIn()) {
                // Server first under canonical: the tombstone is the record.
                if (await isCanonical()) await deleteRemote(rec.id);
                else await deleteRemoteRecording(rec).catch(() => {});
              }
              if (!isRemoteOnly) await deleteRecording(rec);
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
                if (isFirebaseConfigured && isSignedIn()) {
                  if (await isCanonical()) await deleteRemote(r.id);
                  else await deleteRemoteRecording(r).catch(() => {});
                }
                if (!isRemoteOnly) await deleteRecording(r);
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

  // The amber dot is the one-tap path. Answering here stamps the field so a
  // Mac batch that ran earlier cannot overwrite it, and pushes the sidecar so
  // the Mac sees it on its next pull.
  async function decideMe(r: Recording, value: "yes" | "no") {
    // Persist the edit before anything else: a crash between this tap and
    // the server's answer must not lose it. Then show it, then send it. The
    // server returns the merged sidecar and replayOutbox writes that back.
    const change = (cur: Recording) => {
      let out = touch({ ...cur, meIncluded: value }, "meIncluded");
      if (value === "no" && out.speakerId) out = touch({ ...out, speakerId: undefined }, "speakerId");
      return out;
    };
    const preview = change(r);
    const patch: Record<string, unknown> = { meIncluded: value };
    if (value === "no" && r.speakerId) patch.speakerId = null;
    await enqueue(preview, patch, preview.fieldsUpdatedAt ?? {});
    const keys = changedKeys(r, preview);
    const next = await commitMeta(r, (cur) => adopt(cur, preview, keys));
    load();
    sendEdits(next).then(() => load()).catch(() => {});
  }

  function askMe(r: Recording) {
    Alert.alert(
      "Are you one of the speakers?",
      r.base,
      [
        { text: "Yes, I'm in it", onPress: () => decideMe(r, "yes") },
        { text: "No, not me", onPress: () => decideMe(r, "no") },
        { text: "Cancel", style: "cancel" },
      ]
    );
  }

  async function moveOne(r: Recording, f: string) {
    setMoveFor(null);
    if (r.folder === f) return;
    if (!local.some((l) => l.id === r.id)) {
      setMsg("Cloud-only recordings can't be moved — download it first.");
      return;
    }
    setMsg("Moving…");
    try {
      const moved = await moveFolderSynced(r, f);
      setMsg(`Moved to ${f}.`);
    } catch (e: any) {
      setMsg("Move failed: " + String(e?.message ?? e));
    }
    load();
  }

  // A folder change: under canonical a stamped field through the outbox,
  // under legacy the old copy-and-re-upload.
  async function moveFolderSynced(r: Recording, f: string): Promise<Recording> {
    const preview = touch({ ...r, folder: f }, "folder");
    await recordEdit(preview, { folder: f });
    // Legacy moves the files; v2 is metadata only. Then the exact stamp.
    const movedFiles = await moveToFolder(r, f);
    const moved = await commitMeta(movedFiles, (cur) => adopt(cur, preview, ["folder"]));
    if (isFirebaseConfigured && isSignedIn()) {
      if (await isCanonical()) await sendEdits(moved);
      else {
        await deleteRemoteRecording(r).catch(() => {});
        await uploadRecording(moved, { skipAudio: !!moved.mergedInCloud }).catch(() => {});
      }
    }
    return moved;
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
                await moveFolderSynced(r, f);
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

  const folders = Array.from(new Set(local.map((r) => r.folder).filter((f) => f && f.trim()))).sort();

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
        <View style={styles.filterRow}>
          {(["all", "review", "confirmed"] as const).map((k) => {
            const n = k === "all" ? local.length : local.filter((r) => (k === "confirmed") === (trustOf(r) === "green")).length;
            return (
              <TouchableOpacity key={k} style={[styles.seg, trustFilter === k && styles.segOn]} onPress={() => setTrustFilter(k)}>
                <Text style={[styles.segTxt, trustFilter === k && styles.segTxtOn]}>
                  {{ all: "All", review: "To review", confirmed: "Confirmed" }[k]} {n}
                </Text>
              </TouchableOpacity>
            );
          })}
          <TouchableOpacity style={[styles.seg, !!folderFilter && styles.segOn]} onPress={() => setFolderPick(true)}>
            <Text style={[styles.segTxt, !!folderFilter && styles.segTxtOn]} numberOfLines={1}>
              {folderFilter ? `${iconOf(folderFilter, icons)} ${folderFilter}` : "Folder ▾"}
            </Text>
          </TouchableOpacity>
        </View>
      ) : null}
      <Modal visible={folderPick} transparent animationType="fade" onRequestClose={() => setFolderPick(false)}>
        <TouchableOpacity style={styles.moveBackdrop} activeOpacity={1} onPress={() => setFolderPick(false)}>
          <View style={styles.moveCard}>
            {[null, ...folders].map((f) => (
              <TouchableOpacity key={f ?? "__all"} style={styles.moveItem} onPress={() => { setFolderFilter(f); setFolderPick(false); }}>
                <Text style={styles.moveItemTxt}>
                  {f ? `${iconOf(f, icons)}  ${f}` : "All folders"}  <Text style={{ color: "#7c828a" }}>{f ? local.filter((r) => r.folder === f).length : local.length}</Text>
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>
      {busy && local.length === 0 ? (
        <ActivityIndicator color="#fff" style={{ marginTop: 40 }} />
      ) : null}

      {sortRecs(
        local
          .filter((r) => !folderFilter || r.folder === folderFilter)
          .filter((r) => trustFilter === "all" || (trustFilter === "confirmed") === (trustOf(r) === "green"))
      ).map((r) => (
        <Row
          key={r.id}
          rec={r}
          icon={iconOf(r.folder, icons)}
          onIcon={() => setMoveFor(r)}
          onAttribution={isGreen(r) ? undefined : () => askMe(r)}
          onPress={() => navigation.navigate("Detail", { rec: r })}
          onDelete={() => remove(r, false)}
          selectMode={selectMode}
          selected={selected.has(r.id)}
          onToggle={() => toggleSelect(r.id)}
        />
      ))}

      <Modal
        visible={!!moveFor}
        transparent
        animationType="fade"
        onRequestClose={() => setMoveFor(null)}
      >
        <TouchableOpacity
          style={styles.moveBackdrop}
          activeOpacity={1}
          onPress={() => setMoveFor(null)}
        >
          <View style={styles.moveSheet}>
            <Text style={styles.moveTitle}>Move to folder</Text>
            <Text style={styles.moveSub} numberOfLines={1}>
              {moveFor?.base}
            </Text>
            <ScrollView style={styles.moveList}>
              {Array.from(
                new Set([INBOX, ...local.map((x) => x.folder)])
              ).map((f) => (
                <TouchableOpacity
                  key={f}
                  style={styles.moveRow}
                  onPress={() => moveOne(moveFor!, f)}
                  disabled={f === moveFor?.folder}
                >
                  <Text style={styles.moveIcon}>{iconOf(f, icons)}</Text>
                  <Text
                    style={[
                      styles.moveRowTxt,
                      f === moveFor?.folder && styles.moveRowCurrent,
                    ]}
                  >
                    {f}
                    {f === moveFor?.folder ? "  (current)" : ""}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        </TouchableOpacity>
      </Modal>

      {remote.length > 0 && (
        <View>
          <Text style={styles.section}>☁ In cloud only</Text>
          {sortRecs(remote).map((r) => (
            <Row
              key={r.id}
              rec={r}
              icon={iconOf(r.folder, icons)}
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
  onIcon,
  onAttribution,
  onPress,
  onDelete,
  remote,
  selectMode,
  selected,
  onToggle,
}: {
  rec: Recording;
  icon: string;
  onIcon?: () => void;
  /** Present only while the recording is not yet green. */
  onAttribution?: () => void;
  onPress: () => void;
  onDelete?: () => void;
  remote?: boolean;
  selectMode?: boolean;
  selected?: boolean;
  onToggle?: () => void;
}) {
  const split = splitBase(rec.base);
  const date = split.date;
  // Prefer the AI topic — cloud recordings keep a provisional filename, so the
  // real title lives in the topic field rather than in the base.
  const title = rec.topic || split.title;
  const trust = remote ? "grey" : trustOf(rec);
  const status = [
    rec.mergePending ? "finishing audio" : "",
    rec.transcriptStatus === "pending" || rec.transcriptStatus === "processing" ? "transcribing" : "",
    rec.transcriptStatus === "error" ? "transcription failed" : "",
    !remote && rec.uploadStatus === "pending" ? "not uploaded" : "",
    remote ? "cloud only" : "",
  ].filter(Boolean).join(" · ");
  const who = (rec.speakers ?? []).filter((x) => !/^Speaker \d+$/.test(x)).join(", ");
  return (
    <View
      style={[
        styles.row,
        { borderLeftColor: TRUST_COLOR[trust] },
        trust === "green" && styles.rowGreen,
        selected && styles.rowSel,
      ]}
    >
      {selectMode ? (
        <TouchableOpacity style={styles.play} onPress={onToggle}>
          <Ionicons
            name={selected ? "checkmark-circle" : "ellipse-outline"}
            size={24}
            color={selected ? "#3b82f6" : "#6b7280"}
          />
        </TouchableOpacity>
      ) : (
        <TouchableOpacity style={styles.play} onPress={onIcon} disabled={!onIcon}>
          <Text style={styles.folderIcon}>{icon}</Text>
        </TouchableOpacity>
      )}
      <TouchableOpacity style={styles.rowBody} onPress={selectMode ? onToggle : onPress}>
        <View style={styles.titleLine}>
          <Text style={[styles.rowTitle, { flex: 1, flexShrink: 1 }]} numberOfLines={1} ellipsizeMode="tail">{title}</Text>
          <Text style={styles.rowLen}>{fmtLength(rec.durationSeconds || rec.audioDurationSec)}</Text>
        </View>
        <Text style={styles.rowSub} numberOfLines={1}>
          {[fmtWhen(rec.recordedAt) || date, placeLabel(rec.place), who].filter(Boolean).join(" · ")}
          {rec.private ? "  🔒" : ""}
        </Text>
        {status || rec.reviewFlag || (rec.folder === INBOX && rec.folderSuggestion) ? (
          <Text style={[styles.rowStatus, rec.reviewFlag ? { color: "#f87171" } : null]} numberOfLines={1}>
            {[rec.reviewFlag ? "speakers disagree" : "", rec.folder === INBOX && rec.folderSuggestion ? `→ ${rec.folderSuggestion.folder}?` : "", status].filter(Boolean).join(" · ")}
          </Text>
        ) : null}
      </TouchableOpacity>
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
  rowGreen: { borderWidth: 1.5, borderColor: "#4ade80" },
  moveCard: { backgroundColor: "#1a1d23", borderRadius: 14, paddingVertical: 6, maxHeight: "80%" },
  moveItem: { paddingVertical: 13, paddingHorizontal: 18 },
  moveItemTxt: { color: "#e8eaed", fontSize: 16 },
  titleLine: { flexDirection: "row", alignItems: "center", gap: 8, width: "100%" },
  rowLen: { color: "#9aa0a6", fontSize: 12, flexShrink: 0 },
  rowStatus: { color: "#facc15", fontSize: 12, marginTop: 2 },
  filterRow: { flexDirection: "row", gap: 6, marginTop: 8, marginBottom: 4 },
  seg: { backgroundColor: "#1a1d23", borderRadius: 16, paddingHorizontal: 10, paddingVertical: 6, flexShrink: 1 },
  segOn: { backgroundColor: "#2f6fd0" },
  segTxt: { color: "#c9cdd3", fontSize: 13 },
  segTxtOn: { color: "#fff", fontWeight: "600" },
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
    borderLeftWidth: 4,
    paddingVertical: 10,
    paddingHorizontal: 10,
    marginBottom: 6,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  play: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#23262d",
    alignItems: "center",
    justifyContent: "center",
  },
  playOn: { backgroundColor: "#3b82f6" },
  folderIcon: { fontSize: 18 },
  dot: { width: 10, height: 10, borderRadius: 5, marginRight: 8 },
  amberHint: { color: "#f59e0b", fontSize: 11, marginTop: 2 },
  moveBackdrop: {
    flex: 1,
    backgroundColor: "#000000bb",
    justifyContent: "center",
    padding: 24,
  },
  moveSheet: {
    backgroundColor: "#15181d",
    borderRadius: 12,
    padding: 16,
    maxHeight: "70%",
  },
  moveTitle: { color: "#fff", fontSize: 16, fontWeight: "700" },
  moveSub: { color: "#9ca3af", fontSize: 12, marginTop: 2, marginBottom: 10 },
  moveList: { flexGrow: 0 },
  moveRow: { flexDirection: "row", alignItems: "center", paddingVertical: 12 },
  moveIcon: { fontSize: 20, width: 32 },
  moveRowTxt: { color: "#e5e7eb", fontSize: 15 },
  moveRowCurrent: { color: "#6b7280" },
  rowFiling: { color: "#7c828a", fontSize: 11.5, marginTop: 2 },
  playTxt: { color: "#fff", fontSize: 16 },
  rowSel: { backgroundColor: "#1e2740" },
  rowBody: { flex: 1, minWidth: 0 },
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
    borderRadius: 8,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  // Filled rather than outlined: the status is the point of the chip, so the
  // colour carries it at a glance. Dark text because every status colour here
  // is a light one.
  pillTxt: { fontSize: 9.5, fontWeight: "700", color: "#0b1220" },
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

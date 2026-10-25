/**
 * Canonical cloud client (phase "canonical" of the storage migration, see
 * mixtape-private/docs/migration/plan.md). The Firestore document
 * recordings/{uid}/items/{id} is the record of truth; this module keeps the
 * local sidecar in step with it and sends every edit through the server:
 *
 *  - createRecording before the audio goes up; the audio object is create-only;
 *  - every metadata edit travels through the outbox to patchMeta;
 *  - a listener on the collection brings the Mac's and the server's changes
 *    down; transcripts are downloaded per revision into a staging dir and
 *    installed atomically.
 *
 * Every local write goes through updateMeta(id, fn): it re-reads the current
 * sidecar under a per-id lock and changes only the fields the operation owns,
 * so a slow download cannot put back a folder an edit changed meanwhile.
 * Nothing here writes meta.json, transcripts or utterances to the bucket.
 */
import {
  collection, doc, getDoc, getDocFromServer, onSnapshot, query, where, type Unsubscribe,
} from "firebase/firestore";
import * as FileSystem from "expo-file-system/legacy";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { callFunction, currentUid, db, ensureSignedIn, isFirebaseConfigured, isSignedIn, putFileCreateOnly, remoteCanonicalPath, downloadRemoteFile } from "./firebase";
import { audioPath, listRecordings, writeMeta, normalizeRecording, revisionDir, updateMeta, deleteRecording } from "./recordings";
import { mergeNewest } from "./attribution";
import { logEvent } from "./log";
import type { Recording } from "./types";

export type Phase = "legacy" | "frozen" | "sealed" | "rolling-back" | "canonical";

let cachedPhase: { at: number; phase: Phase } | null = null;
const CANON_KEY = "phase.canonical.seen";
let seenCanonical: boolean | null = null;
async function sawCanonical(): Promise<boolean> {
  if (seenCanonical === null) {
    try { seenCanonical = (await AsyncStorage.getItem(CANON_KEY)) === "1"; if (seenCanonical) latchPersisted = true; }
    catch { return false; } // unknown this time; asked again on the next read
  }
  return seenCanonical;
}
/**
 * The migration phase, as the server sees it. Cached for a minute. Once this
 * phone has seen "canonical" it never falls back to legacy on a failed or
 * signed-out read: the cut-over is one-way, and taking the legacy path even
 * once would write the old layout.
 */
let latchPersisted = false;
export async function readPhase(): Promise<Phase> {
  // The latch wins over everything: cached reads, fresh reads, failures.
  if (await sawCanonical()) {
    if (!latchPersisted) { try { await AsyncStorage.setItem(CANON_KEY, "1"); latchPersisted = true; } catch {} }
    return "canonical";
  }
  if (!isFirebaseConfigured || !isSignedIn()) return "legacy";
  if (cachedPhase && Date.now() - cachedPhase.at < 60_000) return cachedPhase.phase;
  try {
    const s = await getDoc(doc(db(), "config", "migration"));
    const p = (s.exists() ? (s.data() as any).phase : "legacy") as Phase;
    const phase: Phase = ["legacy", "frozen", "sealed", "rolling-back", "canonical"].includes(p) ? p : "sealed";
    cachedPhase = { at: Date.now(), phase };
    if (phase === "canonical") {
      seenCanonical = true;
      try { await AsyncStorage.setItem(CANON_KEY, "1"); latchPersisted = true; } catch {}
    }
    return phase;
  } catch {
    return cachedPhase?.phase ?? "legacy";
  }
}
export const isCanonical = async () => (await readPhase()) === "canonical";
/** Last known answer without a network round trip (false until read once). */
export const isCanonicalSync = () => cachedPhase?.phase === "canonical" || seenCanonical === true;

/** Screens subscribe to learn that sidecars changed under them. */
const listeners = new Set<() => void>();
export function onCloudChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
const notifyChange = () => { for (const cb of listeners) { try { cb(); } catch {} } };

/** What the server knows about a recording, in the phone's shape. */
export function fromDoc(d: any): Partial<Recording> {
  const statusMap: Record<string, Recording["transcriptStatus"]> = {
    none: "none", pending: "pending", processing: "processing", stuck: "processing", done: "done", failed: "error",
  };
  const out: any = {
    ...d,
    transcriptStatus: statusMap[d.status] ?? "none",
    transcriptRevision: d.current ? d.current.rev : 0,
    uploadStatus: d.audio ? "uploaded" : "pending",
    mergedInCloud: !!d.audio,
    remoteCreated: true,
  };
  // null on the server is "unset" on the phone.
  for (const k of ["speakerId", "note", "place", "inputName", "topic", "meIncluded", "shareId", "summary"]) if (out[k] === null) out[k] = undefined;
  delete out.audio; delete out.current; delete out.status; delete out.attempts; delete out.ops; delete out.uid; delete out.schema; delete out.migration; delete out.deletedAt; delete out.purge; delete out.shareDirty;
  return out;
}
/** Fields the server owns: copied verbatim, never merged by stamp. */
function serverOwned(d: any): Partial<Recording> {
  return {
    transcriptStatus: fromDoc(d).transcriptStatus,
    transcriptRevision: d.current ? d.current.rev : 0,
    aaiTranscriptId: d.aaiTranscriptId ?? undefined,
    audioDurationSec: d.audioDurationSec ?? undefined,
    transcribedAt: d.transcribedAt ?? undefined,
    estCostUsd: d.estCostUsd ?? undefined,
    mergedInCloud: !!d.audio,
    remoteCreated: true,
    ...(d.audio ? { uploadStatus: "uploaded" as const } : {}),
  };
}

/** Creates the document for a freshly saved recording (idempotent). */
export async function createRemote(r: Recording, opId: string): Promise<void> {
  const fields: Record<string, unknown> = {
    id: r.id, opId, folder: r.folder, base: r.base, speakers: r.speakers, tags: r.tags ?? [], private: !!r.private,
    note: r.note ?? null, place: r.place ?? null, inputName: r.inputName ?? null, meIncluded: r.meIncluded ?? null,
    recordedAt: r.recordedAt, durationSeconds: r.durationSeconds, language: r.language, owner: r.owner ?? null,
    shareId: r.shareId ?? null, fieldsUpdatedAt: r.fieldsUpdatedAt ?? {},
  };
  await callFunction("createRecording", fields);
}

/**
 * Uploads the audio once. A 403 on retry means an object is already there:
 * the server says what it is, and we adopt it only when the checksum proves
 * it is our bytes. No checksum on either side is a conflict, not a pass.
 */
export async function uploadAudioOnce(r: Recording): Promise<"uploaded" | "adopted" | "conflict"> {
  await ensureSignedIn();
  const dest = remoteCanonicalPath(r.id, "audio.m4a");
  const info = await FileSystem.getInfoAsync(audioPath(r), { md5: true });
  if (!info.exists) throw new Error("no local audio");
  try {
    await putFileCreateOnly(audioPath(r), dest, "audio/mp4");
    return "uploaded";
  } catch (e: any) {
    if (!/\b403\b/.test(String(e?.message ?? e))) throw e;
    const { audio } = await callFunction<{ audio: { generation: string; size: number; crc32c: string; md5: string | null } | null }>("audioDescriptor", { id: r.id });
    if (!audio) throw e; // denied for another reason (phase, auth): retry later
    const localMd5 = info.md5 ? hexToBase64(info.md5) : null;
    if (audio.md5 && localMd5 && audio.md5 === localMd5 && audio.size === (info.size ?? -1)) return "adopted";
    logEvent(`audio conflict for ${r.id}: remote ${audio.size}B md5 ${audio.md5 ?? "-"}, local ${info.size}B md5 ${localMd5 ?? "-"}`);
    return "conflict";
  }
}

let unsub: Unsubscribe | null = null;
let applying: Promise<void> = Promise.resolve();
/**
 * Keeps the local sidecars in step with the documents. Client fields merge
 * newest-wins against unsent local edits; server fields are copied verbatim.
 * Documents the phone has never seen become local entries without audio.
 * Snapshots are applied one at a time, in order.
 */
export function startListener(): void {
  if (unsub || !isFirebaseConfigured || !isSignedIn()) return;
  const q = query(collection(db(), "recordings", currentUid(), "items"), where("deletedAt", "==", null));
  unsub = onSnapshot(q, (snap) => {
    applying = applying.then(() => applySnapshot(snap)).catch((e) => logEvent(`listener error ${String(e?.message ?? e)}`));
  }, (e) => logEvent(`listener failed ${String(e?.message ?? e)}`));
}
async function applySnapshot(snap: any): Promise<void> {
  const local = await listRecordings();
  const byId = new Map(local.map((r) => [r.id, r]));
  let changed = 0;
  let needPull = false;
  for (const d of snap.docs) {
    const data = d.data() as any;
    if (data.stub) continue;
    const mine = byId.get(data.id);
    if (!mine) {
      await writeMeta(normalizeRecording({ ...fromDoc(data), ...serverOwned(data), uploadStatus: "uploaded" }));
      changed++;
      if (data.current) needPull = true;
      continue;
    }
    const r = await updateMeta(data.id, (cur) => {
      const merged = mergeNewest(cur, fromDoc(data), { serverWinsTies: true });
      return { ...merged, ...serverOwned(data), uploadStatus: data.audio ? "uploaded" : cur.uploadStatus,
        durationSeconds: cur.durationSeconds || data.durationSeconds || 0 };
    });
    if (r.changed) changed++;
    if (data.current && (mine.transcriptLocalRev ?? -1) !== data.current.rev) needPull = true;
  }
  // Absent from a SERVER snapshot: confirm the tombstone before removing
  // anything local — a cached, partial snapshot is not evidence.
  if (!snap.metadata.fromCache) {
    const ids = new Set(snap.docs.map((d: any) => d.id));
    for (const r of local) {
      if (!r.remoteCreated || ids.has(r.id)) continue;
      try {
        const s = await getDocFromServer(doc(db(), "recordings", currentUid(), "items", r.id));
        if (s.exists() && (s.data() as any).deletedAt) {
          logEvent(`listener: ${r.id} deleted on the server; removing local entry`);
          await deleteRecording(r); changed++;
        }
      } catch {}
    }
  }
  if (changed) notifyChange();
  if (needPull) pullTranscripts().then((n) => { if (n) notifyChange(); }).catch(() => {});
}
export function stopListener(): void { unsub?.(); unsub = null; }

let pulling: Promise<number> | null = null;
/**
 * Downloads the current transcript revision when the phone does not have it:
 * both files into a staging dir, verified by size against the document's
 * descriptors, then installed under the revision and pointed at by the
 * sidecar's transcriptLocalRev. The previous pair stays until then.
 */
export function pullTranscripts(): Promise<number> {
  if (pulling) return pulling;
  pulling = doPull().finally(() => { pulling = null; });
  return pulling;
}
async function doPull(): Promise<number> {
  if (!(await isCanonical())) return 0;
  const all = await listRecordings();
  let n = 0;
  for (const r of all) {
    if (r.transcriptStatus !== "done" || !r.transcriptRevision) continue;
    if (r.transcriptLocalRev === r.transcriptRevision) continue;
    try {
      const s = await getDoc(doc(db(), "recordings", currentUid(), "items", r.id));
      const cur = (s.data() as any)?.current;
      if (!cur || cur.rev !== r.transcriptRevision) continue;
      const stage = `${FileSystem.cacheDirectory}stage_${r.id.replace(/[^A-Za-z0-9]/g, "_")}_r${cur.rev}/`;
      await FileSystem.makeDirectoryAsync(stage, { intermediates: true });
      const okTxt = await downloadRemoteFile(remoteCanonicalPath(r.id, cur.txt.name), stage + "transcript.txt");
      const okAai = await downloadRemoteFile(remoteCanonicalPath(r.id, cur.aai.name), stage + "utterances.aai.json");
      const iTxt = await FileSystem.getInfoAsync(stage + "transcript.txt");
      const iAai = await FileSystem.getInfoAsync(stage + "utterances.aai.json");
      if (!okTxt || !okAai || !iTxt.exists || !iAai.exists || iTxt.size !== cur.txt.size || iAai.size !== cur.aai.size) {
        logEvent(`transcript r${cur.rev} for ${r.id}: download incomplete, keeping previous`);
        continue;
      }
      const dir = revisionDir(r, cur.rev);
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
      await FileSystem.moveAsync({ from: stage + "transcript.txt", to: dir + "transcript.txt" });
      await FileSystem.moveAsync({ from: stage + "utterances.aai.json", to: dir + "utterances.aai.json" });
      // The pointer flips last; transcriptPath()/aaiJsonPath() follow it.
      await updateMeta(r.id, (c) => ({ ...c, transcriptLocalRev: cur.rev }));
      await FileSystem.deleteAsync(stage, { idempotent: true }).catch(() => {});
      n++;
      logEvent(`installed transcript r${cur.rev} for ${r.base}`);
    } catch (e: any) {
      logEvent(`pullTranscripts ${r.id}: ${String(e?.message ?? e)}`);
    }
  }
  return n;
}

/** Finishes uploads: creates missing documents, pushes audio once. */
export async function flushUploads(canUpload: boolean): Promise<number> {
  if (!(await isCanonical()) || !canUpload) return 0;
  const all = await listRecordings();
  let n = 0;
  for (const r of all.filter((x) => x.uploadStatus === "pending" && !x.mergePending)) {
    try {
      if (!r.remoteCreated) {
        await createRemote(r, `create:${r.id}`);
        await updateMeta(r.id, (c) => ({ ...c, remoteCreated: true }));
      }
      const res = await uploadAudioOnce(r);
      if (res === "conflict") { await updateMeta(r.id, (c) => ({ ...c, remoteCreated: true, uploadStatus: "skipped", audioConflict: true })); continue; }
      await updateMeta(r.id, (c) => ({ ...c, remoteCreated: true, uploadStatus: "uploaded", mergedInCloud: true }));
      n++;
    } catch (e: any) {
      logEvent(`flushUploads ${r.id}: ${String(e?.message ?? e)}`);
    }
  }
  if (n) notifyChange();
  return n;
}

/**
 * One paid job per user request: the operation id is persisted on the
 * sidecar before the call and reused until the server acknowledges it.
 */
export async function retranscribeRemote(id: string): Promise<void> {
  const r = await updateMeta(id, (c) => ({ ...c, pendingOp: c.pendingOp ?? `re:${id}:${Date.now()}` }));
  await callFunction("retranscribe", { id, opId: r.rec.pendingOp }, 60000);
  await updateMeta(id, (c) => ({ ...c, pendingOp: undefined }));
}
export async function deleteRemote(id: string): Promise<void> {
  await callFunction("deleteRecording", { id, opId: `del:${id}` });
}

function hexToBase64(hex: string): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b, c] = [bytes[i], bytes[i + 1], bytes[i + 2]];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += chars[(n >> 18) & 63] + chars[(n >> 12) & 63] + (b === undefined ? "=" : chars[(n >> 6) & 63]) + (c === undefined ? "=" : chars[n & 63]);
  }
  return out;
}

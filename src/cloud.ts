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
 * Nothing here writes meta.json, transcripts or utterances to the bucket.
 */
import {
  collection, doc, getDoc, onSnapshot, query, where, type Unsubscribe,
} from "firebase/firestore";
import * as FileSystem from "expo-file-system/legacy";
import { callFunction, currentUid, db, ensureSignedIn, isFirebaseConfigured, isSignedIn, putFileCreateOnly, remoteCanonicalPath, downloadRemoteFile } from "./firebase";
import { audioPath, transcriptPath, aaiJsonPath, listRecordings, writeMeta, normalizeRecording, revisionDir } from "./recordings";
import { mergeNewest } from "./attribution";
import { logEvent } from "./log";
import type { Recording } from "./types";

export type Phase = "legacy" | "frozen" | "sealed" | "rolling-back" | "canonical";

let cachedPhase: { at: number; phase: Phase } | null = null;
/** The migration phase, as the server sees it. Cached for a minute. */
export async function readPhase(): Promise<Phase> {
  if (!isFirebaseConfigured || !isSignedIn()) return "legacy";
  if (cachedPhase && Date.now() - cachedPhase.at < 60_000) return cachedPhase.phase;
  try {
    const s = await getDoc(doc(db(), "config", "migration"));
    const p = (s.exists() ? (s.data() as any).phase : "legacy") as Phase;
    const phase: Phase = ["legacy", "frozen", "sealed", "rolling-back", "canonical"].includes(p) ? p : "sealed";
    cachedPhase = { at: Date.now(), phase };
    return phase;
  } catch {
    return cachedPhase?.phase ?? "legacy";
  }
}
export const isCanonical = async () => (await readPhase()) === "canonical";

/** What the server knows about a recording, in the phone's shape. */
export function fromDoc(d: any): Partial<Recording> & { current?: any; status?: string; audio?: any } {
  const statusMap: Record<string, Recording["transcriptStatus"]> = {
    none: "none", pending: "pending", processing: "processing", stuck: "processing", done: "done", failed: "error",
  };
  return {
    ...d,
    transcriptStatus: statusMap[d.status] ?? "none",
    transcriptRevision: d.current ? d.current.rev : 0,
    uploadStatus: d.audio ? "uploaded" : "pending",
    mergedInCloud: !!d.audio,
    speakerId: d.speakerId ?? undefined,
    note: d.note ?? undefined,
    place: d.place ?? undefined,
    inputName: d.inputName ?? undefined,
    topic: d.topic ?? undefined,
    meIncluded: d.meIncluded ?? undefined,
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
 * the server says what it is, and we adopt it only if it is our bytes.
 */
export async function uploadAudioOnce(r: Recording): Promise<"uploaded" | "adopted" | "conflict"> {
  await ensureSignedIn();
  const dest = remoteCanonicalPath(r.id, "audio.m4a");
  const info = await FileSystem.getInfoAsync(audioPath(r));
  if (!info.exists) throw new Error("no local audio");
  try {
    await putFileCreateOnly(audioPath(r), dest, "audio/mp4");
    return "uploaded";
  } catch (e: any) {
    if (!/\b403\b/.test(String(e?.message ?? e))) throw e;
    const { audio } = await callFunction<{ audio: { generation: string; size: number; crc32c: string; md5: string | null } | null }>("audioDescriptor", { id: r.id });
    if (!audio) throw e; // denied for another reason (phase, auth): retry later
    // Same bytes or not: size plus md5 (GCS reports md5 for a single-shot
    // upload, which is what the phone does; the local one comes from disk).
    const local = await FileSystem.getInfoAsync(audioPath(r), { md5: true });
    const localMd5 = local.exists && local.md5 ? hexToBase64(local.md5) : null;
    if (audio.size === (info.size ?? -1) && (!audio.md5 || !localMd5 || audio.md5 === localMd5)) return "adopted";
    logEvent(`audio conflict for ${r.id}: remote ${audio.size} bytes, local ${info.size}`);
    return "conflict";
  }
}

let unsub: Unsubscribe | null = null;
/**
 * Keeps the local sidecars in step with the documents. Client fields merge
 * newest-wins against unsent local edits; server fields are copied verbatim.
 * Documents the phone has never seen become local entries without audio.
 */
export function startListener(onChange: () => void): void {
  if (unsub || !isFirebaseConfigured || !isSignedIn()) return;
  const q = query(collection(db(), "recordings", currentUid(), "items"), where("deletedAt", "==", null));
  unsub = onSnapshot(q, async (snap) => {
    try {
      const local = await listRecordings();
      const byId = new Map(local.map((r) => [r.id, r]));
      let changed = 0;
      for (const d of snap.docs) {
        const data = d.data() as any;
        if (data.stub) continue;
        const remote = fromDoc(data);
        const mine = byId.get(data.id);
        if (!mine) {
          await writeMeta(normalizeRecording({ ...remote, uploadStatus: "uploaded", mergedInCloud: !!data.audio }));
          changed++;
          continue;
        }
        const merged = mergeNewest(mine, remote, { serverWinsTies: true });
        const next: Recording = {
          ...merged,
          transcriptStatus: remote.transcriptStatus!,
          transcriptRevision: remote.transcriptRevision,
          topic: remote.topic ?? merged.topic,
          aaiTranscriptId: data.aaiTranscriptId ?? merged.aaiTranscriptId,
          audioDurationSec: data.audioDurationSec ?? merged.audioDurationSec,
          transcribedAt: data.transcribedAt ?? merged.transcribedAt,
          estCostUsd: data.estCostUsd ?? merged.estCostUsd,
          durationSeconds: merged.durationSeconds || data.durationSeconds || 0,
          language: data.language || merged.language,
          mergedInCloud: !!data.audio,
          uploadStatus: data.audio ? "uploaded" : mine.uploadStatus,
        };
        if (JSON.stringify(next) !== JSON.stringify(mine)) { await writeMeta(next); changed++; }
      }
      // Tombstoned on the server: gone from the query, so gone here too.
      const ids = new Set(snap.docs.map((d) => d.id));
      for (const r of local) if (r.uploadStatus === "uploaded" && !ids.has(r.id) && r.mergedInCloud) {
        logEvent(`listener: ${r.id} deleted on the server; removing local entry`);
        const { deleteRecording } = await import("./recordings");
        await deleteRecording(r); changed++;
      }
      if (changed) onChange();
    } catch (e: any) {
      logEvent(`listener error ${String(e?.message ?? e)}`);
    }
  }, (e) => logEvent(`listener failed ${String(e?.message ?? e)}`));
}
export function stopListener(): void { unsub?.(); unsub = null; }

/**
 * Downloads the current transcript revision when the phone does not have it:
 * both files into a staging dir, verified by size against the document's
 * descriptors, then installed under the revision and pointed at by the
 * sidecar's transcriptLocalRev. The previous pair stays until then.
 */
export async function pullTranscripts(): Promise<number> {
  if (!(await isCanonical())) return 0;
  const all = await listRecordings();
  let n = 0;
  for (const r of all) {
    if (r.transcriptStatus !== "done" || !r.transcriptRevision) continue;
    if ((r as any).transcriptLocalRev === r.transcriptRevision) continue;
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
      await writeMeta({ ...r, transcriptLocalRev: cur.rev } as Recording);
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
      if (!(r as any).remoteCreated) {
        await createRemote(r, `create:${r.id}`);
        await writeMeta({ ...r, remoteCreated: true } as Recording);
      }
      const res = await uploadAudioOnce(r);
      if (res === "conflict") { await writeMeta({ ...r, remoteCreated: true, uploadStatus: "skipped", audioConflict: true } as Recording); continue; }
      await writeMeta({ ...r, remoteCreated: true, uploadStatus: "uploaded", mergedInCloud: true } as Recording);
      n++;
    } catch (e: any) {
      logEvent(`flushUploads ${r.id}: ${String(e?.message ?? e)}`);
    }
  }
  return n;
}

export async function retranscribeRemote(id: string): Promise<void> {
  await callFunction("retranscribe", { id, opId: `re:${id}:${Date.now()}` }, 60000);
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

import AsyncStorage from "@react-native-async-storage/async-storage";
import { callFunction, isFirebaseConfigured, isSignedIn, uploadRecording } from "./firebase";
import { listRecordings, writeMeta, updateMeta, isLayoutV2 } from "./recordings";
import { logEvent } from "./log";
import { mergeNewest } from "./attribution";
import { isCanonical, isCanonicalSync, fromDoc } from "./cloud";
import type { Recording } from "./types";

/**
 * Write-ahead outbox for metadata edits. An edit is persisted here BEFORE it
 * is shown or sent, so a crash between tapping and the server acknowledging
 * cannot lose it. Each entry carries the stamps it was made with; replay
 * never refreshes them, so a replayed edit is still ranked by when it was
 * actually made. The server returns the merged record, which is what the
 * phone then keeps — never its own guess at the result.
 *
 * Entries are keyed by recording id. Under the canonical phase they go to
 * patchMeta({id, patch}); under legacy to patchMeta({folder, base, patch}).
 * Every mutation of the persisted queue runs under one lock; replay is
 * serialized separately and batches per (recording, transcript revision) so
 * a letter edit made against an older run is never sent as a newer one.
 */
const KEY = "outbox.v1";

export type OutboxItem = {
  key: string; // id:field — newest edit per field wins locally
  recordingId: string;
  folder: string;
  base: string;
  patch: Record<string, unknown>; // one field, or speakerLabels.{L}
  fieldsUpdatedAt: Record<string, string>;
  expectedRevision?: number;
  attempts: number;
  firstAt?: string;
  lastError?: string;
  stuck?: boolean; // a conflict the server refused; needs a person, not a retry
};

async function load(): Promise<OutboxItem[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as OutboxItem[]) : [];
  } catch {
    return [];
  }
}
async function save(items: OutboxItem[]): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(items));
}
let queueLock: Promise<unknown> = Promise.resolve();
/** Read-modify-write of the queue, one at a time. */
function mutateQueue<T>(fn: (items: OutboxItem[]) => T | Promise<T>): Promise<T> {
  const run = queueLock.then(async () => {
    const items = await load();
    const out = await fn(items);
    await save(items);
    return out;
  });
  queueLock = run.catch(() => {});
  return run;
}
const stampOf = (it: OutboxItem) => it.fieldsUpdatedAt[Object.keys(it.patch)[0]];

/** Persists an edit, then returns. Call replayOutbox() to send it. */
export async function enqueue(
  rec: Recording,
  patch: Record<string, unknown>,
  stamps: Record<string, string>,
  expectedRevision?: number
): Promise<void> {
  await mutateQueue((items) => {
    for (const [field, value] of Object.entries(patch)) {
      const key = `${rec.id}:${field}`;
      const next: OutboxItem = {
        key, recordingId: rec.id, folder: rec.folder, base: rec.base,
        patch: { [field]: value }, fieldsUpdatedAt: { [field]: stamps[field] },
        expectedRevision, attempts: 0, firstAt: new Date().toISOString(),
      };
      const i = items.findIndex((x) => x.key === key);
      if (i >= 0) items[i] = next; else items.push(next);
    }
  });
}

/**
 * Step one of an edit: persist it, before the sidecar is written or the UI
 * updated. Under canonical the outbox is the operation; under legacy the
 * sidecar upload in sendEdits is, and there is nothing to record.
 */
export async function recordEdit(
  next: Recording,
  patch: Record<string, unknown>,
  expectedRevision?: number
): Promise<void> {
  if (isCanonicalSync() || (await isCanonical())) await enqueue(next, patch, next.fieldsUpdatedAt ?? {}, expectedRevision);
}
/** Step two: send what is queued (canonical) or upload the sidecar (legacy). */
export async function sendEdits(next: Recording): Promise<void> {
  if (!isFirebaseConfigured || !isSignedIn()) return;
  if (await isCanonical()) { replayOutbox().catch(() => {}); return; }
  uploadRecording(next, { skipAudio: !!next.mergedInCloud }).catch(() => {});
}
/** Both steps, for callers that have already written the sidecar. */
export async function pushMeta(next: Recording, patch: Record<string, unknown>, expectedRevision?: number): Promise<void> {
  await recordEdit(next, patch, expectedRevision);
  await sendEdits(next);
}

/** How many edits are waiting, and how many the server has refused. */
export async function outboxStatus(): Promise<{ pending: number; stuck: number }> {
  const items = await load();
  return { pending: items.filter((x) => !x.stuck).length, stuck: items.filter((x) => x.stuck).length };
}

let inFlight: Promise<number> | null = null;
let again = false;

/** Sends what is queued. Safe to call often; a call during a replay queues one more pass. */
export function replayOutbox(): Promise<number> {
  if (inFlight) { again = true; return inFlight; }
  inFlight = (async () => {
    let total = 0;
    do { again = false; total += await doReplay(); } while (again);
    return total;
  })().finally(() => { inFlight = null; });
  return inFlight;
}

// Not-found is retryable for a day after the edit was made: the create may
// not have landed yet. After that it is a conflict for a person.
const NOT_FOUND_GRACE_MS = 24 * 60 * 60 * 1000;

async function doReplay(): Promise<number> {
  if (!isFirebaseConfigured || !isSignedIn()) return 0;
  const items = await load();
  if (!items.length) return 0;
  const canonical = await isCanonical();
  const local = await listRecordings();
  const byId = new Map(local.map((r) => [r.id, r]));
  let sent = 0;
  // One request per (recording, revision): letter edits travel with the
  // revision they were made against, and only with edits of the same one.
  const groups = new Map<string, OutboxItem[]>();
  for (const it of items) {
    if (it.stuck) continue;
    const g = `${it.recordingId}\u0000${it.expectedRevision ?? ""}`;
    groups.set(g, [...(groups.get(g) ?? []), it]);
  }
  for (const group of groups.values()) {
    const recordingId = group[0].recordingId;
    const rec = byId.get(recordingId);
    if (canonical && rec && !rec.remoteCreated) continue; // the create goes first (flushUploads)
    const patch: Record<string, unknown> = {};
    const stamps: Record<string, string> = {};
    let expectedRevision: number | undefined;
    const labels: Record<string, unknown> = {};
    for (const it of group) {
      for (const [f, v] of Object.entries(it.patch)) {
        if (f.startsWith("speakerLabels.")) labels[f.slice(14)] = v;
        else patch[f] = v;
      }
      Object.assign(stamps, it.fieldsUpdatedAt);
      if (it.expectedRevision !== undefined) expectedRevision = it.expectedRevision;
    }
    if (Object.keys(labels).length) {
      patch.speakerLabels = labels;
      if (expectedRevision === undefined) expectedRevision = rec?.transcriptRevision ?? 0;
    }
    const body = { ...patch, fieldsUpdatedAt: stamps, ...(expectedRevision !== undefined ? { expectedRevision } : {}) };
    const folder = rec?.folder ?? group[0].folder;
    const base = rec?.base ?? group[0].base;
    const sentKeys = new Set(group.map((g) => `${g.key}@${stampOf(g)}`));
    const matches = (x: OutboxItem) => sentKeys.has(`${x.key}@${stampOf(x)}`);
    try {
      const res = await callFunction<{ meta?: any }>(
        "patchMeta",
        canonical ? { id: recordingId, patch: body } : { folder, base, patch: body }
      );
      const merged = res?.meta ? (canonical ? fromDoc(res.meta) : res.meta) : null;
      if (rec && merged) {
        // Authoritative synced state from the server, device-only fields
        // ours. Applied to the sidecar as it is NOW, not as it was when the
        // request left: an edit made meanwhile keeps its newer stamp.
        const apply = (cur: Recording): Recording => {
          const next = mergeNewest(cur, merged, { serverWinsTies: true });
          return { ...next, transcriptStatus: merged.transcriptStatus ?? next.transcriptStatus,
            transcriptRevision: merged.transcriptRevision ?? next.transcriptRevision };
        };
        if (canonical && isLayoutV2()) await updateMeta(recordingId, apply);
        else await writeMeta(apply(rec));
      }
      // Ack exactly what was sent; an edit queued meanwhile has a different stamp.
      await mutateQueue((cur) => { for (let i = cur.length - 1; i >= 0; i--) if (matches(cur[i])) cur.splice(i, 1); });
      sent += group.length;
    } catch (e: any) {
      const code = String(e?.code ?? "");
      const msg = String(e?.message ?? e);
      const notFound = code.includes("not-found");
      const young = group.some((g) => Date.now() - Date.parse(g.firstAt ?? "1970-01-01") < NOT_FOUND_GRACE_MS);
      const permanent = code.includes("invalid-argument") || code.includes("failed-precondition") || (notFound && !young);
      await mutateQueue((cur) => {
        for (const it of cur) if (matches(it)) {
          it.attempts += 1; it.lastError = msg.slice(0, 200);
          if (permanent) it.stuck = true;
        }
      });
      logEvent(`outbox ${permanent ? "stuck" : "retry"} ${base}: ${msg.slice(0, 120)}`);
    }
  }
  return sent;
}

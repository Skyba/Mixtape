import * as FileSystem from "expo-file-system/legacy";
import { listRecordings, audioPath } from "./recordings";
import { processStop, processStopLive, isRecordingInProgress } from "./recordingFlow";
import { peekPending } from "./pendingTake";
import { INBOX, Recording, Settings } from "./types";
import { isPlayable } from "./mp4";

export type CacheAudio = {
  uri: string;
  size: number;
  modTime: number; // ms
  // The recorder was killed before it could finalise this file (phone restart,
  // battery death) — the audio bytes are there but the MP4 index isn't, so
  // nothing can play or transcribe it without repair.
  damaged?: boolean;
  // A live session records in 20-second segments, so one conversation is
  // hundreds of files. They're grouped into a single entry, in order.
  segments?: string[];
  // Segments absent from the middle of the run (index gaps): the joined
  // file will be shorter than the take was.
  missing?: number;
};

/**
 * Where a chunked or live take keeps its finished segments. Not the cache:
 * Android clears that when storage runs low, and until the merge lands these
 * are the only copy of everything after the first segment.
 */
export const SEGMENT_DIR = `${FileSystem.documentDirectory}segments/`;

/** Every segment some saved or interrupted take still needs. */
async function segmentsInUse(): Promise<Set<string>> {
  const keep = new Set<string>();
  for (const r of await listRecordings()) {
    for (const u of r.mergePending?.segments ?? []) keep.add(u);
    for (const u of r.mergeLocalPending?.segments ?? []) keep.add(u);
  }
  // A take that died mid-recording is saved from these on the next launch.
  for (const u of (await peekPending())?.segments ?? []) keep.add(u);
  return keep;
}

async function scanAll(out: CacheAudio[]): Promise<void> {
  const root = FileSystem.cacheDirectory;
  if (root) await scan(root, 2, out);
  if (FileSystem.documentDirectory) await scan(SEGMENT_DIR, 0, out);
}

// Live segment files: seg_<sessionId>_<index>.m4a (see RecordScreen).
const SEG_RE = /^seg_(\d+)_(\d+)\.m4a$/;

const AUDIO_RE = /\.(m4a|mp4|aac|wav|caf|3gp)$/i;

async function scan(dir: string, depth: number, out: CacheAudio[]): Promise<void> {
  let names: string[] = [];
  try {
    names = await FileSystem.readDirectoryAsync(dir);
  } catch {
    return; // unreadable subdirectory — skip
  }
  for (const n of names) {
    const uri = dir + n;
    let info;
    try {
      info = await FileSystem.getInfoAsync(uri);
    } catch {
      continue;
    }
    if (!info.exists) continue;
    if (info.isDirectory) {
      if (depth > 0) await scan(uri + "/", depth - 1, out);
      continue;
    }
    if (!AUDIO_RE.test(n) || !info.size) continue;
    out.push({
      uri,
      size: info.size,
      modTime: (info.modificationTime ?? 0) * 1000,
    });
  }
}

/**
 * Audio sitting in the cache directory that isn't in the library. expo-audio
 * records into the cache, and a discarded take is still stopped properly (so
 * the file is complete and playable) — it just never gets copied out. Android
 * clears this cache when storage runs low, so anything listed here is on
 * borrowed time.
 *
 * Files whose size exactly matches a recording already saved are filtered out,
 * so the list only shows audio that would otherwise be lost.
 */
export async function listOrphanAudio(): Promise<CacheAudio[]> {
  const found: CacheAudio[] = [];
  await scanAll(found);

  // Collapse each live session's segments into one row, ordered by index.
  const sessions = new Map<string, { idx: number; f: CacheAudio }[]>();
  const singles: CacheAudio[] = [];
  for (const f of found) {
    const m = SEG_RE.exec(f.uri.split("/").pop() ?? "");
    if (m) {
      const list = sessions.get(m[1]) ?? [];
      list.push({ idx: Number(m[2]), f });
      sessions.set(m[1], list);
    } else {
      singles.push(f);
    }
  }
  const grouped: (CacheAudio & { parts: CacheAudio[] })[] = [];
  for (const parts of sessions.values()) {
    parts.sort((a, b) => a.idx - b.idx);
    // Only the last segment can be unfinalised (the ones before it were closed
    // when the chain rolled). Drop it from the merge — a truncated tail would
    // break the concat — but say so, since it's the audio nearest the end.
    const last = parts[parts.length - 1].f;
    const tailOk = await isPlayable(last.uri, last.size);
    const keep = tailOk ? parts : parts.slice(0, -1);
    if (!keep.length) continue;
    const span = parts[parts.length - 1].idx - parts[0].idx + 1;
    grouped.push({
      missing: span - parts.length + parts[0].idx || undefined,
      uri: keep[0].f.uri,
      size: keep.reduce((n, p) => n + p.f.size, 0),
      modTime: Math.max(...parts.map((p) => p.f.modTime)),
      segments: keep.map((p) => p.f.uri),
      damaged: !tailOk,
      parts: parts.map((p) => p.f),
    });
  }

  const saved = new Set<number>();
  // Segments of a saved take still waiting on its merge (or on the download
  // of the merged file) are that take's audio, not lost audio: importing them
  // makes a second copy of the recording.
  const merging = await segmentsInUse();
  for (const r of await listRecordings()) {
    try {
      const i = await FileSystem.getInfoAsync(audioPath(r));
      if (i.exists && i.size) saved.add(i.size);
    } catch {
      /* missing audio — nothing to match against */
    }
  }
  // Every segment exists twice: our seg_* copy and the recorder's own file it
  // was copied from. Same bytes, same 20 seconds — list it once.
  const segSizes = new Set<number>();
  for (const g of grouped) for (const p of g.parts) segSizes.add(p.size);

  const keptSingles = singles.filter(
    (f) => !saved.has(f.size) && !segSizes.has(f.size)
  );
  for (const f of keptSingles) f.damaged = !(await isPlayable(f.uri, f.size));

  const lost = grouped.filter((g) => !g.segments?.some((u) => merging.has(u)));
  return [...keptSingles, ...lost.map(({ parts, ...g }) => g)].sort(
    (a, b) => b.modTime - a.modTime
  );
}

/**
 * Saves cache audio into the library. No speakers and no language are set —
 * guessing either is how a recovered file gets transcribed wrong (a stale
 * one-speaker default collapses a conversation into a single label). Assign
 * the speakers on the recording's own page, then transcribe from there.
 */
export async function importOrphanAudio(
  file: CacheAudio,
  settings: Settings
): Promise<Recording> {
  if (file.segments) {
    // A live session: the segments have to be stitched back together in the
    // cloud, which is exactly what the normal live-stop path does.
    const rec = await processStopLive({
      // The last write is the nearest thing to a time the take has; the
      // import moment is certainly wrong.
      recordedAt: file.modTime ? new Date(file.modTime).toISOString() : undefined,
      segmentUris: file.segments,
      liveText: "",
      durationSeconds: 0,
      speakers: [],
      folder: INBOX,
      language: "",
      settings,
      // Without this the merge lands and the recording sits at "none"
      // forever: recovery would restore the audio and never transcribe it.
      transcribeAfterMerge: true,
    });
    // The segments go once the merged file is on the phone, which the save
    // path does itself; until then they're the only complete local copy.
    return rec;
  }
  return processStop({
    recordedAt: file.modTime ? new Date(file.modTime).toISOString() : undefined,
    cacheUri: file.uri,
    durationSeconds: 0, // filled in from the transcript
    plannedDurationHours: 0,
    speakers: [],
    folder: INBOX,
    language: "", // empty = let AssemblyAI detect it
    settings,
    // Import it either way — the bytes are worth keeping — but don't let it
    // pose as a normal recording, or upload into the slot a repair needs.
    damaged: file.damaged,
  });
}

/**
 * Deletes every audio file in the cache — including the recorder's own copies
 * that the listing hides as duplicates. Returns the bytes reclaimed.
 */
export async function clearAllCacheAudio(): Promise<number> {
  // The take being recorded, or being saved, is in here too.
  if (isRecordingInProgress()) throw new Error("A recording is in progress. Stop it first.");
  const found: CacheAudio[] = [];
  await scanAll(found);
  // Segments of a take whose merge has not landed are the only copy of
  // everything after its first minutes; they are not cache to reclaim.
  const keep = await segmentsInUse();
  let freed = 0;
  for (const f of found) {
    if (keep.has(f.uri)) continue;
    try {
      await FileSystem.deleteAsync(f.uri, { idempotent: true });
      freed += f.size;
    } catch {
      /* already gone or not ours to delete */
    }
  }
  return freed;
}

/** Deletes the given cache files (all segments, for a live session). */
export async function deleteOrphanAudio(files: CacheAudio[]): Promise<number> {
  let freed = 0;
  for (const f of files) {
    for (const uri of f.segments ?? [f.uri]) {
      try {
        await FileSystem.deleteAsync(uri, { idempotent: true });
      } catch {
        /* already gone or not ours to delete */
      }
    }
    freed += f.size;
  }
  return freed;
}

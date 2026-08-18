import * as FileSystem from "expo-file-system/legacy";
import { listRecordings, audioPath } from "./recordings";
import { processStop, processStopLive } from "./recordingFlow";
import { INBOX, Recording, Settings } from "./types";

export type CacheAudio = {
  uri: string;
  size: number;
  modTime: number; // ms
  // A live session records in 20-second segments, so one conversation is
  // hundreds of files. They're grouped into a single entry, in order.
  segments?: string[];
};

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
  const root = FileSystem.cacheDirectory;
  if (!root) return [];
  const found: CacheAudio[] = [];
  await scan(root, 2, found);

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
    grouped.push({
      uri: parts[0].f.uri,
      size: parts.reduce((n, p) => n + p.f.size, 0),
      modTime: Math.max(...parts.map((p) => p.f.modTime)),
      segments: parts.map((p) => p.f.uri),
      parts: parts.map((p) => p.f),
    });
  }

  const saved = new Set<number>();
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

  return [
    ...singles.filter((f) => !saved.has(f.size) && !segSizes.has(f.size)),
    ...grouped.map(({ parts, ...g }) => g),
  ].sort((a, b) => b.modTime - a.modTime);
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
      segmentUris: file.segments,
      liveText: "",
      durationSeconds: 0,
      speakers: [],
      folder: INBOX,
      language: "",
      settings,
    });
    // Only drop the cache copies once the merge has actually landed — until
    // then they're the only complete copy of the audio.
    if (!rec.mergePending) await deleteOrphanAudio([file]);
    return rec;
  }
  return processStop({
    cacheUri: file.uri,
    durationSeconds: 0, // filled in from the transcript
    plannedDurationHours: 0,
    speakers: [],
    folder: INBOX,
    language: "", // empty = let AssemblyAI detect it
    settings,
  });
}

/**
 * Deletes every audio file in the cache — including the recorder's own copies
 * that the listing hides as duplicates. Returns the bytes reclaimed.
 */
export async function clearAllCacheAudio(): Promise<number> {
  const root = FileSystem.cacheDirectory;
  if (!root) return 0;
  const found: CacheAudio[] = [];
  await scan(root, 2, found);
  let freed = 0;
  for (const f of found) {
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

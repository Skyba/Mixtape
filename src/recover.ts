import * as FileSystem from "expo-file-system/legacy";
import { listRecordings, audioPath } from "./recordings";

export type CacheAudio = {
  uri: string;
  size: number;
  modTime: number; // ms
};

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

  const saved = new Set<number>();
  for (const r of await listRecordings()) {
    try {
      const i = await FileSystem.getInfoAsync(audioPath(r));
      if (i.exists && i.size) saved.add(i.size);
    } catch {
      /* missing audio — nothing to match against */
    }
  }
  return found
    .filter((f) => !saved.has(f.size))
    .sort((a, b) => b.modTime - a.modTime);
}

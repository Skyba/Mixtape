import * as FileSystem from "expo-file-system/legacy";
import { INBOX, Recording } from "./types";
import type { Utterance } from "./transcription";

export const ROOT = FileSystem.documentDirectory + "recordings/";
/**
 * Two local layouts. Legacy mirrors the old cloud: {folder}/{base}.{ext}.
 * v2 (after the storage migration) keys everything by id: _v2/{id}/audio.m4a,
 * meta.json, and transcripts under r{N}/ with the sidecar's transcriptLocalRev
 * pointing at the installed revision. Folder and base are then plain fields;
 * a rename or a move touches no file. The layout flag flips once, at the end
 * of localMigration.ts, and every path helper follows it.
 */
export const V2_ROOT = ROOT + "_v2/";
export const V2_MARKER = V2_ROOT + "complete.json";
let layoutV2: boolean | null = null;
export async function detectLayout(): Promise<boolean> {
  if (layoutV2 === null) layoutV2 = (await FileSystem.getInfoAsync(V2_MARKER)).exists;
  return layoutV2;
}
export function setLayoutV2(v: boolean): void { layoutV2 = v; }
export const isLayoutV2 = (): boolean => layoutV2 === true;

function folderDir(folder: string): string {
  return `${ROOT}${folder}/`;
}
/** Directory name for an id: the ISO colons become underscores on disk. */
export const idDirName = (id: string): string => id.replace(/[^A-Za-z0-9._-]/g, "_");
export function idDir(r: Pick<Recording, "id">): string {
  return `${V2_ROOT}${idDirName(r.id)}/`;
}
export function revisionDir(r: Pick<Recording, "id">, rev: number): string {
  return `${idDir(r)}r${rev}/`;
}
export function audioPath(r: Recording): string {
  return isLayoutV2() ? `${idDir(r)}audio.m4a` : `${folderDir(r.folder)}${r.base}.m4a`;
}
export function metaPath(r: Recording): string {
  return isLayoutV2() ? `${idDir(r)}meta.json` : `${folderDir(r.folder)}${r.base}.json`;
}
export function transcriptPath(r: Recording): string {
  if (!isLayoutV2()) return `${folderDir(r.folder)}${r.base}.txt`;
  return `${revisionDir(r, r.transcriptLocalRev ?? 0)}transcript.txt`;
}
export function aaiJsonPath(r: Recording): string {
  if (!isLayoutV2()) return `${folderDir(r.folder)}${r.base}.aai.json`;
  return `${revisionDir(r, r.transcriptLocalRev ?? 0)}utterances.aai.json`;
}

async function ensureDir(dir: string): Promise<void> {
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
}

/** Fill in any missing fields so older/partial metadata can't crash the UI. */
export function normalizeRecording(raw: any): Recording {
  // Spread first, then default the fields that need defaults. This used to
  // enumerate fields, and anything not on the list — tags, private, note,
  // place, mergedInCloud, inputName — was dropped on every read, then written
  // back without by the next writeMeta. A sidecar must round-trip intact.
  return {
    ...raw,
    id: raw.id ?? raw.recordedAt ?? String(raw.base ?? "unknown"),
    base: raw.base ?? "untitled",
    folder: raw.folder ?? INBOX,
    recordedAt: raw.recordedAt ?? new Date(0).toISOString(),
    durationSeconds: raw.durationSeconds ?? 0,
    plannedDurationHours: raw.plannedDurationHours ?? 0,
    speakers: Array.isArray(raw.speakers) ? raw.speakers : [],
    speakerMap: raw.speakerMap ?? undefined,
    language: raw.language ?? "English",
    topic: raw.topic,
    transcriptStatus: raw.transcriptStatus ?? "none",
    uploadStatus: raw.uploadStatus ?? "pending",
    aaiTranscriptId: raw.aaiTranscriptId,
    audioDurationSec: raw.audioDurationSec,
    transcribedAt: raw.transcribedAt,
    estCostUsd: raw.estCostUsd,
    summary: raw.summary,
    shareId: raw.shareId,
    mergePending: raw.mergePending,
  };
}

export async function writeMeta(r: Recording): Promise<void> {
  await ensureDir(isLayoutV2() ? idDir(r) : folderDir(r.folder));
  // Atomic: a crash mid-write must not leave a half sidecar for the lister.
  const tmp = metaPath(r) + ".tmp";
  await FileSystem.writeAsStringAsync(tmp, JSON.stringify(r, null, 2));
  await FileSystem.moveAsync({ from: tmp, to: metaPath(r) });
}

export async function listRecordings(): Promise<Recording[]> {
  await ensureDir(ROOT);
  if (await detectLayout()) return listV2();
  const folders = await FileSystem.readDirectoryAsync(ROOT);
  const out: Recording[] = [];
  for (const folder of folders) {
    if (folder.startsWith("_")) continue;
    const dir = folderDir(folder);
    const info = await FileSystem.getInfoAsync(dir);
    if (!info.exists || !info.isDirectory) continue;
    const files = await FileSystem.readDirectoryAsync(dir);
    for (const f of files) {
      if (!f.endsWith(".json") || f.endsWith(".aai.json")) continue;
      try {
        const raw = await FileSystem.readAsStringAsync(dir + f);
        out.push(normalizeRecording(JSON.parse(raw)));
      } catch {
        /* skip corrupt sidecar */
      }
    }
  }
  return out.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
}

async function listV2(): Promise<Recording[]> {
  await ensureDir(V2_ROOT);
  const dirs = await FileSystem.readDirectoryAsync(V2_ROOT);
  const out: Recording[] = [];
  for (const d of dirs) {
    if (d.startsWith("_") || d === "complete.json" || d === "journal.json") continue;
    try {
      const raw = await FileSystem.readAsStringAsync(`${V2_ROOT}${d}/meta.json`);
      out.push(normalizeRecording(JSON.parse(raw)));
    } catch {
      /* no sidecar yet, or corrupt */
    }
  }
  return out.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
}

/**
 * Returns base, or "base (2)", "base (3)"… — first name with no existing meta.
 * Same-day recordings with the same speakers produce identical bases (cloud
 * mode keeps the provisional name), and an equal base means the same local
 * paths AND the same cloud object paths — the later recording silently
 * overwrote the earlier one. Never reuse a base that already exists.
 */
async function findFreeBase(folder: string, base: string): Promise<string> {
  let candidate = base;
  for (let i = 2; ; i++) {
    const info = await FileSystem.getInfoAsync(
      `${folderDir(folder)}${candidate}.json`
    );
    if (!info.exists) return candidate;
    candidate = `${base} (${i})`;
  }
}

export async function saveNewRecording(
  cacheUri: string,
  base: string,
  meta: Omit<Recording, "base" | "folder">,
  folder: string = INBOX
): Promise<Recording> {
  const r: Recording = {
    ...meta,
    base: isLayoutV2() ? base : await findFreeBase(folder, base),
    folder,
  };
  await ensureDir(isLayoutV2() ? idDir(r) : folderDir(folder));
  await FileSystem.copyAsync({ from: cacheUri, to: audioPath(r) });
  await writeMeta(r);
  return r;
}

async function moveFile(from: string, to: string): Promise<void> {
  const info = await FileSystem.getInfoAsync(from);
  if (info.exists) await FileSystem.moveAsync({ from, to });
}

export async function renameRecording(
  r: Recording,
  newBase: string
): Promise<Recording> {
  if (isLayoutV2()) {
    const next = { ...r, base: newBase };
    await writeMeta(next);
    return next;
  }
  const next: Recording = {
    ...r,
    base: await findFreeBase(r.folder, newBase),
  };
  await moveFile(audioPath(r), audioPath(next));
  await moveFile(transcriptPath(r), transcriptPath(next));
  await moveFile(aaiJsonPath(r), aaiJsonPath(next));
  const oldMeta = metaPath(r);
  await writeMeta(next);
  if (metaPath(next) !== oldMeta) {
    const info = await FileSystem.getInfoAsync(oldMeta);
    if (info.exists) await FileSystem.deleteAsync(oldMeta, { idempotent: true });
  }
  return next;
}

export async function moveToFolder(
  r: Recording,
  folder: string
): Promise<Recording> {
  const next: Recording = { ...r, folder };
  if (isLayoutV2()) {
    await writeMeta(next);
    return next;
  }
  await ensureDir(folderDir(folder));
  // Destination sidecar first: listRecordings discovers recordings through
  // their .json, so the window where neither exists is the window where a
  // crash loses the recording. Write the new one, move the files, and only
  // then remove the old one.
  await writeMeta(next);
  await moveFile(audioPath(r), audioPath(next));
  await moveFile(transcriptPath(r), transcriptPath(next));
  await moveFile(aaiJsonPath(r), aaiJsonPath(next));
  await FileSystem.deleteAsync(metaPath(r), { idempotent: true });
  return next;
}

export async function deleteRecording(r: Recording): Promise<void> {
  if (isLayoutV2()) {
    await FileSystem.deleteAsync(idDir(r), { idempotent: true });
    return;
  }
  for (const p of [
    audioPath(r),
    metaPath(r),
    transcriptPath(r),
    aaiJsonPath(r),
  ]) {
    await FileSystem.deleteAsync(p, { idempotent: true });
  }
}

export async function readTranscript(r: Recording): Promise<string | null> {
  const info = await FileSystem.getInfoAsync(transcriptPath(r));
  if (!info.exists) return null;
  return FileSystem.readAsStringAsync(transcriptPath(r));
}

export async function writeTranscript(
  r: Recording,
  text: string
): Promise<void> {
  if (isLayoutV2()) await ensureDir(revisionDir(r, r.transcriptLocalRev ?? 0));
  await FileSystem.writeAsStringAsync(transcriptPath(r), text);
}

export async function writeAaiJson(
  r: Recording,
  utterances: Utterance[]
): Promise<void> {
  if (isLayoutV2()) await ensureDir(revisionDir(r, r.transcriptLocalRev ?? 0));
  await FileSystem.writeAsStringAsync(
    aaiJsonPath(r),
    JSON.stringify(utterances)
  );
}

export async function readAaiJson(r: Recording): Promise<Utterance[] | null> {
  const info = await FileSystem.getInfoAsync(aaiJsonPath(r));
  if (!info.exists) return null;
  try {
    return JSON.parse(await FileSystem.readAsStringAsync(aaiJsonPath(r)));
  } catch {
    return null;
  }
}

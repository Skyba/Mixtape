import * as FileSystem from "expo-file-system/legacy";
import { INBOX, Recording } from "./types";
import type { Utterance } from "./transcription";

export const ROOT = FileSystem.documentDirectory + "recordings/";

function folderDir(folder: string): string {
  return `${ROOT}${folder}/`;
}
export function audioPath(r: Recording): string {
  return `${folderDir(r.folder)}${r.base}.m4a`;
}
export function metaPath(r: Recording): string {
  return `${folderDir(r.folder)}${r.base}.json`;
}
export function transcriptPath(r: Recording): string {
  return `${folderDir(r.folder)}${r.base}.txt`;
}
export function aaiJsonPath(r: Recording): string {
  return `${folderDir(r.folder)}${r.base}.aai.json`;
}

async function ensureDir(dir: string): Promise<void> {
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
}

/** Fill in any missing fields so older/partial metadata can't crash the UI. */
export function normalizeRecording(raw: any): Recording {
  return {
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
  await ensureDir(folderDir(r.folder));
  await FileSystem.writeAsStringAsync(metaPath(r), JSON.stringify(r, null, 2));
}

export async function listRecordings(): Promise<Recording[]> {
  await ensureDir(ROOT);
  const folders = await FileSystem.readDirectoryAsync(ROOT);
  const out: Recording[] = [];
  for (const folder of folders) {
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

export async function saveNewRecording(
  cacheUri: string,
  base: string,
  meta: Omit<Recording, "base" | "folder">,
  folder: string = INBOX
): Promise<Recording> {
  const r: Recording = { ...meta, base, folder };
  await ensureDir(folderDir(folder));
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
  const next: Recording = { ...r, base: newBase };
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
  await ensureDir(folderDir(folder));
  await moveFile(audioPath(r), audioPath(next));
  await moveFile(transcriptPath(r), transcriptPath(next));
  await moveFile(aaiJsonPath(r), aaiJsonPath(next));
  await FileSystem.deleteAsync(metaPath(r), { idempotent: true });
  await writeMeta(next);
  return next;
}

export async function deleteRecording(r: Recording): Promise<void> {
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
  await FileSystem.writeAsStringAsync(transcriptPath(r), text);
}

export async function writeAaiJson(
  r: Recording,
  utterances: Utterance[]
): Promise<void> {
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

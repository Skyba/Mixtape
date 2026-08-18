import { INBOX, Recording, Settings } from "./types";
import {
  audioPath,
  transcriptPath,
  aaiJsonPath,
  listRecordings,
  renameRecording,
  saveNewRecording,
  writeMeta,
  writeTranscript,
  writeAaiJson,
} from "./recordings";
import { rememberSpeakers, rememberFolder } from "./storage";
import {
  transcribe,
  transcribeFromUrl,
  inferTopic,
  inferSpeakerMap,
  renderTranscript,
  AAI_RATE_PER_HOUR,
  TranscribeResult,
} from "./transcription";
import { canUploadNow } from "./network";
import {
  isFirebaseConfigured,
  isSignedIn,
  uploadRecording,
  uploadToPath,
  mergeAudioSegments,
  downloadRemoteFile,
  deleteRemoteRecording,
  downloadUrlForPath,
  remoteObjectPath,
  fetchRemoteMeta,
  liveSegmentPath,
  liveMergedPath,
  uploadDebugLog,
} from "./firebase";
import { notify } from "./notifications";
import { logEvent, getLogText } from "./log";
import * as FileSystem from "expo-file-system/legacy";

/** Pushes the local log buffer to the cloud so recent events are pullable. */
async function flushLog(): Promise<void> {
  try {
    await uploadDebugLog(await getLogText());
  } catch {
    /* best-effort */
  }
}

// Ids of recordings whose transcription is running right now, so the
// foreground/launch retry never double-transcribes one that's already in flight.
const activeTranscriptions = new Set<string>();
let retryInFlight = false;

// Set while the recorder is running. The in-progress take lives in the cache
// directory like any other, so the cache tools must not offer to delete it.
let recording = false;
export function setRecordingInProgress(v: boolean): void {
  recording = v;
}
export function isRecordingInProgress(): boolean {
  return recording;
}
// "error" recordings retried at most once per app session (avoid loops on a
// genuinely bad file), unlike "pending" which retries every foreground.
const erroredRetried = new Set<string>();

/**
 * Transcribes a recording, preferring to let AssemblyAI fetch the audio straight
 * from its cloud URL (no giant phone→AAI re-upload, which corrupted large files).
 * Falls back to uploading the local file when it isn't in the cloud.
 */
async function runTranscribe(
  rec: Recording,
  settings: Settings
): Promise<TranscribeResult> {
  if (isFirebaseConfigured && isSignedIn()) {
    try {
      const url = await downloadUrlForPath(remoteObjectPath(rec, "m4a"));
      return await transcribeFromUrl(url, rec, settings);
    } catch (e: any) {
      logEvent(`cloud-url transcribe unavailable, using local: ${String(e?.message ?? e)}`);
    }
  }
  return transcribe(audioPath(rec), rec, settings);
}

function speakersLabel(speakers: string[]): string {
  if (speakers.length === 0) return "notes";
  const named = speakers.filter((s) => !/^Speaker \d+$/.test(s));
  if (named.length >= 1 && named.length <= 2) return named.join(" & ");
  return `${speakers.length} speakers`;
}

function sanitize(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim();
}

function buildBase(
  recordedAt: string,
  speakers: string[],
  topic: string
): string {
  const date = recordedAt.slice(0, 10);
  return sanitize(`${date} ${speakersLabel(speakers)} - ${topic || "untitled"}`);
}

async function tryUpload(r: Recording, settings: Settings): Promise<Recording> {
  if (!isFirebaseConfigured) return { ...r, uploadStatus: "skipped" };
  if (!isSignedIn()) return { ...r, uploadStatus: "pending" };
  if (!(await canUploadNow(settings))) return { ...r, uploadStatus: "pending" };
  try {
    await uploadRecording(r);
    return { ...r, uploadStatus: "uploaded" };
  } catch {
    return { ...r, uploadStatus: "pending" };
  }
}

export type StopArgs = {
  cacheUri: string;
  durationSeconds: number;
  plannedDurationHours: number;
  speakers: string[];
  folder: string;
  language: string;
  settings: Settings;
};

export async function processStop(args: StopArgs): Promise<Recording> {
  const recordedAt = new Date().toISOString();
  const id = recordedAt;
  await rememberSpeakers(
    args.speakers.filter((s) => !/^Speaker \d+$/.test(s))
  );
  await rememberFolder(args.folder);

  let srcSize = 0;
  try {
    const i = await FileSystem.getInfoAsync(args.cacheUri);
    if (i.exists) srcSize = i.size ?? 0;
  } catch {}
  logEvent(`processStop begin dur=${args.durationSeconds}s cacheSize=${srcSize}`);

  const provisionalBase = buildBase(recordedAt, args.speakers, "untitled");
  let rec = await saveNewRecording(
    args.cacheUri,
    provisionalBase,
    {
      id,
      recordedAt,
      durationSeconds: args.durationSeconds,
      plannedDurationHours: args.plannedDurationHours,
      speakers: args.speakers,
      language: args.language,
      transcriptStatus: "none",
      uploadStatus: "pending",
    },
    args.folder
  );
  logEvent(`saved local ${rec.base}`);
  await notify("Recording saved", `${rec.base} (${rec.folder})`);

  const cloudMode = isFirebaseConfigured && isSignedIn();
  const hasSpeakers = args.speakers.length > 0;

  // Cloud mode: upload with "pending" and let the backend transcribe with the
  // screen off. pullCloudTranscripts brings the finished transcript back — no
  // on-device AAI call that would stall while the app is backgrounded.
  if (hasSpeakers && cloudMode) {
    rec = { ...rec, transcriptStatus: "pending" };
    await writeMeta(rec);
    rec = await tryUpload(rec, args.settings);
    await writeMeta(rec);
    await notify(
      rec.uploadStatus === "uploaded"
        ? "Uploaded — transcribing on the server…"
        : "Saved — will transcribe once uploaded",
      rec.base
    );
    logEvent(`processStop done (cloud) upload=${rec.uploadStatus} transcript=pending`);
    await flushLog();
    return rec;
  }

  // Offline / not signed in: transcribe on-device (existing path).
  const eligible = hasSpeakers && !!args.settings.assemblyAiKey;
  if (eligible) {
    rec = { ...rec, transcriptStatus: "pending" };
    await writeMeta(rec);
    await notify("Transcribing…", rec.base);
    activeTranscriptions.add(id);
    try {
      const { text, transcriptId, audioDurationSec, utterances } =
        await runTranscribe(rec, args.settings);
      const speakerMap = await inferSpeakerMap(
        utterances,
        args.speakers,
        args.settings
      );
      const rendered = speakerMap
        ? renderTranscript(utterances, args.speakers, speakerMap)
        : text;
      await writeTranscript(rec, rendered);
      await writeAaiJson(rec, utterances);
      const topic = await inferTopic(rendered, args.settings);
      rec = {
        ...rec,
        topic,
        speakerMap,
        transcriptStatus: "done",
        aaiTranscriptId: transcriptId,
        audioDurationSec,
        transcribedAt: new Date().toISOString(),
        estCostUsd: (audioDurationSec / 3600) * AAI_RATE_PER_HOUR,
      };
      const finalBase = buildBase(recordedAt, args.speakers, topic);
      if (finalBase !== rec.base) rec = await renameRecording(rec, finalBase);
      else await writeMeta(rec);
      await notify("Transcript ready", rec.base);
    } catch (e: any) {
      rec = { ...rec, transcriptStatus: "error" };
      await writeMeta(rec);
      await notify("Transcription failed", String(e?.message ?? e));
    } finally {
      activeTranscriptions.delete(id);
    }
  }

  rec = await tryUpload(rec, args.settings);
  await writeMeta(rec);
  logEvent(`processStop done upload=${rec.uploadStatus} transcript=${rec.transcriptStatus}`);
  await flushLog();
  return rec;
}

export async function transcribeExisting(
  rec: Recording,
  settings: Settings
): Promise<Recording> {
  activeTranscriptions.add(rec.id);
  const oldBase = rec.base;
  try {
    let r: Recording = { ...rec, transcriptStatus: "pending" };
    await writeMeta(r);
    const { text, transcriptId, audioDurationSec, utterances } =
      await runTranscribe(r, settings);
    const speakerMap = await inferSpeakerMap(utterances, r.speakers, settings);
    const rendered = speakerMap
      ? renderTranscript(utterances, r.speakers, speakerMap)
      : text;
    await writeTranscript(r, rendered);
    await writeAaiJson(r, utterances);
    const topic = await inferTopic(rendered, settings);
    r = {
      ...r,
      topic,
      speakerMap: speakerMap ?? r.speakerMap,
      transcriptStatus: "done",
      aaiTranscriptId: transcriptId,
      audioDurationSec,
      transcribedAt: new Date().toISOString(),
      estCostUsd: (audioDurationSec / 3600) * AAI_RATE_PER_HOUR,
    };
    const finalBase = buildBase(r.recordedAt, r.speakers, topic);
    if (finalBase !== r.base) r = await renameRecording(r, finalBase);
    else await writeMeta(r);
    r = await tryUpload(r, settings);
    await writeMeta(r);
    // The recording was already in the cloud under its old name; drop that copy
    // so a re-transcribe rename doesn't leave a stale duplicate behind.
    if (oldBase !== r.base && isFirebaseConfigured && isSignedIn()) {
      try {
        await deleteRemoteRecording({ ...r, base: oldBase });
      } catch {}
    }
    await notify("Transcript ready", r.base);
    return r;
  } finally {
    activeTranscriptions.delete(rec.id);
  }
}

export type LiveStopArgs = {
  segmentUris: string[]; // local segment files, in order
  liveText: string; // assembled plain-text transcript (no speakers)
  durationSeconds: number;
  speakers: string[];
  folder: string;
  language: string;
  settings: Settings;
  shareId?: string; // if live-shared, carry it onto the saved recording
};

/**
 * Saves a live (segmented) recording: merges segment audio in the cloud into one
 * file, stores the assembled transcript. Falls back to the first segment if the
 * merge can't run (signed out / offline). The merged file can be re-transcribed
 * later for accurate cross-segment diarization.
 */
export async function processStopLive(args: LiveStopArgs): Promise<Recording> {
  const recordedAt = new Date().toISOString();
  const id = recordedAt;
  await rememberSpeakers(
    args.speakers.filter((s) => !/^Speaker \d+$/.test(s))
  );
  await rememberFolder(args.folder);
  const base = buildBase(recordedAt, args.speakers, "live notes");
  logEvent(
    `live stop id=${id} segments=${args.segmentUris.length} dur=${args.durationSeconds}s signed=${isSignedIn()}`
  );

  const cloudMerge =
    isFirebaseConfigured && isSignedIn() && args.segmentUris.length > 1;
  const hasTranscript = !!args.liveText.trim();

  // Save FIRST, from the first segment. Uploading 200+ segments and waiting on
  // the cloud merge takes minutes, and doing that before the save meant an app
  // kill anywhere in there lost the entire recording — no library entry, no
  // transcript, just orphaned segments in the cache. Now the entry always
  // exists and the audio is upgraded in place once the merge lands.
  let rec = await saveNewRecording(
    args.segmentUris[0],
    base,
    {
      id,
      recordedAt,
      durationSeconds: args.durationSeconds,
      plannedDurationHours: 0,
      speakers: args.speakers,
      language: args.language,
      // live = rough plain text; "error" status nudges a re-transcribe for
      // accurate diarized speakers from the merged file.
      transcriptStatus: hasTranscript ? "done" : "none",
      uploadStatus: "pending",
      shareId: args.shareId,
      mergePending: cloudMerge
        ? { id, count: args.segmentUris.length, segments: args.segmentUris }
        : undefined,
    },
    args.folder
  );

  if (hasTranscript) {
    await writeTranscript(rec, args.liveText);
    await writeMeta(rec);
  }

  if (cloudMerge) {
    try {
      // The segments ARE the audio — once uploaded they're safe in the cloud
      // even if the merge itself fails.
      const remote: string[] = [];
      for (let i = 0; i < args.segmentUris.length; i++) {
        const p = liveSegmentPath(id, i);
        await uploadToPath(args.segmentUris[i], p);
        remote.push(p);
      }
      logEvent(`uploaded ${remote.length} segments, merging…`);
      await mergeAudioSegments(remote, liveMergedPath(id));
      const local = `${FileSystem.cacheDirectory}merged_${id}.m4a`;
      if (await downloadRemoteFile(liveMergedPath(id), local)) {
        await FileSystem.copyAsync({ from: local, to: audioPath(rec) });
        rec = { ...rec, mergePending: undefined };
        await writeMeta(rec);
        logEvent("merge ok, downloaded merged file");
      } else {
        logEvent("merge done but download failed → mergePending");
      }
    } catch (e: any) {
      // Recoverable: retryPendingMerges finishes this on the next launch.
      logEvent(`merge ERROR → mergePending: ${String(e?.message ?? e)}`);
    }
  }

  rec = await tryUpload(rec, args.settings);
  await writeMeta(rec);
  await notify(
    rec.mergePending ? "Saved — finishing audio…" : "Live recording saved",
    rec.base
  );
  await flushLog();
  return rec;
}

/** Re-merges any live recordings whose cloud merge didn't complete. */
export async function retryPendingMerges(settings: Settings): Promise<number> {
  if (!isFirebaseConfigured || !isSignedIn()) return 0;
  const all = await listRecordings();
  let fixed = 0;
  for (const r of all.filter((x) => x.mergePending)) {
    const mp = r.mergePending!;
    try {
      const remote = Array.from({ length: mp.count }, (_, i) =>
        liveSegmentPath(mp.id, i)
      );
      try {
        await mergeAudioSegments(remote, liveMergedPath(mp.id));
      } catch (e) {
        // The upload can now be interrupted (the recording is saved before it
        // runs), leaving gaps the merge chokes on. Push the local copies again.
        if (!mp.segments) throw e;
        logEvent(`merge failed, re-uploading ${mp.segments.length} segments`);
        for (let i = 0; i < mp.segments.length; i++) {
          const info = await FileSystem.getInfoAsync(mp.segments[i]);
          if (info.exists) await uploadToPath(mp.segments[i], liveSegmentPath(mp.id, i));
        }
        await mergeAudioSegments(remote, liveMergedPath(mp.id));
      }
      const local = `${FileSystem.cacheDirectory}merged_${mp.id}.m4a`;
      if (await downloadRemoteFile(liveMergedPath(mp.id), local)) {
        await FileSystem.copyAsync({ from: local, to: audioPath(r) });
        const next: Recording = { ...r, mergePending: undefined };
        await writeMeta(next);
        await tryUpload(next, settings);
        await writeMeta(next);
        fixed++;
        logEvent(`recovered merge for ${r.base}`);
      }
    } catch (e: any) {
      logEvent(`retry merge failed ${r.base}: ${String(e?.message ?? e)}`);
    }
  }
  return fixed;
}

/**
 * Re-runs transcription for recordings stuck on "pending" — e.g. the app was
 * closed before AssemblyAI finished a long job. Nothing else recovers these.
 * Marks "error" on failure so a genuinely-bad file can't retry-loop forever.
 */
export async function retryPendingTranscriptions(
  settings: Settings
): Promise<number> {
  // Cloud mode: the backend transcribes and pullCloudTranscripts collects the
  // result, so on-device retry would double-transcribe. Only fall back to
  // local transcription when there's no cloud (offline / signed out).
  if (isFirebaseConfigured && isSignedIn()) return 0;
  if (retryInFlight || !settings.assemblyAiKey) return 0;
  retryInFlight = true;
  try {
    const all = await listRecordings();
    let n = 0;
    for (const r of all.filter(
      (x) =>
        (x.transcriptStatus === "pending" || x.transcriptStatus === "error") &&
        x.speakers.length > 0
    )) {
      if (activeTranscriptions.has(r.id)) continue; // already transcribing
      if (r.transcriptStatus === "error") {
        if (erroredRetried.has(r.id)) continue; // retry a bad one once per session
        erroredRetried.add(r.id);
      }
      const info = await FileSystem.getInfoAsync(audioPath(r));
      // Cloud-URL transcription doesn't need the local file; only skip if it's
      // neither on this device nor reachable in the cloud.
      if (!info.exists && !(isFirebaseConfigured && isSignedIn())) continue;
      try {
        logEvent(`retry transcription ${r.base} dur=${r.durationSeconds}s`);
        await transcribeExisting(r, settings);
        n++;
      } catch (e: any) {
        await writeMeta({ ...r, transcriptStatus: "error" });
        logEvent(`retry transcription failed ${r.base}: ${String(e?.message ?? e)}`);
      }
    }
    if (n) await flushLog();
    return n;
  } finally {
    retryInFlight = false;
  }
}

export async function flushPendingUploads(settings: Settings): Promise<number> {
  if (!isFirebaseConfigured || !isSignedIn()) return 0;
  if (!(await canUploadNow(settings))) return 0;
  const all = await listRecordings();
  let n = 0;
  for (const r of all.filter((x) => x.uploadStatus === "pending")) {
    try {
      await uploadRecording(r);
      await writeMeta({ ...r, uploadStatus: "uploaded" });
      n++;
    } catch {
      /* keep pending */
    }
  }
  return n;
}

/**
 * Cloud mode: pulls transcripts the backend produced while the app was closed.
 * For each local recording still "pending"/"processing", reads the cloud meta;
 * when the server marks it "done", downloads the transcript + utterances and
 * updates the local copy. This is what makes server-side transcription show up
 * in the app without keeping it open.
 */
export async function pullCloudTranscripts(settings: Settings): Promise<number> {
  if (!isFirebaseConfigured || !isSignedIn()) return 0;
  const all = await listRecordings();
  let n = 0;
  for (const r of all.filter(
    (x) => x.transcriptStatus === "pending" || x.transcriptStatus === "processing"
  )) {
    try {
      const remote = await fetchRemoteMeta(remoteObjectPath(r, "json"));
      if (remote.transcriptStatus === "done") {
        await downloadRemoteFile(remoteObjectPath(r, "txt"), transcriptPath(r));
        await downloadRemoteFile(remoteObjectPath(r, "aai.json"), aaiJsonPath(r));
        await writeMeta({
          ...r,
          transcriptStatus: "done",
          // A cap-stopped take can save 0 locally; the server backfills the
          // true duration from AssemblyAI — bring it down with the transcript.
          durationSeconds: r.durationSeconds || remote.durationSeconds || 0,
          speakerMap: remote.speakerMap ?? r.speakerMap,
          topic: remote.topic ?? r.topic,
          aaiTranscriptId: remote.aaiTranscriptId ?? r.aaiTranscriptId,
          audioDurationSec: remote.audioDurationSec ?? r.audioDurationSec,
          transcribedAt: remote.transcribedAt ?? r.transcribedAt,
          estCostUsd: remote.estCostUsd ?? r.estCostUsd,
        });
        n++;
        logEvent(`pulled cloud transcript ${r.base}`);
      } else if (remote.transcriptStatus === "error") {
        await writeMeta({ ...r, transcriptStatus: "error" });
      } else if (
        remote.transcriptStatus === "processing" &&
        r.transcriptStatus === "pending"
      ) {
        await writeMeta({ ...r, transcriptStatus: "processing" });
      }
    } catch {
      /* remote meta not ready yet — try again next time */
    }
  }
  if (n) await flushLog();
  return n;
}

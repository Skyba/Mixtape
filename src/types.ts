export type TranscriptStatus = "none" | "pending" | "processing" | "done" | "error";
export type UploadStatus = "pending" | "uploaded" | "skipped";

export type Recording = {
  id: string; // stable, never changes (original timestamp)
  base: string; // current filename base (no extension); may change after topic rename
  folder: string; // "Inbox" by default
  recordedAt: string; // ISO
  durationSeconds: number;
  plannedDurationHours: number;
  speakers: string[];
  speakerMap?: Record<string, string>; // AAI letter (A/B/…) -> display name
  language: string;
  topic?: string;
  transcriptStatus: TranscriptStatus;
  uploadStatus: UploadStatus;
  aaiTranscriptId?: string;
  audioDurationSec?: number; // reported by AssemblyAI
  transcribedAt?: string; // ISO
  estCostUsd?: number; // estimated, audioDuration * rate
  summary?: string; // last AI summary output
  shareId?: string; // set when published to a public link
  // live segments awaiting cloud merge. `segments` are the local cache files,
  // kept so the merge can be retried even if their upload was interrupted.
  mergePending?: { id: string; count: number; segments?: string[] };
  // Recorder killed before it could finalise the file: audio bytes present, no
  // MP4 index, so it won't play or transcribe until it's repaired.
  damaged?: boolean;
  // Filing hints for the transcript archive (comm-relay). All optional: left
  // unset, the archive behaves exactly as it did before they existed.
  private?: boolean;
  tags?: string[];
};

export type Settings = {
  assemblyAiKey: string;
  anthropicKey: string;
  topicModel: string;
  uploadOnCellular: boolean; // false = Wi-Fi only
  googleWebClientId: string; // OAuth 2.0 Web client ID (Google Cloud Console)
};

export const DEFAULT_SETTINGS: Settings = {
  assemblyAiKey: "",
  anthropicKey: "",
  topicModel: "claude-3-5-haiku-latest",
  uploadOnCellular: false,
  googleWebClientId: "",
};

export const INBOX = "Inbox";

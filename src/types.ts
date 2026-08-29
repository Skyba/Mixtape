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
  // Copied from Settings at save time: the backend transcribes without
  // access to the app's settings, and speaker identification wants it.
  owner?: { name: string; bio: string };
};

export type Settings = {
  assemblyAiKey: string;
  anthropicKey: string;
  topicModel: string;
  // Who the phone belongs to. Fed to AssemblyAI's speaker identification so
  // it can tell which voice is yours when the conversation gives it away.
  ownerName: string;
  ownerBio: string;
  uploadOnCellular: boolean; // false = Wi-Fi only
  googleWebClientId: string; // OAuth 2.0 Web client ID (Google Cloud Console)
};

export const DEFAULT_SETTINGS: Settings = {
  assemblyAiKey: "",
  anthropicKey: "",
  topicModel: "claude-3-5-haiku-latest",
  ownerName: "",
  ownerBio: "",
  uploadOnCellular: false,
  googleWebClientId: "",
};

export const INBOX = "Inbox";

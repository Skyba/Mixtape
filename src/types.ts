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
  // The cloud object is the merged recording and the local file may still be
  // the first segment the entry was saved from. Anything uploading this
  // recording must leave the audio alone, or it replaces hours with minutes.
  mergedInCloud?: boolean;
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
  /** ISO date of the enrolled voice sample, or "" if never recorded. */
  voiceEnrolledAt: string;
  uploadOnCellular: boolean; // false = Wi-Fi only
  /**
   * true  = one continuous file, capped natively. Survives the screen locking
   *         and the app being backgrounded, because nothing in JS has to run
   *         for the recording to continue. A process kill loses the take.
   * false = 3-minute chunks. A kill costs one chunk, but the roll is a JS
   *         timer and React Native suspends those when the activity is
   *         backgrounded: the native cap then stops the recorder and nothing
   *         restarts it, so a screen-off session keeps only its first chunk.
   */
  singleFileRecording: boolean;
  googleWebClientId: string; // OAuth 2.0 Web client ID (Google Cloud Console)
};

export const DEFAULT_SETTINGS: Settings = {
  assemblyAiKey: "",
  anthropicKey: "",
  topicModel: "claude-3-5-haiku-latest",
  ownerName: "",
  ownerBio: "",
  voiceEnrolledAt: "",
  uploadOnCellular: false,
  singleFileRecording: true,
  googleWebClientId: "",
};

export const INBOX = "Inbox";

export type TranscriptStatus = "none" | "pending" | "processing" | "done" | "error";
export type UploadStatus = "pending" | "uploaded" | "skipped";

/**
 * Matches comm-relay's speaker_id_by vocabulary ($DOTFILES/docs/transcription.md):
 * "user" is any human — phone or Mac — "ai-review" is a dedicated review pass
 * (the Mac batch, voiceprint), "channel" is hardware separation.
 */
export type LabelSource = "user" | "auto" | "ai-review" | "channel" | "voiceprint" | "claude" | "aai" | "none";
/** `at` is null for a pre-provenance label: no one knows when it was made. */
export type SpeakerLabel = {
  name: string; by: LabelSource; at: string | null;
  /** Why the name was given, in words: "voice 72%", "AI: answered when called Basile". */
  evidence?: string;
  /** The review suggests this short voice is a split of the named one. */
  merge?: boolean;
};
/** The fields that sync both ways between the phone and the Mac. */
export type SyncedField =
  | "folder"
  | "speakers"
  | "speakerLabels"
  | "speakerId"
  | "meIncluded"
  | "tags"
  | "private"
  | "note"
  | "topic"
  | "place"
  | "inputName"
  | "language"
  | "shareId"
  | "base"
  | "reviewFlag"
  | "folderSuggestion";

export type Recording = {
  id: string; // stable, never changes (original timestamp)
  base: string; // current filename base (no extension); may change after topic rename
  folder: string; // "Inbox" by default
  recordedAt: string; // ISO
  durationSeconds: number;
  plannedDurationHours: number;
  speakers: string[];
  // Legacy view: letter -> name only. Kept for every reader that predates
  // provenance; always derived from speakerLabels when that exists.
  speakerMap?: Record<string, string>; // AAI letter (A/B/…) -> display name
  /**
   * Letter -> who it is and who said so. `by` is what makes a label
   * trustworthy: "user" is a human confirming — on the phone or the Mac —
   * "ai-review" is the Mac's batch pass, "voiceprint"/"claude"/"aai" are
   * single automatic signals. A recording is usually
   * partial — A confirmed, C guessed — and this is the only place that
   * distinction lives.
   */
  speakerLabels?: Record<string, SpeakerLabel>;
  /** The letter that is the owner. Set when known; absent when undecided. */
  speakerId?: string;
  /**
   * Answered at record time: is the owner one of the voices? "no" is a real
   * answer (a conference, someone else's meeting), not a missing one. Absent
   * means never asked. One of the two fields that turn a recording green.
   */
  meIncluded?: "yes" | "no";
  /**
   * Per-field edit times, ISO. Phone and Mac both edit these; on sync the
   * newer value wins per field, so a Mac batch cannot silently revert a hand
   * edit made since, and vice versa.
   */
  fieldsUpdatedAt?: Record<string, string>;
  /**
   * Bumped by the server each time a transcription is submitted. A letter
   * edit names the revision it was made against and is refused if the
   * recording has been re-run since — the letters may now be other voices.
   */
  transcriptRevision?: number;
  /** v2 layout: which revision's transcript files are installed locally. */
  transcriptLocalRev?: number;
  /** v2: the server document exists (createRecording acknowledged). */
  remoteCreated?: boolean;
  /** v2: an audio object with other bytes already owns this id. */
  audioConflict?: boolean;
  /**
   * Set by the Mac review when its signals disagree about who a speaker is;
   * cleared (null) when a person confirms the speakers. Drives the red row.
   */
  reviewFlag?: { reason: string; at: string } | null;
  /** A folder the Mac classifier proposes for an Inbox recording; yellow
   *  until accepted (which sets folder and clears this). */
  folderSuggestion?: { folder: string; why: string; at: string } | null;
  /** The speaker keys of the current transcript (set by the server when it
   *  publishes, cached by the phone when it reads utterances), so colours are
   *  computed over the voices that exist now, not labels left from a re-run. */
  speakerKeys?: string[];
  /** v2: a server operation sent but not yet acknowledged (re-transcribe). */
  pendingOp?: string;
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
  /** Where the take started. Absent whenever a fix was not available. */
  place?: { lat: number; lon: number; city?: string; region?: string };
  /**
   * Free text typed by whoever pressed record — "tyler explaining his work".
   * Carried through the API so the archive can put it in frontmatter: it is
   * context no transcript contains and no model can infer.
   */
  note?: string;
  /** The input the take was recorded on, as Android named it. */
  inputName?: string;
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

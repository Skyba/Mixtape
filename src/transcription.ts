import * as FileSystem from "expo-file-system/legacy";
import { Recording, Settings } from "./types";

const AAI = "https://api.assemblyai.com/v2";

// Estimate only — AssemblyAI's API returns duration, not a price.
// ~$0.12/hr for async transcription with speaker labels (Universal model).
export const AAI_RATE_PER_HOUR = 0.12;

const LANG_CODES: Record<string, string> = {
  English: "en",
  French: "fr",
  Spanish: "es",
  Arabic: "ar",
};

export type Utterance = {
  speaker: string;
  start: number;
  end?: number;
  text: string;
};

function mmss(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** Resolves an AssemblyAI speaker letter (A/B/…) to a display name. */
export function nameForSpeaker(
  letter: string,
  speakers: string[],
  speakerMap?: Record<string, string>
): string {
  if (speakerMap?.[letter]) return speakerMap[letter];
  const idx = letter.charCodeAt(0) - 65; // "A" -> 0
  if (idx >= 0 && idx < speakers.length) return speakers[idx];
  return `Speaker ${letter}`;
}

/** Renders the labelled transcript text from utterances + a speaker→name map. */
export function renderTranscript(
  utterances: Utterance[],
  speakers: string[],
  speakerMap?: Record<string, string>
): string {
  return utterances
    .map(
      (u) =>
        `[${mmss(u.start)}] ${nameForSpeaker(u.speaker, speakers, speakerMap)}: ${u.text}`
    )
    .join("\n\n");
}

type CompletedTranscript = {
  utterances?: Utterance[];
  audio_duration?: number;
  text?: string;
};

async function poll(id: string, key: string): Promise<CompletedTranscript> {
  // ~60 min ceiling so long recordings (which AAI processes slower) don't
  // time out mid-job.
  for (let i = 0; i < 450; i++) {
    const res = await fetch(`${AAI}/transcript/${id}`, {
      headers: { authorization: key },
    });
    const data = await res.json();
    if (data.status === "completed") return data as CompletedTranscript;
    if (data.status === "error")
      throw new Error(data.error ?? "Transcription failed");
    await new Promise((r) => setTimeout(r, 8000));
  }
  throw new Error("Transcription timed out");
}

export type TranscribeResult = {
  text: string;
  transcriptId: string;
  audioDurationSec: number;
  utterances: Utterance[];
};

/** Kicks off a transcript job from an already-hosted URL and polls it. */
async function transcribeUrl(
  audioUrl: string,
  rec: Recording,
  settings: Settings
): Promise<TranscribeResult> {
  const langCode = LANG_CODES[rec.language];
  const body: Record<string, unknown> = {
    audio_url: audioUrl,
    speaker_labels: true,
  };
  if (langCode) body.language_code = langCode;
  else body.language_detection = true;

  const create = await fetch(`${AAI}/transcript`, {
    method: "POST",
    headers: {
      authorization: settings.assemblyAiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const { id } = await create.json();
  const data = await poll(id, settings.assemblyAiKey);
  const utterances = data.utterances ?? [];
  return {
    text: renderTranscript(utterances, rec.speakers, rec.speakerMap),
    transcriptId: id,
    audioDurationSec: data.audio_duration ?? rec.durationSeconds,
    utterances,
  };
}

/**
 * Transcribes audio already hosted at a URL (e.g. a Firebase download URL) —
 * AssemblyAI fetches it directly, so we don't re-upload the whole file from the
 * phone (which was corrupting large recordings → "Transcoding failed").
 */
export async function transcribeFromUrl(
  audioUrl: string,
  rec: Recording,
  settings: Settings
): Promise<TranscribeResult> {
  if (!settings.assemblyAiKey) throw new Error("AssemblyAI key not set");
  return transcribeUrl(audioUrl, rec, settings);
}

/** Uploads local audio to AssemblyAI, transcribes with speaker labels. */
export async function transcribe(
  audioUri: string,
  rec: Recording,
  settings: Settings
): Promise<TranscribeResult> {
  if (!settings.assemblyAiKey) throw new Error("AssemblyAI key not set");
  const up = await FileSystem.uploadAsync(`${AAI}/upload`, audioUri, {
    httpMethod: "POST",
    headers: { authorization: settings.assemblyAiKey },
    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
  });
  const uploadUrl = JSON.parse(up.body).upload_url as string;
  return transcribeUrl(uploadUrl, rec, settings);
}

/**
 * Transcribes one short live segment to PLAIN TEXT (no speaker labels).
 * Per-chunk diarization is unreliable and can't align across chunks, so live
 * mode shows plain text; accurate speakers come from the final batch pass.
 */
export async function transcribeClipText(
  audioUri: string,
  language: string,
  settings: Settings
): Promise<string> {
  if (!settings.assemblyAiKey) throw new Error("AssemblyAI key not set");
  const up = await FileSystem.uploadAsync(`${AAI}/upload`, audioUri, {
    httpMethod: "POST",
    headers: { authorization: settings.assemblyAiKey },
    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
  });
  const uploadUrl = JSON.parse(up.body).upload_url as string;
  const langCode = LANG_CODES[language];
  const body: Record<string, unknown> = { audio_url: uploadUrl };
  if (langCode) body.language_code = langCode;
  else body.language_detection = true;
  const create = await fetch(`${AAI}/transcript`, {
    method: "POST",
    headers: {
      authorization: settings.assemblyAiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const { id } = await create.json();
  const data = await poll(id, settings.assemblyAiKey);
  return data.text ?? "";
}

/**
 * Diarizes audio already hosted at a URL (e.g. a Firebase download URL) without
 * re-uploading. Used by live diarization passes on the merged segments so far.
 */
export async function diarizeFromUrl(
  audioUrl: string,
  language: string,
  settings: Settings
): Promise<{ utterances: Utterance[]; audioDurationSec: number }> {
  if (!settings.assemblyAiKey) throw new Error("AssemblyAI key not set");
  const langCode = LANG_CODES[language];
  const body: Record<string, unknown> = {
    audio_url: audioUrl,
    speaker_labels: true,
  };
  if (langCode) body.language_code = langCode;
  else body.language_detection = true;
  const create = await fetch(`${AAI}/transcript`, {
    method: "POST",
    headers: {
      authorization: settings.assemblyAiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const { id } = await create.json();
  const data = await poll(id, settings.assemblyAiKey);
  return {
    utterances: data.utterances ?? [],
    audioDurationSec: data.audio_duration ?? 0,
  };
}

/**
 * Maps AssemblyAI's anonymous speaker letters (A/B/…) to the participant names
 * by reading the content — self-introductions ("I'm X"), how people address each
 * other, etc. Fixes the arbitrary order-based guess (AAI "A" ≠ first-typed name).
 * Returns a { A: name, B: name } map, or undefined if it can't tell.
 */
export async function inferSpeakerMap(
  utterances: Utterance[],
  speakers: string[],
  settings: Settings
): Promise<Record<string, string> | undefined> {
  if (!settings.anthropicKey || !utterances.length) return undefined;
  const named = speakers.filter((s) => !/^Speaker \d+$/.test(s));
  if (named.length < 1) return undefined;
  const letters = [...new Set(utterances.map((u) => u.speaker))];
  if (letters.length < 2) return undefined; // one speaker: nothing to disambiguate
  const sample = utterances
    .slice(0, 40)
    .map((u) => `${u.speaker}: ${u.text}`)
    .join("\n")
    .slice(0, 4000);
  const prompt =
    `A meeting transcript is labeled by anonymous speaker letters (${letters.join(", ")}). ` +
    `The participants are: ${named.join(", ")}.\n` +
    `Using ONLY the content — especially self-introductions ("I'm X", "This is X") and how ` +
    `people address each other by name — map each speaker letter to the correct participant. ` +
    `Output ONLY a JSON object like {"A":"Name","B":"Name"}. Omit any letter whose identity is unclear.\n\n` +
    `Transcript:\n${sample}`;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": settings.anthropicKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: settings.topicModel,
        max_tokens: 200,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await res.json();
    const raw: string = data?.content?.[0]?.text ?? "";
    const json = raw.match(/\{[\s\S]*\}/)?.[0];
    if (!json) return undefined;
    const parsed = JSON.parse(json) as Record<string, string>;
    const clean: Record<string, string> = {};
    for (const [letter, name] of Object.entries(parsed)) {
      if (named.includes(name)) clean[letter] = name;
    }
    return Object.keys(clean).length ? clean : undefined;
  } catch {
    return undefined;
  }
}

/** Runs a custom prompt against a transcript via Claude. Returns the output. */
export async function summarize(
  transcript: string,
  prompt: string,
  settings: Settings
): Promise<string> {
  if (!settings.anthropicKey) throw new Error("Anthropic key not set");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": settings.anthropicKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: settings.topicModel,
      max_tokens: 2048,
      messages: [
        {
          role: "user",
          content: `${prompt}\n\n--- TRANSCRIPT ---\n${transcript.slice(0, 100000)}`,
        },
      ],
    }),
  });
  const data = await res.json();
  if (data?.error) throw new Error(data.error?.message ?? "Summary failed");
  return data?.content?.[0]?.text ?? "";
}

/** Asks Claude Haiku for a short filename-safe topic. Returns "" on failure. */
export async function inferTopic(
  transcript: string,
  settings: Settings
): Promise<string> {
  if (!settings.anthropicKey || !transcript.trim()) return "";
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": settings.anthropicKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: settings.topicModel,
        max_tokens: 24,
        messages: [
          {
            role: "user",
            content:
              "Give a 2-5 word topic title for this meeting transcript. " +
              "Output only the title, no quotes or punctuation.\n\n" +
              transcript.slice(0, 6000),
          },
        ],
      }),
    });
    const data = await res.json();
    const raw: string = data?.content?.[0]?.text ?? "";
    return raw
      .replace(/[\\/:*?"<>|]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .split(" ")
      .slice(0, 6)
      .join(" ");
  } catch {
    return "";
  }
}

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

/** Reverse of LANG_CODES, for showing what was actually detected. */
export const LANG_NAMES: Record<string, string> = Object.fromEntries(
  Object.entries(LANG_CODES).map(([name, code]) => [code, name])
);

/**
 * What to send when no language is pinned. Detection beats a wrong pin by a
 * mile — a French conversation forced to "en" comes back as phonetic nonsense —
 * and code switching keeps the English terms intact in a French conversation
 * instead of transliterating them.
 */
export const AUTO_LANGUAGE = {
  language_detection: true,
  language_detection_options: { code_switching: true },
};

/**
 * How many speakers to tell AssemblyAI to expect. The count you set is used as
 * a FLOOR, not just a ceiling: left to itself the model can return a single
 * label for a two-person conversation (one 13-minute block, both voices in it),
 * and a cap alone doesn't prevent that. The ceiling is one above the count so
 * an unexpected extra voice gets its own label instead of being merged into
 * someone else — an extra label is fixable in the app, a merge isn't.
 */
export function speakerOptions(count: number) {
  return {
    min_speakers_expected: Math.max(1, count),
    max_speakers_expected: Math.max(2, count + 1),
  };
}

/**
 * AssemblyAI's speaker identification: it maps letters to the names we give it
 * by reading the conversation — no voice enrollment. Descriptions sharpen it,
 * so the phone's owner carries a bio when one is set.
 */
export function speakerIdentification(
  speakers: string[],
  settings: Settings
): Record<string, unknown> | undefined {
  const named = speakers.filter((s) => !/^Speaker \d+$/.test(s));
  if (!named.length) return undefined;
  const owner = settings.ownerName.trim().toLowerCase();
  return {
    request: {
      speaker_identification: {
        speaker_type: "name",
        speakers: named.map((name) =>
          owner && name.trim().toLowerCase() === owner && settings.ownerBio.trim()
            ? { name, description: settings.ownerBio.trim() }
            : { name }
        ),
      },
    },
  };
}

/**
 * Accepts an identification mapping only when the transcript actually contains
 * evidence — someone's name said out loud. Measured on the real archive: with a
 * name spoken it is exact, without one it confidently returns the wrong person,
 * and it reports "success" either way. No evidence, no names: the speakers stay
 * "Speaker 2", "Speaker 3", which is honest rather than wrong.
 */
export function acceptSpeakerMapping(
  mapping: Record<string, string> | undefined,
  transcriptText: string,
  speakers: string[]
): Record<string, string> | undefined {
  if (!mapping) return undefined;
  const named = speakers.filter((s) => !/^Speaker \d+$/.test(s));
  const spoken = named.some((n) => {
    const first = n.trim().split(/\s+/)[0];
    return (
      first.length > 2 &&
      new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(
        transcriptText
      )
    );
  });
  if (!spoken) return undefined;
  const letters = Object.keys(mapping);
  const mayShare = letters.length > speakers.length;
  const used = new Set<string>();
  const clean: Record<string, string> = {};
  for (const [letter, name] of Object.entries(mapping)) {
    if (!named.includes(name)) continue; // it echoes the letter back when unsure
    if (!mayShare && used.has(name)) continue;
    used.add(name);
    clean[letter] = name;
  }
  return Object.keys(clean).length ? clean : undefined;
}

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
  const slot = idx >= 0 && idx < speakers.length ? speakers[idx] : "";
  // Letter order is arbitrary, so the positional slot is only a guess — never
  // let it hand back a name the map already gave to another letter.
  const taken = new Set(Object.values(speakerMap ?? {}));
  if (slot && !taken.has(slot)) return slot;
  return `Speaker ${idx + 1}`;
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
  language_code?: string;
  speech_understanding?: {
    response?: {
      speaker_identification?: { mapping?: Record<string, string> };
    };
  };
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
  /** From AssemblyAI's speaker identification, once it clears the gate. */
  speakerMap?: Record<string, string>;
  /** What the audio turned out to be in, when it wasn't pinned. */
  detectedLanguage?: string;
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
  if (rec.speakers.length) body.speaker_options = speakerOptions(rec.speakers.length);
  const su = speakerIdentification(rec.speakers, settings);
  if (su) body.speech_understanding = su;
  if (langCode) body.language_code = langCode;
  else Object.assign(body, AUTO_LANGUAGE);

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
  const speakerMap = acceptSpeakerMapping(
    data.speech_understanding?.response?.speaker_identification?.mapping,
    utterances.map((u) => u.text).join(" "),
    rec.speakers
  );
  return {
    text: renderTranscript(utterances, rec.speakers, speakerMap ?? rec.speakerMap),
    transcriptId: id,
    audioDurationSec: data.audio_duration ?? rec.durationSeconds,
    utterances,
    speakerMap,
    detectedLanguage: data.language_code
      ? LANG_NAMES[data.language_code] ?? data.language_code
      : undefined,
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
  else Object.assign(body, AUTO_LANGUAGE);
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
  settings: Settings,
  speakerCount = 0
): Promise<{ utterances: Utterance[]; audioDurationSec: number }> {
  if (!settings.assemblyAiKey) throw new Error("AssemblyAI key not set");
  const langCode = LANG_CODES[language];
  const body: Record<string, unknown> = {
    audio_url: audioUrl,
    speaker_labels: true,
  };
  if (speakerCount) body.speaker_options = speakerOptions(speakerCount);
  if (langCode) body.language_code = langCode;
  else Object.assign(body, AUTO_LANGUAGE);
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
 * Getting this wrong mislabels every line of the transcript, so it doesn't run
 * on the user-picked (cheap) topic model — a wrong map is far more expensive
 * than the few cents this costs.
 */
const SPEAKER_MAP_MODEL = "claude-sonnet-5";

/**
 * Pulls the answer out of a Messages response. Thinking-capable models put a
 * "thinking" block first, so content[0] is not necessarily the text — and
 * reading it blindly yields undefined instead of the answer.
 */
function textFrom(data: any): string {
  return (data?.content ?? [])
    .filter((b: any) => b?.type === "text")
    .map((b: any) => b.text as string)
    .join("\n");
}

/** Escapes a participant name for use inside a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Picks the lines worth reasoning over: every utterance that says a
 * participant's name (the only real evidence of who is who), plus an even
 * spread across the whole recording for context. Reading just the opening
 * minutes — as this used to — is how a two-hour conversation gets mapped off
 * the first bit of small talk.
 */
export function speakerSample(utterances: Utterance[], named: string[]): string {
  const namePat = new RegExp(`\\b(${named.map(escapeRe).join("|")})\\b`, "i");
  const picked = new Set<number>();
  utterances.forEach((u, i) => {
    if (picked.size < 90 && namePat.test(u.text)) picked.add(i);
  });
  const stride = Math.max(1, Math.floor(utterances.length / 60));
  utterances.forEach((_, i) => {
    if (i % stride === 0) picked.add(i);
  });
  return [...picked]
    .sort((a, b) => a - b)
    .map((i) => `${utterances[i].speaker}: ${utterances[i].text.slice(0, 400)}`)
    .join("\n")
    .slice(0, 24000);
}

/** Per-letter speaking time, so the model can tell a participant from a cameo. */
function speakerStats(utterances: Utterance[]): string {
  const mins: Record<string, number> = {};
  const turns: Record<string, number> = {};
  for (const u of utterances) {
    mins[u.speaker] = (mins[u.speaker] ?? 0) + ((u.end ?? u.start) - u.start) / 60000;
    turns[u.speaker] = (turns[u.speaker] ?? 0) + 1;
  }
  return Object.keys(mins)
    .sort()
    .map((l) => `${l}: ${mins[l].toFixed(0)} min over ${turns[l]} turns`)
    .join("; ");
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
  const letters = [...new Set(utterances.map((u) => u.speaker))].sort();
  if (letters.length < 2) return undefined; // one speaker: nothing to disambiguate
  const unnamed = speakers.length - named.length;
  const prompt =
    `A conversation transcript is labelled with anonymous speaker letters ` +
    `(${letters.join(", ")}), speaking ${speakerStats(utterances)}.\n` +
    `There are ${speakers.length} participants: ${named.join(", ")}` +
    (unnamed
      ? `, plus ${unnamed} whose name is not known (they stay "Speaker N").\n\n`
      : `.\n\n`) +
    `Map letters to names, reasoning only from the content:\n` +
    `- A speaker talked ABOUT in the third person ("X wants...", "ask X") is NOT ` +
    `the speaker of that line — this is the strongest signal available.\n` +
    `- "I am X" / "this is X" names the speaker of that line.\n` +
    `- When someone is addressed by name, the person who answers next is ` +
    `usually them.\n` +
    `- Only include a letter whose name the content actually supports. Leave ` +
    `out the letters belonging to unnamed participants — a neutral ` +
    `"Speaker N" beats a guess.\n` +
    (letters.length > speakers.length
      ? `- There are more letters than people, so diarization split someone ` +
        `in two: here, and only here, two letters may share a name.\n`
      : `- Never give the same name to two letters.\n`) +
    `\nOutput ONLY a JSON object, e.g. {"A":"Name"} — it may be empty, and ` +
    `it does not need an entry for every letter.\n\n` +
    `Transcript:\n${speakerSample(utterances, named)}`;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": settings.anthropicKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: SPEAKER_MAP_MODEL,
        // Room for the model to think before the (tiny) JSON answer — too small
        // a budget gets spent entirely on thinking and returns no text at all.
        max_tokens: 2000,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await res.json();
    const raw = textFrom(data);
    const json = raw.match(/\{[\s\S]*\}/)?.[0];
    if (!json) return undefined;
    const parsed = JSON.parse(json) as Record<string, string>;
    const clean: Record<string, string> = {};
    // Two letters may only share a name when diarization actually produced more
    // labels than there are people. Otherwise the one known name gets stamped on
    // everyone and the transcript reads as Basile talking to Basile.
    const mayShare = letters.length > speakers.length;
    const used = new Set<string>();
    for (const [letter, name] of Object.entries(parsed)) {
      if (!named.includes(name)) continue;
      if (!mayShare && used.has(name)) continue;
      used.add(name);
      clean[letter] = name;
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
  return textFrom(data);
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
    return textFrom(data)
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

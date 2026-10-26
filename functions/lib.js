// Pure helpers shared by the legacy (sidecar) and canonical (Firestore)
// pipelines: attribution projection, the patch merge rules, and everything
// AssemblyAI/Anthropic. Nothing here touches storage or the database.
const AAI = "https://api.assemblyai.com/v2";
// Fields a client may change after creation (phone outbox, Mac PATCH).
const CLIENT_FIELDS = [
  "folder", "speakers", "speakerLabels", "speakerId", "meIncluded", "tags", "private", "note",
  "topic", "place", "inputName", "language", "shareId", "base",
];
// Fields set once at creation and never patched.
const CREATE_ONLY_FIELDS = ["recordedAt", "durationSeconds", "owner", "mergedInCloud"];
const SYNCED_FIELDS = CLIENT_FIELDS;



// The archive's provenance contract ($DOTFILES/docs/transcription.md). The
// sidecar stores the owner's LETTER in speakerId and who set each letter in
// speakerLabels; the archive wants the owner's NAME, a confidence LEVEL, and
// a source from its own vocabulary. Derived here, in one place, for both
// /meta and /recordings — never stored as a second truth.
function ownerAttribution(m) {
  const none = { owner_label: "", speaker_id: "none", speaker_id_by: "none",
                 speaker_id_evidence: "", speaker_id_at: "" };
  if (m.meIncluded === "no") {
    return { ...none, speaker_id_evidence: "owner marked not present",
             speaker_id_at: String(m.fieldsUpdatedAt?.meIncluded || "").slice(0, 10) };
  }
  const letter = m.speakerId;
  const lbl = letter && m.speakerLabels && m.speakerLabels[letter];
  if (!lbl) return none;
  const LEVEL = { user: "verified", channel: "certain", "ai-review": "likely",
                  voiceprint: "inferred", claude: "inferred", aai: "inferred", none: "inferred" };
  const BY = { user: "user", channel: "channel", "ai-review": "ai-review",
               voiceprint: "ai-review", claude: "claude", aai: "aai", none: "none" };
  const EVIDENCE = {
    user: "owner confirmed the letter by hand",
    channel: "owner on a dedicated hardware channel",
    "ai-review": "Mac review pass, two signals",
    voiceprint: "voiceprint nearest-match only, single signal",
    claude: "Claude inferred from transcript content",
    aai: "AssemblyAI identification; name spoken in transcript",
    none: "pre-provenance label; source unknown",
  };
  return {
    owner_label: lbl.name || "",
    speaker_id: LEVEL[lbl.by] || "inferred",
    speaker_id_by: BY[lbl.by] || "none",
    speaker_id_evidence: EVIDENCE[lbl.by] || "",
    speaker_id_at: String(lbl.at || "").slice(0, 10),
  };
}


// The Mac's write path. Newest edit wins per field: the caller sends the
// fields it changed plus fieldsUpdatedAt for each, and a field is applied only
// when its stamp is newer than ours — so a batch relabel cannot revert a hand
// edit made on the phone since, and vice versa. A folder change moves the
// objects inside the bucket; nothing is re-uploaded from anywhere.
// A stamp is only comparable if it is a canonical instant. Any parseable
// time is accepted and normalised to UTC ISO; anything else is a 400, not a
// string that happens to sort after every real edit forever.
function canonStamp(t) {
  if (typeof t !== "string") return null;
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

// Shape checks for what the Mac may write. Reconciliation on the phone feeds
// these straight into paths and .map() calls, so a wrong type here is a crash
// there, after the sidecar is already saved.
function validField(f, v) {
  if (v === null) return ["note", "speakerId", "meIncluded", "shareId", "topic", "place", "inputName"].includes(f);
  switch (f) {
    case "folder": return typeof v === "string" && /^(?!\.)(?!_)[^/\\]{1,80}$/.test(v) && v !== "..";
    case "speakers": return Array.isArray(v) && v.every((x) => typeof x === "string");
    case "tags": return Array.isArray(v) && v.every((x) => typeof x === "string");
    case "private": return typeof v === "boolean";
    case "note": return typeof v === "string" && v.length <= 2000;
    case "speakerId": return typeof v === "string" && /^[^.\s/][^./]{0,39}$/.test(v);
    case "meIncluded": return v === "yes" || v === "no";
    case "topic": return typeof v === "string" && v.length <= 200;
    case "base": return typeof v === "string" && v.length <= 200 && !/[/\\]/.test(v);
    case "language": return typeof v === "string" && v.length <= 40;
    case "shareId": return typeof v === "string" && /^[A-Za-z0-9]{1,40}$/.test(v);
    case "place": return typeof v === "object" && typeof v.lat === "number" && typeof v.lon === "number";
    case "inputName": return typeof v === "string" && v.length <= 120;
    case "speakerLabels": return true; // handled per letter in applyPatch
    default: return false;
  }
}

class PatchError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra || {}; }
}

const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;

// Applies one patch to one sidecar under the merge rules. Pure with respect
// to storage: it receives the current content and returns the new content, or
// throws a PatchError the caller turns into an HTTP or callable error.
//
// Rules, in order:
//  - every field carries its own stamp; a stamp must parse and may not be
//    more than a day in the future (a skewed clock must not win forever);
//  - newest stamp wins per field; on an equal stamp the server's value stays,
//    so both sides converge on the same answer instead of each keeping its own;
//  - letters are edited one at a time (speakerLabels.A), never as a whole map,
//    so one side's edit to A cannot erase the other side's edit to B; a null
//    tombstones the letter;
//  - any letter edit names the transcript revision it was made against, and
//    is refused if the recording has been re-transcribed since — the letters
//    may now mean different voices;
//  - invariants are enforced AFTER the merge, whoever wrote: "not me" clears
//    the owner letter; renaming the owner's letter to someone else clears it;
//    a duplicate name is refused unless there are more letters than people.
function applyPatch(meta, body, ownerName, opts = {}) {
  const stamps = body.fieldsUpdatedAt || {};
  const mine = { ...(meta.fieldsUpdatedAt || {}) };
  const applied = [];
  const now = opts.now || Date.now();
  for (const k of Object.keys(body)) {
    if (!SYNCED_FIELDS.includes(k) && k !== "fieldsUpdatedAt" && k !== "expectedRevision") {
      throw new PatchError(400, `${k} is not a client-editable field`);
    }
  }
  const take = (key, value) => {
    const t = canonStamp(stamps[key]);
    if (!t) throw new PatchError(400, `fieldsUpdatedAt.${key} must be a parseable time`);
    if (Date.parse(t) - now > FUTURE_SLACK_MS) throw new PatchError(400, `fieldsUpdatedAt.${key} is in the future`);
    const m = canonStamp(mine[key]);
    if (m && m >= t) return false;
    mine[key] = t;
    applied.push(key);
    return true;
  };
  for (const f of SYNCED_FIELDS) {
    if (f === "speakerLabels" || !(f in body)) continue;
    if (!validField(f, body[f])) throw new PatchError(400, `bad value for ${f}`);
    if (take(f, body[f])) meta[f] = body[f];
  }
  // Per-letter labels. Accepts either {speakerLabels:{A:{...}|null}} with a
  // stamp per letter under fieldsUpdatedAt["speakerLabels.A"], and requires
  // expectedRevision when any letter is touched.
  const letters = body.speakerLabels && typeof body.speakerLabels === "object" ? body.speakerLabels : null;
  if (letters) {
    const rev = opts.revision != null ? Number(opts.revision) : Number(meta.transcriptRevision || 0);
    if (!("expectedRevision" in body) || Number(body.expectedRevision) !== rev) {
      throw new PatchError(409, "transcript was re-run since this label was made", { transcriptRevision: rev });
    }
    const labels = { ...(meta.speakerLabels || {}) };
    for (const [L, v] of Object.entries(letters)) {
      // A diarization key is a letter — or a name, when AssemblyAI's
      // identification already replaced the letters. Dots are the stamp
      // separator (speakerLabels.<key>), so a key cannot contain one.
      if (!/^[^.\s/][^./]{0,39}$/.test(L)) throw new PatchError(400, `bad letter ${L}`);
      if (v !== null && !validLabel(v)) throw new PatchError(400, `bad label for ${L}`);
      if (!take(`speakerLabels.${L}`, v)) continue;
      if (v === null) delete labels[L]; else labels[L] = v;
    }
    // Duplicate-name guard on the MERGED state: refuse, do not silently drop.
    const names = Object.entries(labels).map(([L, v]) => [L, (v.name || "").trim().toLowerCase()]).filter(([, n]) => n);
    const counts = {};
    for (const [, n] of names) counts[n] = (counts[n] || 0) + 1;
    const dup = Object.entries(counts).find(([, c]) => c > 1);
    const mayShare = Object.keys(labels).length > (Array.isArray(meta.speakers) ? meta.speakers.length : 0);
    if (dup && !mayShare) throw new PatchError(409, `"${dup[0]}" would be assigned to two letters`);
    meta.speakerLabels = labels;
  }
  // Invariants after the merge, regardless of who wrote.
  const owner = (ownerName || (meta.owner && meta.owner.name) || "").trim().toLowerCase();
  if (meta.meIncluded === "no" && meta.speakerId) {
    meta.speakerId = null;
    mine.speakerId = mine.meIncluded || new Date(now).toISOString();
  }
  if (meta.speakerId) {
    const lbl = meta.speakerLabels && meta.speakerLabels[meta.speakerId];
    const stillOwner = lbl && owner && (lbl.name || "").trim().toLowerCase() === owner;
    if (!lbl || (owner && !stillOwner)) {
      meta.speakerId = null;
      mine.speakerId = (lbl && mine[`speakerLabels.${meta.speakerId}`]) || new Date(now).toISOString();
    }
  }
  meta.speakerMap = meta.speakerLabels
    ? Object.fromEntries(Object.entries(meta.speakerLabels).map(([l, v]) => [l, v && v.name]))
    : meta.speakerMap;
  meta.fieldsUpdatedAt = mine;
  return { meta, applied };
}

function validLabel(e) {
  if (!e || typeof e !== "object") return false;
  if (typeof e.name !== "string") return false;
  if (!["user", "ai-review", "channel", "voiceprint", "claude", "aai", "none"].includes(e.by)) return false;
  // Legacy labels carry no time of attribution: null is honest, a made-up one
  // is not. Anything present must parse.
  return e.at === null || e.at === undefined || !!canonStamp(e.at);
}

// The Mac's write path. Newest edit wins per field: the caller sends the
// fields it changed plus fieldsUpdatedAt for each, and a field is applied only
// when its stamp is newer than ours — so a batch relabel cannot revert a hand
// edit made on the phone since, and vice versa. A folder change moves the

const AAI_RATE_PER_HOUR = 0.12; // matches the app's estimate
const LANG_CODES = { English: "en", French: "fr", Spanish: "es", Arabic: "ar" };
const LANG_NAMES = Object.fromEntries(
  Object.entries(LANG_CODES).map(([name, code]) => [code, name])
);
const TOPIC_MODEL = "claude-haiku-4-5-20251001";
// A wrong speaker map mislabels every line of the transcript, so that call gets
// a stronger model than the throwaway topic title. Mirrors src/transcription.ts.
const SPEAKER_MAP_MODEL = "claude-sonnet-5";

function mmss(ms) {
  const s = Math.floor((ms || 0) / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
// Same resolution + rendering the app uses, so cloud .txt is byte-identical.
function nameForSpeaker(letter, speakers, speakerMap) {
  if (speakerMap && speakerMap[letter]) return speakerMap[letter];
  // Letter order is arbitrary, so the slot entered first is not the voice
  // labelled A. Handing slots out by position named the wrong people with
  // total confidence. An unmapped letter stays anonymous.
  return "Speaker " + letter;
}
function renderTranscript(utterances, speakers, speakerMap) {
  return utterances
    .map((u) => `[${mmss(u.start)}] ${nameForSpeaker(u.speaker, speakers, speakerMap)}: ${u.text}`)
    .join("\n\n");
}
async function anthropic(key, maxTokens, prompt, model = TOPIC_MODEL, fetchImpl = fetch) {
  const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await res.json();
  // Thinking-capable models put a "thinking" block first, so content[0] is not
  // necessarily the answer — collect the text blocks instead.
  return ((data && data.content) || [])
    .filter((b) => b && b.type === "text")
    .map((b) => b.text)
    .join("\n");
}
// Lines that name a participant are the only real evidence of who is who, and
// they're spread through the whole recording — sampling just the opening
// minutes is how a two-hour conversation gets mapped off initial small talk.
function speakerSample(utterances, named) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const namePat = new RegExp(`\\b(${named.map(esc).join("|")})\\b`, "i");
  const picked = new Set();
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

function speakerStats(utterances) {
  const mins = {}, turns = {};
  for (const u of utterances) {
    mins[u.speaker] = (mins[u.speaker] || 0) + ((u.end || u.start) - u.start) / 60000;
    turns[u.speaker] = (turns[u.speaker] || 0) + 1;
  }
  return Object.keys(mins).sort()
    .map((l) => `${l}: ${mins[l].toFixed(0)} min over ${turns[l]} turns`)
    .join("; ");
}

// AssemblyAI's speaker identification maps letters to names by reading the
// conversation (no voice enrollment). Mirrors src/transcription.ts.
function speakerIdentification(meta) {
  const named = (meta.speakers || []).filter((s) => !/^Speaker \d+$/.test(s));
  if (!named.length) return undefined;
  const owner = ((meta.owner && meta.owner.name) || "").trim().toLowerCase();
  const bio = ((meta.owner && meta.owner.bio) || "").trim();
  return {
    request: {
      speaker_identification: {
        speaker_type: "name",
        speakers: named.map((name) =>
          owner && name.trim().toLowerCase() === owner && bio
            ? { name, description: bio }
            : { name }
        ),
      },
    },
  };
}

// Only trust an identification when the transcript actually says someone's
// name. Measured against the archive: with a name spoken it is exact, without
// one it returns the wrong person and still reports "success".
// Does this person's first name actually occur in the transcript? AssemblyAI's
// content-based identification is exact when someone is addressed by name and
// confidently wrong when nobody is, so each assignment needs its own evidence.
function nameSpoken(name, text) {
  const first = (name || "").trim().split(/\s+/)[0];
  if (first.length <= 2) return false;
  return new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text);
}

function acceptSpeakerMapping(mapping, text, speakers) {
  if (!mapping) return null;
  const named = (speakers || []).filter((s) => !/^Speaker \d+$/.test(s));
  const mayShare = Object.keys(mapping).length > (speakers || []).length;
  const used = new Set();
  const clean = {};
  for (const [letter, name] of Object.entries(mapping)) {
    if (!named.includes(name)) continue;
    // Previously one spoken name admitted the whole mapping, so a correct
    // "Erica" dragged in a guessed "Tyler". Evidence is per person now.
    if (!nameSpoken(name, text)) continue;
    if (!mayShare && used.has(name)) continue;
    used.add(name);
    clean[letter] = name;
  }
  return Object.keys(clean).length ? clean : null;
}

async function inferSpeakerMap(utterances, speakers, anthropicKey, fetchImpl = fetch) {
  if (!anthropicKey || !utterances.length) return null;
  const named = (speakers || []).filter((s) => !/^Speaker \d+$/.test(s));
  if (named.length < 1) return null;
  const letters = [...new Set(utterances.map((u) => u.speaker))].sort();
  if (letters.length < 2) return null;
  const unnamed = (speakers || []).length - named.length;
  const prompt =
    `A conversation transcript is labelled with anonymous speaker letters ` +
    `(${letters.join(", ")}), speaking ${speakerStats(utterances)}.\n` +
    `There are ${(speakers || []).length} participants: ${named.join(", ")}` +
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
    // 2000 tokens: room to think before the tiny JSON answer — too small a
    // budget gets spent entirely on thinking and returns no text at all.
    const raw = await anthropic(anthropicKey, 2000, prompt, SPEAKER_MAP_MODEL, fetchImpl);
    const json = raw.match(/\{[\s\S]*\}/);
    if (!json) return null;
    const parsed = JSON.parse(json[0]);
    const clean = {};
    // Only let two letters share a name when there are more labels than
    // people; otherwise one known name gets stamped on everyone.
    const mayShare = letters.length > (speakers || []).length;
    const used = new Set();
    for (const [letter, name] of Object.entries(parsed)) {
      if (!named.includes(name)) continue;
      if (!mayShare && used.has(name)) continue;
      used.add(name);
      clean[letter] = name;
    }
    return Object.keys(clean).length ? clean : null;
  } catch {
    return null;
  }
}
async function inferTopic(transcript, anthropicKey, fetchImpl = fetch) {
  if (!anthropicKey || !transcript.trim()) return null;
  try {
    const raw = await anthropic(
      anthropicKey,
      24,
      "Give a 2-5 word topic title for this meeting transcript, written " +
        "in the same language the conversation is in — a French " +
        "conversation gets a French title.\n" +
        "Output only the title, no quotes or punctuation.\n\n" +
        transcript.slice(0, 6000),
      TOPIC_MODEL, fetchImpl
    );
    const t = raw.replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim().split(" ").slice(0, 6).join(" ");
    return t || null;
  } catch {
    return null;
  }
}

// Request body for one AssemblyAI job, from the recording's fields. Mirrors
// src/transcription.ts. The caller adds webhook settings.
function aaiRequestBody(meta, signedAudioUrl) {
  const body = { audio_url: signedAudioUrl, speaker_labels: true };
  const speakers = Array.isArray(meta.speakers) ? meta.speakers : [];
  if (speakers.length) {
    body.speaker_options = {
      min_speakers_expected: Math.max(1, speakers.length),
      max_speakers_expected: Math.max(2, speakers.length + 1),
    };
  }
  const su = speakerIdentification(meta);
  if (su) body.speech_understanding = su;
  const lang = LANG_CODES[meta.language];
  if (lang) {
    body.language_code = lang;
  } else {
    body.language_detection = true;
    body.language_detection_options = { code_switching: true };
  }
  return body;
}

// Everything derived from a finished AssemblyAI transcript: speaker map (AAI's
// identification when evidenced, else Claude's guess), rendered text, topic.
async function postProcess(data, meta, env, fetchImpl) {
  const utterances = data.utterances || [];
  const speakers = Array.isArray(meta.speakers) ? meta.speakers : [];
  const identified = acceptSpeakerMapping(
    (((data.speech_understanding || {}).response || {}).speaker_identification || {}).mapping,
    utterances.map((u) => u.text).join(" "),
    speakers
  );
  const claudeMap = identified ? null : await inferSpeakerMap(utterances, speakers, env.ANTHROPIC_KEY, fetchImpl);
  const speakerMap = identified || claudeMap || null;
  const text = renderTranscript(utterances, speakers, speakerMap);
  const topic = await inferTopic(text, env.ANTHROPIC_KEY, fetchImpl);
  const audioDurationSec = data.audio_duration || 0;
  const pinned = LANG_CODES[meta.language];
  return {
    utterances, speakerMap, identified: !!identified, text, topic, audioDurationSec,
    speechModelUsed: data.speech_model || data.speech_model_used || null,
    estCostUsd: (audioDurationSec / 3600) * AAI_RATE_PER_HOUR,
    language: !pinned && data.language_code ? LANG_NAMES[data.language_code] || data.language_code : null,
  };
}

// Mirrors the public share doc, after checking the share is the owner's: this
// runs with admin rights and shareId came from the client.
// `rev` orders writes: a sync of an older transcript revision never lands
// over a newer one, and a failed write reports false so the caller keeps
// its retry marker.
async function updateShare(db, shareId, uid, fields, rev) {
  const ref = db.doc(`shares/${shareId}`);
  try {
    return await db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      if (!s.exists || s.data().ownerUid !== uid) { console.warn(`share ${shareId} not owned by ${uid}`); return false; }
      if (rev != null && Number(s.data().transcriptRev || 0) > rev) return true; // newer already there
      tx.set(ref, { ...fields, ...(rev != null ? { transcriptRev: rev } : {}) }, { merge: true });
      return true;
    });
  } catch (e) {
    console.error("updateShare", shareId, String((e && e.message) || e));
    return false;
  }
}

module.exports = {
  AAI, AAI_RATE_PER_HOUR, LANG_CODES, LANG_NAMES, CLIENT_FIELDS, CREATE_ONLY_FIELDS, SYNCED_FIELDS,
  ownerAttribution, canonStamp, validField, validLabel, PatchError, applyPatch,
  renderTranscript, acceptSpeakerMapping, inferSpeakerMap, inferTopic, speakerIdentification, anthropic,
  aaiRequestBody, postProcess, updateShare,
};

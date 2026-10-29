// The review step after each transcription: who is which voice.
//
// Who was there comes from the owner: the names in the record-time slots (or
// a preset), and on a re-run the names they had confirmed before. Which voice
// is whom is worked out here from three signals per voice:
//   - the label from transcription time (AssemblyAI's identification, else
//     Claude's inference on a sample);
//   - a fresh Claude pass over the whole transcript, keys anonymised, that
//     must quote a self-introduction or an answered address;
//   - the voice match (voice.js), against enrolled samples and, on a re-run,
//     against the voices the owner confirmed in the earlier transcript.
// Outcomes per voice:
//   by "auto"       the voice matches a name the owner gave and nothing
//                   disagrees: settled, green on the phone, `likely` for the
//                   archive (only the owner's own tap is `verified`);
//   by "ai-review"  two signals agree: a suggestion (yellow);
//   by "voiceprint" the voice alone: a suggestion (yellow);
//   merge           a short unnamed voice that sounds like a named one;
//   reviewFlag      signals that name different people, or a confirmed name
//                   the voice or the content clearly contradicts (red).
// A name the owner set is never changed; the review can only raise red on it.
const lib = require("./lib");
const voice = require("./voice");

const MODEL = "claude-sonnet-5-5";
const SHORT_SECONDS = 30;
const MERGE_MIN = 0.5;
const CLAIM_MS = 10 * 60 * 1000;
const MAX_FAILURES = 3;
const VERSION = 1;

const isPlaceholder = (s) => /^Speaker \d+$/.test(s || "");
const lc = (s) => (s || "").trim().toLowerCase();
const norm = (t) => (t || "").toLowerCase().replace(/[^a-z0-9à-ÿ]+/g, " ").trim();
const settled = (l) => !!l && (l.by === "user" || l.by === "auto");

function anonymise(utterances) {
  const keys = [...new Set(utterances.map((u) => u.speaker))].sort();
  const anon = Object.fromEntries(keys.map((k, i) => [k, i < 26 ? String.fromCharCode(65 + i) : `S${i}`]));
  const back = Object.fromEntries(Object.entries(anon).map(([k, v]) => [v, k]));
  const lines = utterances.map((u) => `${anon[u.speaker]}: ${u.text}`).join("\n").slice(0, 180000);
  return { anon, back, lines };
}
function parseJson(text) {
  const m = (text || "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

/** Key -> {name, quote}: only keys the content proves, by a quote that is a
 * self-introduction by that voice or an address it answers. */
async function askNames(ask, utterances, named, owner) {
  if (!named.length) return {};
  const { back, lines, anon } = anonymise(utterances);
  const prompt =
    `A conversation transcript is labelled with anonymous speaker letters (${Object.values(anon).join(", ")}). ` +
    `The participants are: ${named.join(", ")}` +
    (owner.name ? `. The recording device belongs to ${owner.name}${owner.bio ? `: ${owner.bio}` : ""}` : "") +
    ".\n\nFor each letter whose identity the content SUPPORTS, give the name and a SHORT quote (at most 15 words, " +
    "copied exactly) of the line that proves it: someone addressing them by name and them answering, or 'I am X'. " +
    "A speaker talked ABOUT in the third person is NOT the speaker of that line — that line proves who the speaker is not. " +
    "Never assign the same name to two letters unless there are more letters than participants. " +
    "If nothing in the text supports a letter, leave it out.\n\n" +
    'Output ONLY JSON, nothing else: {"A": {"name": "...", "quote": "..."}, ...}\n\nTranscript:\n' + lines;
  const out = parseJson(await ask(prompt, 1500)) || {};
  const texts = utterances.map((u) => norm(u.text));
  const clean = {};
  for (const [L, v] of Object.entries(out)) {
    if (!v || typeof v !== "object" || !named.includes(v.name) || !back[L]) continue;
    const quote = String(v.quote || "").trim();
    const q = norm(quote).slice(0, 50);
    const idx = q ? texts.findIndex((t) => t.includes(q)) : -1;
    if (quote.length < 8 || idx < 0) continue;
    const first = norm(v.name).split(" ")[0];
    const spokenBy = utterances[idx].speaker;
    const esc = first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const selfId = new RegExp(`\\b(i m|i am|this is|my name is|it s|c est|je suis|moi c est)\\s+${esc}`).test(texts[idx]);
    const addressed = texts[idx].includes(first) && spokenBy !== back[L] && idx + 1 < utterances.length && utterances[idx + 1].speaker === back[L];
    if ((selfId && spokenBy === back[L]) || addressed) clean[back[L]] = { name: v.name, quote };
  }
  return clean;
}

/** Blind content check for the owner: which key, if any, is the person who
 * owns the phone. Returns {key, quote, reason} or null; "unclear" is fine. */
async function askOwner(ask, utterances, ownerName, profile, speakers) {
  const { back, lines, anon } = anonymise(utterances);
  const others = speakers.filter((s) => s && !isPlaceholder(s) && s !== ownerName);
  const prompt =
    `This recording was made on ${ownerName}'s phone; ${ownerName} is usually, but not always, one of the speakers. ` +
    `Speakers are labelled ${Object.values(anon).join(", ")}.` + (others.length ? ` Other people possibly present: ${others.join(", ")}.` : "") +
    (profile ? `\n\nWhat is known about ${ownerName}:\n${profile}` : "") +
    `\n\nWhich label, if any, is ${ownerName}? Use only the content: being addressed as ${ownerName} and answering, ` +
    `introducing themself, others referring to them in the second person by name, or first-person statements that only ${ownerName} ` +
    "could make given the facts above and what the others say (their work, their partner, their languages, their history). A label that is talked ABOUT in the third person is not that person. " +
    "If the content does not let you tell, answer unclear — a wrong answer is much worse than unclear.\n\n" +
    'Output ONLY JSON: {"label": "A" | null, "confidence": "high" | "medium" | "low", "quote": "<=20 words copied exactly", "reason": "one sentence"}' +
    "\n\nTranscript:\n" + lines;
  const out = parseJson(await ask(prompt, 1500)) || {};
  const quote = String(out.quote || "").trim();
  if (!out.label || !back[out.label] || out.confidence !== "high") return null;
  if (quote.length < 8 || !norm(lines).includes(norm(quote).slice(0, 50))) return null;
  return { key: back[out.label], quote, reason: String(out.reason || "").slice(0, 200) };
}

async function askFolder(ask, utterances, names, folders) {
  const text = utterances.map((u) => `${names[u.speaker] || u.speaker}: ${u.text}`).join("\n").slice(0, 40000);
  const list = Object.entries(folders).map(([f, titles]) => `- ${f}${titles.length ? `: e.g. ${titles.join("; ")}` : ""}`).join("\n");
  const prompt = `Folders, with recent recordings in each:\n${list}\n\nWhich ONE folder does this recording belong in? If no folder clearly fits, answer null.\n` +
    'Output ONLY JSON: {"folder": "<one of the folders>" | null, "why": "<= 8 words"}\n\nTranscript:\n' + text;
  const out = parseJson(await ask(prompt, 600)) || {};
  return out.folder && folders[out.folder] ? { folder: out.folder, why: String(out.why || "").slice(0, 120) } : null;
}

/**
 * The decision, from signals already gathered. Pure, so the edge cases are
 * unit-tested. Returns the labels to write, the flag, and the sheet of why.
 *   doc      the recording (speakers, speakerLabels, owner…)
 *   keys     this transcript's voices
 *   seconds  key -> seconds of speech
 *   voiceBy  key -> {name, score, from: "sample"|"earlier"} decisive matches
 *   fresh    key -> {name, quote} from the transcript pass
 *   carried  names the owner confirmed before a re-run
 *   ownerCheck  {key, quote} from the blind owner check, or null
 *   similar  (a, b) -> cosine of two voices of this recording, or null
 *   sampled  names with an enrolled voice sample
 *   voiceClash  key -> [name, name] when the sample and the earlier
 *            transcript's voice point at different people
 */
function decide({ doc, keys, seconds, voiceBy, fresh, carried = [], ownerCheck = null, similar = () => null, ownerName, sampled = [], voiceClash = {} }) {
  const labels = doc.speakerLabels || {};
  const listed = (doc.speakers || []).filter((s) => s && !isPlaceholder(s));
  const there = new Set([...listed, ...carried].map(lc));
  const owner = lc(ownerName);
  const out = Object.create(null), disputed = Object.create(null), conflicts = [];
  const pct = (x) => `${Math.round(x * 100)}%`;
  const voiceWord = (v) => `voice ${pct(v.score)}` + (v.from === "earlier" ? " (same voice as before the re-run)" : "");

  // Settled names: never changed, only checked.
  for (const k of keys) {
    const l = labels[k];
    if (!settled(l)) continue;
    const v = voiceBy[k], f = fresh[k], clash = voiceClash[k];
    if (v && lc(v.name) !== lc(l.name)) conflicts.push(`${l.name}: the voice sounds like ${v.name} (${pct(v.score)})`);
    else if (clash && clash.some((n) => lc(n) !== lc(l.name))) conflicts.push(`${l.name}: the voice sounds like both ${clash.join(" and ")}`);
    else if (f && lc(f.name) !== lc(l.name)) conflicts.push(`${l.name}: the transcript says ${f.name} (“${f.quote.slice(0, 60)}”)`);
    else if (ownerCheck && lc(l.name) === owner && ownerCheck.key !== k) conflicts.push(`${l.name}: the conversation says ${ownerCheck.key} is (“${ownerCheck.quote.slice(0, 50)}”)`);
  }

  const open = keys.filter((k) => !settled(labels[k]));
  for (const k of open) {
    if (voiceClash[k]) { conflicts.push(`${k}: the voice sounds like both ${voiceClash[k].join(" and ")}`); continue; }
    const cur = labels[k] || {};
    // A label from an earlier review is not a separate signal.
    const server = ["aai", "claude"].includes(cur.by) ? cur.name : (!/^[A-Z]$/.test(k) && listed.includes(k) ? k : null);
    const v = voiceBy[k], f = fresh[k];
    const votes = [server, f && f.name, v && v.name].filter(Boolean);
    const agree = new Set(votes.map(lc)).size === 1;
    if (v && agree && there.has(lc(v.name))) {
      const ev = [voiceWord(v), carried.map(lc).includes(lc(v.name)) && !listed.map(lc).includes(lc(v.name)) ? "you named them before the re-run" : "you listed them when recording"];
      if (f) ev.push(`AI: “${f.quote.slice(0, 50)}”`);
      out[k] = { name: v.name, by: "auto", evidence: ev.join(" · ") };
    } else if (votes.length >= 2 && agree) {
      const ev = [v && voiceWord(v), f && `AI: “${f.quote.slice(0, 60)}”`, server && "AssemblyAI"].filter(Boolean);
      out[k] = { name: votes[0], by: "ai-review", evidence: ev.join(" · ") };
    } else if (v && votes.length === 1) {
      out[k] = { name: v.name, by: "voiceprint", evidence: voiceWord(v) };
    } else if (votes.length) {
      disputed[k] = { server, transcript: f && f.name, voice: v && v.name };
    }
  }

  // The owner: one voice on their own phone that sounds like them is them;
  // otherwise a voice-only owner match needs the blind content check.
  for (const [k, d] of Object.entries(out)) {
    if (d.by !== "voiceprint" || lc(d.name) !== owner) continue;
    if (keys.length === 1) { d.by = "ai-review"; d.evidence += " · only voice on your phone"; }
    else if (ownerCheck && ownerCheck.key === k) { d.by = "ai-review"; d.evidence += ` · AI: “${ownerCheck.quote.slice(0, 50)}”`; }
  }
  // The blind content check naming another voice as the owner disagrees.
  for (const [k, d] of Object.entries(out)) {
    if (lc(d.name) !== owner || !ownerCheck || ownerCheck.key === k) continue;
    conflicts.push(`${k}: the voice sounds like ${d.name}, but the conversation says ${ownerCheck.key} is (“${ownerCheck.quote.slice(0, 50)}”)`);
    delete out[k];
  }

  // The only one left: every listed name but one is placed, one real voice
  // is unplaced, and nothing points that voice elsewhere. Only for someone
  // with no voice sample: with one, the voice itself has to match. Settled
  // only when AssemblyAI or the transcript also names them; otherwise it is
  // a suggestion (the person listed may not have come).
  const placed = new Set(keys.map((k) => (settled(labels[k]) ? labels[k] : out[k] && out[k].by === "auto" ? out[k] : null)).filter(Boolean).map((l) => lc(l.name)));
  const leftNames = [...new Set(listed)].filter((n) => !placed.has(lc(n)));
  const leftKeys = open.filter((k) => !(out[k] && out[k].by === "auto") && (seconds[k] || 0) >= SHORT_SECONDS);
  if (placed.size && leftNames.length === 1 && leftKeys.length === 1 && !sampled.map(lc).includes(lc(leftNames[0])) && !voiceClash[leftKeys[0]]) {
    const k = leftKeys[0], n = leftNames[0];
    const cur = labels[k] || {};
    const against = [voiceBy[k] && voiceBy[k].name, fresh[k] && fresh[k].name, ["aai", "claude"].includes(cur.by) && cur.name].filter((x) => x && lc(x) !== lc(n));
    if (!against.length) {
      const said = (fresh[k] && lc(fresh[k].name) === lc(n)) || (["aai", "claude"].includes(cur.by) && lc(cur.name) === lc(n)) || lc(k) === lc(n);
      out[k] = { name: n, by: said ? "auto" : "ai-review", evidence: "the one voice left of the names you listed" + (said ? (fresh[k] ? ` · AI: “${fresh[k].quote.slice(0, 50)}”` : " · AssemblyAI") : "") };
      delete disputed[k];
    }
  }

  // Short unnamed voices: diarization splitting someone. Suggest folding it
  // into the named voice it sounds most like.
  const nameOf = (k) => (settled(labels[k]) ? labels[k].name : out[k] ? out[k].name : labels[k] && labels[k].name) || (!/^[A-Z]$/.test(k) ? k : null);
  for (const k of open) {
    if ((seconds[k] || 0) >= SHORT_SECONDS || out[k] || nameOf(k)) continue;
    let best = null;
    for (const j of keys) {
      if (j === k || !nameOf(j) || (seconds[j] || 0) < SHORT_SECONDS) continue;
      const s = similar(k, j);
      if (s != null && s >= MERGE_MIN && (!best || s > best.s)) best = { j, s };
    }
    if (best) out[k] = { name: nameOf(best.j), by: "ai-review", merge: true, evidence: `short voice, sounds like ${nameOf(best.j)} (${pct(best.s)})` };
  }

  // Never give a name another untouched voice already carries.
  for (const [k, d] of Object.entries(out)) {
    if (d.merge) continue;
    const clash = keys.filter((j) => j !== k && !(out[j]) && lc(nameOf(j)) === lc(d.name));
    const clashOut = Object.entries(out).filter(([j, e]) => j !== k && !e.merge && lc(e.name) === lc(d.name)).map(([j]) => j);
    if (clash.length || clashOut.length) {
      const cur = labels[k] || {};
      disputed[k] = {
        server: ["aai", "claude"].includes(cur.by) ? cur.name : null, transcript: fresh[k] && fresh[k].name, voice: voiceBy[k] && voiceBy[k].name,
        note: `${d.name} is already on another voice`,
      };
      delete out[k];
    }
  }
  // Drop rewrites that change nothing, or that would weaken a label from an
  // earlier review to the same name (a content check is not deterministic).
  const rank = { voiceprint: 1, "ai-review": 2, auto: 3 };
  for (const [k, d] of Object.entries(out)) {
    const cur = labels[k];
    if (cur && cur.name === d.name && !!cur.merge === !!d.merge && (rank[cur.by] || 0) >= (rank[d.by] || 0)) delete out[k];
  }

  for (const [k, v] of Object.entries(disputed)) {
    const names = new Set([v.server, v.transcript, v.voice].filter(Boolean).map(lc));
    if (names.size > 1 || v.note) {
      conflicts.push(`${k}: ` + ([["AssemblyAI", v.server], ["transcript", v.transcript], ["voice", v.voice]].filter(([, n]) => n).map(([w, n]) => `${w} ${n}`).join(" vs ") + (v.note ? ` (${v.note})` : "")));
    }
  }
  return { labels: { ...out }, flag: conflicts.length ? conflicts.join("; ").slice(0, 480) : null, disputed: { ...disputed } };
}

function makeReview({ db, bucket, env, now, fetchImpl, canon, runner }) {
  const iso = () => (now ? now() : new Date()).toISOString();
  const ask = (prompt, max) => lib.anthropic(env.ANTHROPIC_KEY, max, prompt, MODEL, fetchImpl || fetch);
  const enrolled = new Map(); // object name -> {generation, emb}

  async function samples(uid, ownerName) {
    const refs = {};
    const [files] = await bucket.getFiles({ prefix: `recordings/${uid}/_voiceprint/` });
    for (const f of files) {
      const m = f.name.match(/_voiceprint\/(enroll|people\/(.+))\.m4a$/);
      if (!m) continue;
      const name = m[2] ? decodeURIComponent(m[2]) : ownerName;
      const gen = String(f.metadata.generation);
      let c = enrolled.get(f.name);
      if (!c || c.generation !== gen) {
        const audio = await voice.decode(f);
        try { c = { generation: gen, emb: await voice.embed(bucket, audio.subarray(0, 120 * 16000)) }; } finally { audio.close(); }
        enrolled.set(f.name, c);
      }
      refs[name] = c.emb;
    }
    return refs;
  }

  // One voice embedding per key for a published revision, kept next to the
  // transcript so a later re-run can tell which new voice is which old one.
  async function voicesFor(uid, id, doc, rev, wavP) {
    const f = canon.blob(uid, id, `voices-r${rev}.json`);
    const [exists] = await f.exists();
    if (exists) return JSON.parse((await f.download())[0]);
    const aaiName = doc.current && doc.current.rev === rev ? doc.current.aai.name
      : (Object.values(doc.attempts || {}).find((a) => a.rev === rev && a.state === "published" && a.aai) || {}).aai?.name;
    if (!aaiName) return null;
    const utt = JSON.parse((await canon.blob(uid, id, aaiName).download())[0]);
    const out = { rev, embeddings: await voice.voiceEmbeddings(bucket, await wavP(), utt) };
    await f.save(JSON.stringify(out), { contentType: "application/json", resumable: false });
    return out;
  }

  async function claim(uid, id, due) {
    return db.runTransaction(async (tx) => {
      const ref = canon.docRef(uid, id);
      const s = await tx.get(ref);
      const d = s.exists ? s.data() : null;
      if (!d || !d.reviewDue) return null;
      // Deleted, or never transcribed: nothing to review, ever.
      if (d.deletedAt || !d.current) { tx.update(ref, { reviewDue: null, reviewClaim: null }); return null; }
      // A re-run in flight: its publish sets a new marker.
      if (d.status !== "done") return null;
      if (due && JSON.stringify(d.reviewDue) !== JSON.stringify(due)) return null;
      if (d.reviewClaim && Date.now() - Date.parse(d.reviewClaim.at) < CLAIM_MS) return null;
      tx.update(ref, { reviewClaim: { at: iso(), rev: d.current.rev } });
      return d;
    });
  }

  async function reviewOne(uid, id, due) {
    const doc = await claim(uid, id, due);
    if (!doc) return { skipped: true };
    const rev = doc.current.rev;
    try {
      const result = await (runner || run)(uid, id, doc, rev);
      await commit(uid, id, doc, rev, result);
      return { rev, labels: result.labels, flag: result.flag, folder: result.folder };
    } catch (e) {
      await canon.docRef(uid, id).update({
        reviewClaim: null,
        reviewFailures: (doc.reviewFailures || 0) + 1,
        reviewError: String((e && e.message) || e).slice(0, 300),
      }).catch(() => {});
      throw e;
    }
  }

  async function run(uid, id, doc, rev) {
    // A key that is also an Object property name ("constructor") would read
    // inherited values everywhere below; no real speaker is called that.
    const utterances = JSON.parse((await canon.blob(uid, id, doc.current.aai.name).download())[0]).filter((u) => !(u.speaker in Object.prototype));
    if (!utterances.length) return { labels: {}, flag: null, folder: null };
    const ownerName = ((doc.owner && doc.owner.name) || env.MIXTAPE_OWNER || "Basile").trim();
    const prof = await db.collection("ownerProfiles").doc(uid).get();
    const profile = prof.exists ? prof.data().profile || "" : "";
    const keys = (doc.speakerKeys || [...new Set(utterances.map((u) => u.speaker))].sort()).filter((k) => !(k in Object.prototype));
    const seconds = Object.create(null);
    for (const u of utterances) seconds[u.speaker] = (seconds[u.speaker] || 0) + (u.end - u.start) / 1000;

    let wav = null;
    const wavP = async () => wav || (wav = await voice.decode(canon.blob(uid, id, "audio.m4a")));
    try {
      return await decideFor(uid, id, doc, rev, utterances, ownerName, profile, keys, seconds, wavP);
    } finally {
      if (wav) wav.close();
    }
  }

  async function decideFor(uid, id, doc, rev, utterances, ownerName, profile, keys, seconds, wavP) {
    const mine = await voicesFor(uid, id, doc, rev, wavP);
    const emb = (mine && mine.embeddings) || {};

    const voiceBy = Object.create(null), voiceClash = Object.create(null);
    const refs = await samples(uid, ownerName);
    for (const [k, m] of Object.entries(voice.match(emb, refs).matches)) voiceBy[k] = { ...m, from: "sample" };
    // A re-run: the voices the owner named in earlier transcripts are the
    // strongest reference there is, the same people in the same audio.
    // Newest transcript first; each name from the newest one that has it.
    const byName = new Map();
    for (const prior of [].concat(doc.priorLabels || [])) {
      if (!prior || prior.rev === rev) continue;
      const fresh = Object.entries(prior.labels || {}).filter(([, l]) => settled(l) && !byName.has(l.name));
      if (!fresh.length) continue;
      const old = await voicesFor(uid, id, doc, prior.rev, wavP);
      const got = new Map();
      for (const [k, l] of fresh) if (old && old.embeddings[k]) got.set(l.name, [...(got.get(l.name) || []), old.embeddings[k]]);
      for (const [n, es] of got) byName.set(n, voice.normalize(es[0].map((_, i) => es.reduce((t, e) => t + e[i], 0))));
    }
    const carried = [...byName.keys()];
    for (const [k, m] of Object.entries(voice.match(emb, Object.fromEntries(byName)).matches)) {
      if (voiceBy[k] && lc(voiceBy[k].name) !== lc(m.name)) { voiceClash[k] = [voiceBy[k].name, m.name]; delete voiceBy[k]; }
      else voiceBy[k] = { ...m, from: "earlier" };
    }

    const listed = (doc.speakers || []).filter((s) => s && !isPlaceholder(s));
    const named = [...new Set([...listed, ...carried])];
    const fresh = named.length ? await askNames(ask, utterances, named, { name: ownerName, bio: doc.owner && doc.owner.bio }) : {};
    const ownerVoice = Object.entries(voiceBy).find(([, v]) => lc(v.name) === lc(ownerName));
    const ownerLabel = ownerVoice && (doc.speakerLabels || {})[ownerVoice[0]];
    const ownerCheck = ownerVoice && keys.length > 1 && !(ownerLabel && ownerLabel.by === "user") ? await askOwner(ask, utterances, ownerName, profile, doc.speakers || []) : null;
    const similar = (a, b) => (emb[a] && emb[b] ? voice.dot(emb[a], emb[b]) : null);
    const result = decide({ doc, keys, seconds, voiceBy, fresh, carried, ownerCheck, similar, ownerName, sampled: Object.keys(refs), voiceClash });

    // Inbox: propose a folder from the owner's own folders.
    result.folder = null;
    if ((doc.folder || "Inbox") === "Inbox" && !doc.folderSuggestion) {
      const snap = await db.collection("recordings").doc(uid).collection("items").where("deletedAt", "==", null).get();
      const folders = Object.create(null);
      for (const s of snap.docs) {
        const d = s.data();
        if (!d.folder || d.folder === "Inbox") continue;
        folders[d.folder] = folders[d.folder] || [];
        if (folders[d.folder].length < 3 && d.topic) folders[d.folder].push(d.topic.slice(0, 60));
      }
      if (keys.length === 1 && folders.self) result.folder = { folder: "self", why: "one voice" };
      else if (Object.keys(folders).length) {
        const names = Object.fromEntries(keys.map((k) => [k, (result.labels[k] || (doc.speakerLabels || {})[k] || {}).name || k]));
        result.folder = await askFolder(ask, utterances, names, folders);
      }
    }
    result.ownerName = ownerName;
    return result;
  }

  async function commit(uid, id, read, rev, result) {
    await db.runTransaction(async (tx) => {
      if ((await canon.readPhase(tx)) !== "canonical") throw new Error("phase is not canonical");
      const ref = canon.docRef(uid, id);
      const s = await tx.get(ref);
      const cur = s.data();
      const done = { reviewDue: null, reviewClaim: null, reviewFailures: 0, reviewError: null, review: { rev, at: iso(), version: VERSION } };
      if (!cur || cur.deletedAt || !cur.current || cur.current.rev !== rev) { tx.update(ref, { reviewClaim: null }); return; }
      const t = iso();
      const stamps = { ...(cur.fieldsUpdatedAt || {}) };
      const was = read.fieldsUpdatedAt || {};
      // The owner named, renamed or answered something while the review ran:
      // the decision was made on what they have since changed. Run again.
      const edited = Object.keys({ ...stamps, ...was }).some((f) =>
        (f.startsWith("speakerLabels.") || ["speakers", "reviewFlag", "speakerId", "meIncluded", "folder"].includes(f)) && (stamps[f] || "") !== (was[f] || ""));
      if (edited) { tx.update(ref, { reviewClaim: null, reviewDue: { rev, at: t, again: true } }); return; }
      const labels = { ...(cur.speakerLabels || {}) };
      for (const [k, d] of Object.entries(result.labels)) {
        if (settled(labels[k])) continue;
        labels[k] = { name: d.name, by: d.by, at: t, evidence: d.evidence.slice(0, 200), ...(d.merge ? { merge: true } : {}) };
        stamps[`speakerLabels.${k}`] = t;
      }
      const upd = { ...done, speakerLabels: labels, speakerMap: Object.fromEntries(Object.entries(labels).map(([k, l]) => [k, l.name])) };
      const prevFlag = cur.reviewFlag || null;
      if (result.flag && (!prevFlag || prevFlag.reason !== result.flag)) { upd.reviewFlag = { reason: result.flag, at: t }; stamps.reviewFlag = t; }
      else if (!result.flag && prevFlag) { upd.reviewFlag = null; stamps.reviewFlag = t; }
      if (result.folder && (cur.folder || "Inbox") === "Inbox" && !cur.folderSuggestion) {
        upd.folderSuggestion = { ...result.folder, at: t };
        stamps.folderSuggestion = t;
      }
      const owner = lc(result.ownerName);
      const ownerKey = Object.keys(labels).find((k) => lc(labels[k].name) === owner && ["user", "auto", "ai-review"].includes(labels[k].by) && !labels[k].merge);
      if (ownerKey && !cur.speakerId && cur.meIncluded !== "no" && (cur.speakerKeys || []).includes(ownerKey)) {
        upd.speakerId = ownerKey;
        stamps.speakerId = t;
        if (!cur.meIncluded) { upd.meIncluded = "yes"; stamps.meIncluded = t; }
      }
      upd.fieldsUpdatedAt = stamps;
      upd.updatedAt = t;
      tx.update(ref, upd);
    });
  }

  // Retries what a failed or lost trigger left: due for more than 15 min,
  // fewer than three failures.
  async function sweep(limit = 5) {
    const snap = await db.collectionGroup("items").where("reviewDue", "!=", null).get();
    const out = [];
    let ran = 0;
    for (const s of snap.docs) {
      const d = s.data();
      if (ran >= limit) break;
      if ((d.reviewFailures || 0) >= MAX_FAILURES || Date.now() - Date.parse(d.reviewDue.at || 0) < 15 * 60 * 1000) continue;
      try {
        const r = await reviewOne(d.uid, d.id);
        if (!r.skipped) ran++;
        out.push([d.id, r]);
      } catch (e) { ran++; out.push([d.id, String((e && e.message) || e)]); }
    }
    return out;
  }

  return { reviewOne, sweep, run };
}

module.exports = { makeReview, decide, askNames };

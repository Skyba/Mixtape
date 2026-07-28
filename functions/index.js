const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { onObjectFinalized } = require("firebase-functions/v2/storage");
const admin = require("firebase-admin");
const ffmpegPath = require("ffmpeg-static");
const { execFile } = require("child_process");
const crypto = require("crypto");
const express = require("express");
const os = require("os");
const path = require("path");
const fs = require("fs");
const fsp = fs.promises;
admin.initializeApp();

const ALL_SCOPES = [
  "read:meta",
  "read:transcripts",
  "read:json",
  "read:audio",
];
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

// ----- API key management (server-side hashing; raw key shown once) -----
exports.createApiKey = onCall({ region: "us-central1" }, async (req) => {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in required.");
  const { label, scopes } = req.data || {};
  const raw = "mxt_live_" + crypto.randomBytes(24).toString("hex");
  const valid =
    Array.isArray(scopes) && scopes.length
      ? scopes.filter((s) => ALL_SCOPES.includes(s))
      : ALL_SCOPES;
  await admin
    .firestore()
    .collection("apiKeys")
    .doc(sha256(raw))
    .set({
      ownerUid: uid,
      label: label || "API key",
      scopes: valid,
      prefix: raw.slice(0, 16),
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    });
  return { key: raw, prefix: raw.slice(0, 16) };
});

exports.listApiKeys = onCall({ region: "us-central1" }, async (req) => {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in required.");
  const snap = await admin
    .firestore()
    .collection("apiKeys")
    .where("ownerUid", "==", uid)
    .get();
  return {
    keys: snap.docs.map((d) => ({
      id: d.id,
      label: d.data().label,
      prefix: d.data().prefix,
      scopes: d.data().scopes,
      createdAt: d.data().createdAt,
      lastUsedAt: d.data().lastUsedAt,
    })),
  };
});

exports.revokeApiKey = onCall({ region: "us-central1" }, async (req) => {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in required.");
  const { id } = req.data || {};
  const ref = admin.firestore().collection("apiKeys").doc(String(id));
  const doc = await ref.get();
  if (doc.exists && doc.data().ownerUid === uid) await ref.delete();
  return { ok: true };
});

// ----- Public REST API (Bearer key auth) -----
const apiApp = express();

async function authKey(req, res, next) {
  const m = (req.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
  if (!m) return res.status(401).json({ error: "missing bearer token" });
  const token = m[1].trim();
  // Reject anything that isn't a well-formed key BEFORE hitting Firestore, so
  // random-token spraying can't rack up document reads.
  if (!/^mxt_live_[0-9a-f]{48}$/.test(token)) {
    return res.status(401).json({ error: "invalid key" });
  }
  const doc = await admin
    .firestore()
    .collection("apiKeys")
    .doc(sha256(token))
    .get();
  if (!doc.exists) return res.status(401).json({ error: "invalid key" });
  req.uid = doc.data().ownerUid;
  req.scopes = doc.data().scopes || [];
  doc.ref.update({ lastUsedAt: new Date().toISOString() }).catch(() => {});
  next();
}
const requireScope = (s) => (req, res, next) =>
  req.scopes.includes(s) ? next() : res.status(403).json({ error: "missing scope " + s });

function bkt() {
  return admin.storage().bucket();
}
async function readJson(p) {
  const [buf] = await bkt().file(p).download();
  return JSON.parse(buf.toString());
}
async function readText(p) {
  const [buf] = await bkt().file(p).download();
  return buf.toString();
}
const pathFor = (uid, folder, base, ext) =>
  `recordings/${uid}/${folder}/${base}.${ext}`;

const router = express.Router();
router.use(authKey);

router.get("/recordings", async (req, res) => {
  const since = req.query.since ? Date.parse(String(req.query.since)) : 0;
  const [files] = await bkt().getFiles({ prefix: `recordings/${req.uid}/` });
  const out = [];
  for (const f of files) {
    if (!f.name.endsWith(".json") || f.name.endsWith(".aai.json")) continue;
    if (f.name.includes("/_live/")) continue;
    try {
      const m = await readJson(f.name);
      if (since && Date.parse(m.recordedAt || 0) < since) continue;
      const parts = f.name.split("/"); // recordings/uid/folder/base.json
      out.push({
        folder: parts[2],
        base: parts.slice(3).join("/").replace(/\.json$/, ""),
        id: m.id,
        recordedAt: m.recordedAt,
        durationSeconds: m.durationSeconds,
        speakers: m.speakers,
        language: m.language,
        topic: m.topic || null,
        transcriptStatus: m.transcriptStatus,
        summary: m.summary || null,
      });
    } catch {}
  }
  out.sort((a, b) => (b.recordedAt || "").localeCompare(a.recordedAt || ""));
  res.json({ recordings: out });
});

function need(req, res) {
  const { folder, base } = req.query;
  if (!folder || !base) {
    res.status(400).json({ error: "folder and base required" });
    return null;
  }
  return { folder: String(folder), base: String(base) };
}

router.get("/transcript", requireScope("read:transcripts"), async (req, res) => {
  const q = need(req, res);
  if (!q) return;
  try {
    const t = await readText(pathFor(req.uid, q.folder, q.base, "txt"));
    res.type(req.query.format === "md" ? "text/markdown" : "text/plain").send(t);
  } catch {
    res.status(404).json({ error: "not found" });
  }
});

router.get("/utterances", requireScope("read:json"), async (req, res) => {
  const q = need(req, res);
  if (!q) return;
  try {
    res.json(await readJson(pathFor(req.uid, q.folder, q.base, "aai.json")));
  } catch {
    res.status(404).json({ error: "not found" });
  }
});

router.get("/meta", requireScope("read:meta"), async (req, res) => {
  const q = need(req, res);
  if (!q) return;
  try {
    res.json(await readJson(pathFor(req.uid, q.folder, q.base, "json")));
  } catch {
    res.status(404).json({ error: "not found" });
  }
});

router.get("/logs", requireScope("read:meta"), async (req, res) => {
  try {
    const txt = await readText(`recordings/${req.uid}/_logs/log.txt`);
    res.type("text/plain").send(txt);
  } catch {
    res.status(404).json({ error: "no logs uploaded yet" });
  }
});

router.get("/audio", requireScope("read:audio"), async (req, res) => {
  const q = need(req, res);
  if (!q) return;
  const p = pathFor(req.uid, q.folder, q.base, "m4a");
  const file = bkt().file(p);
  try {
    // Short-lived signed URL only — never the persistent ?token= download URL,
    // which would keep working after the API key is revoked. Signing needs the
    // runtime service account to have the Token Creator role.
    const [signed] = await file.getSignedUrl({
      version: "v4",
      action: "read",
      expires: Date.now() + 15 * 60 * 1000,
    });
    return res.redirect(302, signed);
  } catch {
    // Until the SA can sign, stream the bytes (auth'd by the bearer key here).
    // Cloud Run caps this at ~32 MiB, so large files need the signed-URL path.
    res.type("audio/mp4");
    file.createReadStream().on("error", () => res.status(404).end()).pipe(res);
  }
});

apiApp.use(["/v1", "/api/v1"], router);
exports.api = onRequest({ region: "us-central1", invoker: "public" }, apiApp);

// Concatenates a user's audio segments into one m4a (same codec → stream copy).
// Used by live mode (reassemble segments) and the standalone merge feature.
exports.mergeAudio = onCall(
  { region: "us-central1", memory: "1GiB", timeoutSeconds: 540 },
  async (req) => {
    const uid = req.auth && req.auth.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in required.");
    const { segments, dest } = req.data || {};
    if (!Array.isArray(segments) || segments.length < 1 || !dest) {
      throw new HttpsError("invalid-argument", "segments[] and dest required.");
    }
    // Bound the work so a caller can't hand us an unbounded segment list and
    // pin a 1 GiB / 9-minute ffmpeg job (a live recording is well under this).
    if (segments.length > 2000) {
      throw new HttpsError("invalid-argument", "too many segments.");
    }
    const prefix = `recordings/${uid}/`;
    for (const p of [...segments, dest]) {
      if (typeof p !== "string" || !p.startsWith(prefix) || !p.endsWith(".m4a")) {
        throw new HttpsError("permission-denied", "paths must be your own .m4a files.");
      }
    }

    const bucket = admin.storage().bucket();
    const work = await fsp.mkdtemp(path.join(os.tmpdir(), "merge-"));
    try {
      const local = [];
      for (let i = 0; i < segments.length; i++) {
        const f = path.join(work, `seg${String(i).padStart(4, "0")}.m4a`);
        await bucket.file(segments[i]).download({ destination: f });
        local.push(f);
      }
      const listFile = path.join(work, "list.txt");
      await fsp.writeFile(
        listFile,
        local.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n")
      );
      const out = path.join(work, "merged.m4a");
      await new Promise((resolve, reject) => {
        execFile(
          ffmpegPath,
          ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", out],
          (err, _so, se) => (err ? reject(new Error(se || err.message)) : resolve())
        );
      });
      await bucket.upload(out, {
        destination: dest,
        metadata: { contentType: "audio/mp4" },
      });
      return { path: dest };
    } catch (e) {
      throw new HttpsError("internal", String((e && e.message) || e));
    } finally {
      await fsp.rm(work, { recursive: true, force: true });
    }
  }
);

function speakerName(s, letter) {
  return (
    (s.speakerMap && s.speakerMap[letter]) ||
    (s.speakers && s.speakers[letter.charCodeAt(0) - 65]) ||
    "Speaker " + letter
  );
}

// Public-page prompt box: proxies to Anthropic with a server-side key so the
// key is never exposed in the browser. invoker:"public" allows the public page
// (and the hosting /api/ask rewrite) to call it; cors:true handles preflight.
exports.askSonnet = onRequest(
  {
    region: "us-central1",
    secrets: ["ANTHROPIC_KEY"],
    cors: true,
    invoker: "public",
  },
  async (req, res) => {
    try {
      if (req.method !== "POST") {
        res.status(405).json({ error: "POST only" });
        return;
      }
      const { id, prompt } = req.body || {};
      if (!id || !prompt || typeof prompt !== "string") {
        res.status(400).json({ error: "missing id or prompt" });
        return;
      }
      // Bound per-call cost: cap the user prompt (transcript is already sliced
      // below). Volume abuse still needs a valid share id; App Check / a rate
      // limiter is the fuller fix.
      if (prompt.length > 2000) {
        res.status(413).json({ error: "prompt too long" });
        return;
      }
      const snap = await admin.firestore().doc(`shares/${id}`).get();
      if (!snap.exists) {
        res.status(404).json({ error: "share not found" });
        return;
      }
      const s = snap.data();
      const transcript = (s.utterances || [])
        .map((u) => `${speakerName(s, u.speaker)}: ${u.text}`)
        .join("\n");

      const ar = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": process.env.ANTHROPIC_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1024,
          messages: [
            {
              role: "user",
              content: `${prompt}\n\n--- TRANSCRIPT ---\n${transcript.slice(0, 100000)}`,
            },
          ],
        }),
      });
      const data = await ar.json();
      if (data.error) {
        res.status(500).json({ error: data.error.message || "anthropic error" });
        return;
      }
      res.json({ answer: data.content?.[0]?.text || "No response." });
    } catch (e) {
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  }
);

// ===== Server-side transcription (runs with the screen off) =================
// A recording's meta .json landing in Storage with transcriptStatus "pending"
// triggers startTranscription, which hands the audio to AssemblyAI with a
// webhook. AAI calls transcriptionWebhook back when done; that writes the
// .txt/.aai.json + updates the meta to "done". The phone just uploads and later
// pulls the finished transcript — no need to keep the app open.
const AAI = "https://api.assemblyai.com/v2";
const AAI_RATE_PER_HOUR = 0.12; // matches the app's estimate
const LANG_CODES = { English: "en", French: "fr", Spanish: "es", Arabic: "ar" };
const TOPIC_MODEL = "claude-haiku-4-5-20251001";

function mmss(ms) {
  const s = Math.floor((ms || 0) / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
// Same resolution + rendering the app uses, so cloud .txt is byte-identical.
function nameForSpeaker(letter, speakers, speakerMap) {
  if (speakerMap && speakerMap[letter]) return speakerMap[letter];
  const idx = letter.charCodeAt(0) - 65;
  if (idx >= 0 && idx < (speakers || []).length) return speakers[idx];
  return "Speaker " + letter;
}
function renderTranscript(utterances, speakers, speakerMap) {
  return utterances
    .map((u) => `[${mmss(u.start)}] ${nameForSpeaker(u.speaker, speakers, speakerMap)}: ${u.text}`)
    .join("\n\n");
}
async function anthropic(key, maxTokens, prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: TOPIC_MODEL,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await res.json();
  return data?.content?.[0]?.text ?? "";
}
async function inferSpeakerMap(utterances, speakers, anthropicKey) {
  if (!anthropicKey || !utterances.length) return null;
  const named = (speakers || []).filter((s) => !/^Speaker \d+$/.test(s));
  if (named.length < 1) return null;
  const letters = [...new Set(utterances.map((u) => u.speaker))];
  if (letters.length < 2) return null;
  const sample = utterances.slice(0, 40).map((u) => `${u.speaker}: ${u.text}`).join("\n").slice(0, 4000);
  const prompt =
    `A meeting transcript is labeled by anonymous speaker letters (${letters.join(", ")}). ` +
    `The participants are: ${named.join(", ")}.\n` +
    `Using ONLY the content — especially self-introductions ("I'm X", "This is X") and how ` +
    `people address each other by name — map each speaker letter to the correct participant. ` +
    `Output ONLY a JSON object like {"A":"Name","B":"Name"}. Omit any letter whose identity is unclear.\n\n` +
    `Transcript:\n${sample}`;
  try {
    const raw = await anthropic(anthropicKey, 200, prompt);
    const json = raw.match(/\{[\s\S]*\}/);
    if (!json) return null;
    const parsed = JSON.parse(json[0]);
    const clean = {};
    for (const [letter, name] of Object.entries(parsed)) if (named.includes(name)) clean[letter] = name;
    return Object.keys(clean).length ? clean : null;
  } catch {
    return null;
  }
}
async function inferTopic(transcript, anthropicKey) {
  if (!anthropicKey || !transcript.trim()) return null;
  try {
    const raw = await anthropic(
      anthropicKey,
      24,
      "Give a 2-5 word topic title for this meeting transcript. " +
        "Output only the title, no quotes or punctuation.\n\n" +
        transcript.slice(0, 6000)
    );
    const t = raw.replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim().split(" ").slice(0, 6).join(" ");
    return t || null;
  } catch {
    return null;
  }
}
async function saveJson(p, obj) {
  await bkt().file(p).save(JSON.stringify(obj, null, 2), { contentType: "application/json" });
}

const TRANSCRIBE_SECRETS = ["ASSEMBLYAI_KEY", "ANTHROPIC_KEY", "TRANSCRIBE_WEBHOOK_SECRET"];

// Fires when a recording's meta .json is finalized. Only new, uploaded, but
// untranscribed recordings ("pending") start a job — re-uploads and the
// "processing"/"done" writes below are ignored, so it never loops or doubles.
exports.startTranscription = onObjectFinalized(
  // Storage-trigger functions must run in the bucket's region (us-east1).
  { region: "us-east1", secrets: TRANSCRIBE_SECRETS, memory: "512MiB", timeoutSeconds: 120 },
  async (event) => {
    const name = event.data.name || "";
    if (!name.endsWith(".json") || name.endsWith(".aai.json")) return;
    if (name.includes("/_live/") || name.includes("/_logs/")) return;
    const m = name.match(/^recordings\/([^/]+)\/([^/]+)\/(.+)\.json$/);
    if (!m) return;
    const [, uid, folder, base] = m;

    let meta;
    try {
      meta = JSON.parse((await bkt().file(name).download())[0].toString());
    } catch {
      return;
    }
    if (meta.transcriptStatus !== "pending") return;
    if (!Array.isArray(meta.speakers) || meta.speakers.length === 0) return;

    const m4a = `recordings/${uid}/${folder}/${base}.m4a`;
    const [audioExists] = await bkt().file(m4a).exists();
    if (!audioExists) return; // audio not up yet (m4a normally uploads first)

    // Firestore lock keyed by the object path → exactly one job per recording.
    const lockRef = admin.firestore().collection("transcriptions").doc(sha256(name));
    const acquired = await admin.firestore().runTransaction(async (tx) => {
      const d = await tx.get(lockRef);
      if (d.exists) return false;
      tx.set(lockRef, {
        uid, folder, base,
        status: "starting",
        createdAt: new Date().toISOString(),
      });
      return true;
    });
    if (!acquired) return;

    try {
      const [signed] = await bkt().file(m4a).getSignedUrl({
        version: "v4",
        action: "read",
        expires: Date.now() + 6 * 60 * 60 * 1000,
      });
      const body = { audio_url: signed, speaker_labels: true };
      const lang = LANG_CODES[meta.language];
      if (lang) body.language_code = lang;
      else body.language_detection = true;
      body.webhook_url = `https://${process.env.GCLOUD_PROJECT}.web.app/hooks/transcription`;
      body.webhook_auth_header_name = "x-mixtape-secret";
      body.webhook_auth_header_value = process.env.TRANSCRIBE_WEBHOOK_SECRET;

      const created = await (
        await fetch(`${AAI}/transcript`, {
          method: "POST",
          headers: { authorization: process.env.ASSEMBLYAI_KEY, "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      ).json();
      if (!created.id) throw new Error("AAI create failed: " + JSON.stringify(created).slice(0, 200));

      await lockRef.set(
        { transcriptId: created.id, speakers: meta.speakers, language: meta.language || "", status: "processing" },
        { merge: true }
      );
      meta.transcriptStatus = "processing";
      await saveJson(name, meta);
    } catch (e) {
      await lockRef.delete().catch(() => {});
      try {
        meta.transcriptStatus = "error";
        await saveJson(name, meta);
      } catch {}
      console.error("startTranscription", base, String((e && e.message) || e));
    }
  }
);

// AssemblyAI calls this (via the stable /hooks/transcription hosting rewrite)
// when a job finishes. Writes the transcript back to the owner's storage.
exports.transcriptionWebhook = onRequest(
  { region: "us-central1", secrets: TRANSCRIBE_SECRETS, invoker: "public" },
  async (req, res) => {
    try {
      if (req.method !== "POST") return res.status(405).end();
      if (req.get("x-mixtape-secret") !== process.env.TRANSCRIBE_WEBHOOK_SECRET) {
        return res.status(401).end();
      }
      const transcriptId = req.body && req.body.transcript_id;
      const status = req.body && req.body.status;
      if (!transcriptId) return res.status(400).end();

      const snap = await admin
        .firestore()
        .collection("transcriptions")
        .where("transcriptId", "==", transcriptId)
        .limit(1)
        .get();
      if (snap.empty) return res.status(200).json({ ok: true, note: "no matching job" });
      const lockRef = snap.docs[0].ref;
      const job = snap.docs[0].data();
      const metaPath = `recordings/${job.uid}/${job.folder}/${job.base}.json`;
      const prefix = `recordings/${job.uid}/${job.folder}/${job.base}`;

      const patchMeta = async (patch) => {
        let meta = {};
        try {
          meta = JSON.parse((await bkt().file(metaPath).download())[0].toString());
        } catch {}
        Object.assign(meta, patch);
        await saveJson(metaPath, meta);
        return meta;
      };

      if (status !== "completed") {
        await patchMeta({ transcriptStatus: "error" });
        await lockRef.delete().catch(() => {});
        return res.status(200).json({ ok: true });
      }

      const data = await (
        await fetch(`${AAI}/transcript/${transcriptId}`, {
          headers: { authorization: process.env.ASSEMBLYAI_KEY },
        })
      ).json();
      const utterances = data.utterances || [];
      const speakers = job.speakers || [];
      const speakerMap = await inferSpeakerMap(utterances, speakers, process.env.ANTHROPIC_KEY);
      const text = renderTranscript(utterances, speakers, speakerMap);
      const topic = await inferTopic(text, process.env.ANTHROPIC_KEY);
      const audioDurationSec = data.audio_duration || 0;

      await bkt().file(prefix + ".txt").save(text, { contentType: "text/plain" });
      await bkt().file(prefix + ".aai.json").save(JSON.stringify(utterances), { contentType: "application/json" });
      const meta = await patchMeta({
        transcriptStatus: "done",
        speakerMap: speakerMap,
        topic: topic,
        aaiTranscriptId: transcriptId,
        audioDurationSec,
        transcribedAt: new Date().toISOString(),
        estCostUsd: (audioDurationSec / 3600) * AAI_RATE_PER_HOUR,
      });

      if (meta.shareId) {
        await admin
          .firestore()
          .doc(`shares/${meta.shareId}`)
          .set(
            {
              utterances,
              speakerMap: speakerMap,
              topic: topic,
              durationSeconds: meta.durationSeconds || 0,
              speakers,
              language: meta.language || "",
            },
            { merge: true }
          )
          .catch(() => {});
      }
      await lockRef.delete().catch(() => {});
      res.status(200).json({ ok: true });
    } catch (e) {
      console.error("transcriptionWebhook", String((e && e.message) || e));
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  }
);

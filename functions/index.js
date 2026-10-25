const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { onObjectFinalized } = require("firebase-functions/v2/storage");
const { onSchedule } = require("firebase-functions/v2/scheduler");
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
// Granted only when asked for by name. A key minted with no scopes stays
// read-only, so a leaked read key can never rewrite anything.
const WRITE_SCOPES = ["write:meta"];
const lib = require("./lib");
const { ownerAttribution, canonStamp, validField, PatchError, applyPatch, AAI, AAI_RATE_PER_HOUR, LANG_CODES, LANG_NAMES, renderTranscript, acceptSpeakerMapping, inferSpeakerMap, inferTopic, speakerIdentification } = lib;
const { makeCanonical } = require("./canonical");
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

// ----- API key management (server-side hashing; raw key shown once) -----
exports.createApiKey = onCall({ region: "us-central1" }, async (req) => {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in required.");
  const { label, scopes } = req.data || {};
  const raw = "mxt_live_" + crypto.randomBytes(24).toString("hex");
  const valid =
    Array.isArray(scopes) && scopes.length
      ? scopes.filter((s) => ALL_SCOPES.includes(s) || WRITE_SCOPES.includes(s))
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

// Canonical model (Firestore record of truth, blobs under rec2/). Which
// pipeline serves a request is decided by config/migration.phase, read per
// request: "legacy" until the bucket migration, "frozen" during it,
// "canonical" after. See mixtape-private/docs/migration/plan.md.
let _canon = null;
const canon = () => _canon || (_canon = makeCanonical({ db: admin.firestore(), bucket: bkt(), env: process.env }));
const phase = () => canon().readPhase();

// Under legacy, an id is found by scanning the sidecars; two paths with the
// same id (the 9 known duplicates) are a 409, never a guess.
async function legacyFindById(uid, id) {
  const [files] = await bkt().getFiles({ prefix: `recordings/${uid}/` });
  const hits = [];
  for (const f of files) {
    if (!f.name.endsWith(".json") || f.name.endsWith(".aai.json") || f.name.includes("/_")) continue;
    try {
      const m = await readJson(f.name);
      if (m.id === id) {
        const parts = f.name.split("/");
        hits.push({ folder: parts[2], base: parts.slice(3).join("/").replace(/\.json$/, ""), meta: m });
      }
    } catch {}
  }
  if (hits.length > 1) throw new PatchError(409, "id present at two paths", { paths: hits.map((h) => `${h.folder}/${h.base}`) });
  return hits[0] || null;
}
// Resolves a request to {folder, base} under legacy. Accepts ?id= or
// ?folder=&base=. Writes the error itself and returns null.
async function resolveLegacy(req, res) {
  if (req.query.id) {
    try {
      const h = await legacyFindById(req.uid, String(req.query.id));
      if (!h) { res.status(404).json({ error: "not found" }); return null; }
      return { folder: h.folder, base: h.base, meta: h.meta };
    } catch (e) {
      if (e instanceof PatchError) { res.status(e.status).json({ error: e.message, ...e.extra }); return null; }
      throw e;
    }
  }
  return need(req, res);
}
// Under canonical only ids are addresses; folder/base is gone for good.
function needId(req, res) {
  const id = req.query.id;
  if (!id || typeof id !== "string") { res.status(req.query.folder ? 410 : 400).json({ error: req.query.folder ? "folder/base addressing is gone; use id" : "id required" }); return null; }
  return id;
}
// Serializes a canonical error into an HTTP response.
function sendCanonError(res, e) {
  const status = { "invalid-argument": 400, "not-found": 404, "failed-precondition": 409, unavailable: 503, "permission-denied": 403 }[e.code] || 500;
  if (status === 503) res.set("Retry-After", "60");
  res.status(status).json({ error: e.message, ...(e.extra || {}) });
}
const isCanonError = (e) => e && e.code && typeof e.code === "string" && e.extra !== undefined;

const router = express.Router();
router.use(authKey);

router.get("/recordings", async (req, res) => {
  const since = req.query.since ? Date.parse(String(req.query.since)) : 0;
  if ((await phase()) === "canonical") {
    const docs = await canon().list(req.uid, { since });
    const out = docs.map((d) => ({ ...listRow(d, d.folder, d.base), transcript_rev: d.current ? d.current.rev : null }));
    out.sort((a, b) => (b.recordedAt || "").localeCompare(a.recordedAt || ""));
    return res.json({ recordings: out });
  }
  const [files] = await bkt().getFiles({ prefix: `recordings/${req.uid}/` });
  const out = [];
  for (const f of files) {
    if (!f.name.endsWith(".json") || f.name.endsWith(".aai.json")) continue;
    if (f.name.includes("/_live/")) continue;
    try {
      const m = await readJson(f.name);
      if (since && Date.parse(m.recordedAt || 0) < since) continue;
      const parts = f.name.split("/"); // recordings/uid/folder/base.json
      out.push(listRow(m, parts[2], parts.slice(3).join("/").replace(/\.json$/, "")));
    } catch {}
  }
  out.sort((a, b) => (b.recordedAt || "").localeCompare(a.recordedAt || ""));
  res.json({ recordings: out });
});

// One listing row, same shape from either pipeline.
function listRow(m, folder, base) {
  return {
        folder,
        base,
        id: m.id,
        recordedAt: m.recordedAt,
        durationSeconds: m.durationSeconds,
        speakers: m.speakers,
        language: m.language,
        topic: m.topic || null,
        transcriptStatus: m.transcriptStatus,
        summary: m.summary || null,
        // Filing hints set in the app; absent on anything recorded before
        // they existed, which the archive treats exactly as it did then.
        private: typeof m.private === "boolean" ? m.private : undefined,
        tags: Array.isArray(m.tags) ? m.tags : undefined,
        // Context typed at record time, for the archive's frontmatter.
        note: m.note || undefined,
        place: m.place || undefined,
        inputName: m.inputName || undefined,
        // Attribution, with provenance. green = folder set and the owner's
        // presence decided; naming everyone else is optional.
        speaker_labels: m.speakerLabels || undefined,
        owner_letter: m.speakerId || undefined,
        ...ownerAttribution(m),
        speech_model_used: m.speechModelUsed || undefined,
        me_included: m.meIncluded || undefined,
        fields_updated_at: m.fieldsUpdatedAt || undefined,
        green: !!(m.folder && m.folder !== "Inbox" && m.meIncluded),
  };
}

function need(req, res) {
  const { folder, base } = req.query;
  if (!folder || !base) {
    res.status(400).json({ error: "folder and base required" });
    return null;
  }
  return { folder: String(folder), base: String(base) };
}

router.get("/transcript", requireScope("read:transcripts"), async (req, res) => {
  if ((await phase()) === "canonical") {
    const id = needId(req, res); if (!id) return;
    const r = await canon().readArtifact(req.uid, id, "txt", req.query.rev);
    if (!r) return res.status(404).json({ error: "not found" });
    res.set("X-Transcript-Rev", String(r.rev));
    return res.type(req.query.format === "md" ? "text/markdown" : "text/plain").send(r.content.toString());
  }
  const q = await resolveLegacy(req, res);
  if (!q) return;
  try {
    const t = await readText(pathFor(req.uid, q.folder, q.base, "txt"));
    res.type(req.query.format === "md" ? "text/markdown" : "text/plain").send(t);
  } catch {
    res.status(404).json({ error: "not found" });
  }
});

router.get("/utterances", requireScope("read:json"), async (req, res) => {
  if ((await phase()) === "canonical") {
    const id = needId(req, res); if (!id) return;
    const r = await canon().readArtifact(req.uid, id, "aai", req.query.rev);
    if (!r) return res.status(404).json({ error: "not found" });
    res.set("X-Transcript-Rev", String(r.rev));
    return res.type("application/json").send(r.content.toString());
  }
  const q = await resolveLegacy(req, res);
  if (!q) return;
  try {
    res.json(await readJson(pathFor(req.uid, q.folder, q.base, "aai.json")));
  } catch {
    res.status(404).json({ error: "not found" });
  }
});

router.get("/meta", requireScope("read:meta"), async (req, res) => {
  if ((await phase()) === "canonical") {
    const id = needId(req, res); if (!id) return;
    const d = await canon().get(req.uid, id);
    return d ? res.json(canon().project(d)) : res.status(404).json({ error: "not found" });
  }
  const q = await resolveLegacy(req, res);
  if (!q) return;
  try {
    const m = await readJson(pathFor(req.uid, q.folder, q.base, "json"));
    res.json({ ...m, ...ownerAttribution(m), speech_model_used: m.speechModelUsed || undefined });
  } catch {
    res.status(404).json({ error: "not found" });
  }
});
// objects inside the bucket; nothing is re-uploaded from anywhere.
router.patch("/meta", requireScope("write:meta"), async (req, res) => {
  const ph = await phase();
  if (ph === "canonical") {
    const id = needId(req, res); if (!id) return;
    try {
      const r = await canon().patch(req.uid, id, req.body || {});
      return res.json({ applied: r.applied, ...r.doc });
    } catch (e) {
      if (e instanceof PatchError) return res.status(e.status).json({ error: e.message, ...e.extra });
      if (isCanonError(e)) return sendCanonError(res, e);
      return res.status(500).json({ error: String((e && e.message) || e) });
    }
  }
  if (ph !== "legacy") { res.set("Retry-After", "60"); return res.status(503).json({ error: "migration in progress" }); }
  const q = await resolveLegacy(req, res);
  if (!q) return;
  if (!/^(?!\.)(?!_)[^/\\]{1,80}$/.test(q.folder) || /[/\\]/.test(q.base)) {
    return res.status(400).json({ error: "bad folder or base" });
  }
  const body = req.body || {};
  const oldBase = `recordings/${req.uid}/${q.folder}/${q.base}`;
  let meta, applied = [];
  try {
    const r = await mutateSidecar(oldBase + ".json", async (cur) => {
      if (!cur || !cur.id) throw new PatchError(404, "not found");
      const out = applyPatch(cur, body);
      applied = out.applied;
      // A folder change is not written in place: it is handled below as a
      // move, and only once nothing else is pending on the recording.
      if (applied.includes("folder")) { meta = out.meta; return null; }
      meta = out.meta;
      return out.meta;
    });
    if (!r.saved && !applied.includes("folder")) return res.json({ applied, ...r.meta });
  } catch (e) {
    if (e instanceof PatchError) return res.status(e.status).json({ error: e.message, ...e.extra });
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
  try {
    const newFolder = String(meta.folder || q.folder);
    if (applied.includes("folder") && newFolder !== q.folder) {
      // A move while a transcription is pending or running would strand the
      // job: its lock and its webhook both point at the old path, and a
      // second finalize on the new path can submit a second paid job.
      if (meta.transcriptStatus === "pending" || meta.transcriptStatus === "processing") {
        return res.status(409).json({ error: "transcription in progress; move later" });
      }
      const newBase = `recordings/${req.uid}/${newFolder}/${q.base}`;
      // Two recordings may share a base across folders. Never land on one.
      const [destExists] = await bkt().file(newBase + ".json").exists();
      if (destExists) {
        let other = {};
        try { other = await readJson(newBase + ".json"); } catch {}
        if (other.id !== meta.id) {
          return res.status(409).json({ error: "another recording already has that name in that folder" });
        }
      }
      // Copy everything, write the new sidecar, confirm it exists — and only
      // then remove the old objects. At no point is there a moment with no
      // sidecar for this recording.
      for (const ext of [".m4a", ".txt", ".aai.json"]) {
        const src = bkt().file(oldBase + ext);
        const [exists] = await src.exists();
        if (exists) await src.copy(bkt().file(newBase + ext));
      }
      await bkt().file(newBase + ".json").save(JSON.stringify(meta, null, 2), {
        contentType: "application/json",
      });
      const [written] = await bkt().file(newBase + ".json").exists();
      if (!written) return res.status(500).json({ error: "move did not land; nothing deleted" });
      for (const ext of [".m4a", ".txt", ".aai.json", ".json"]) {
        await bkt().file(oldBase + ext).delete().catch(() => {});
      }
    } else {
      await saveJson(oldBase + ".json", meta);
    }
    res.json({ applied, ...meta, folder: newFolder, base: q.base });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
});

// The phone's write path: same merge, same guards, authenticated as the owner.
// No API key is involved, so a leaked read key still cannot write. Returns the
// merged sidecar so the phone writes the authoritative state locally rather
// than its own guess at it.
exports.patchMeta = onCall({ region: "us-central1" }, async (req) => {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in required.");
  const { folder, base, patch, id } = req.data || {};
  const ph = await phase();
  if (ph === "canonical") {
    if (typeof id !== "string" || !patch || typeof patch !== "object") throw new HttpsError("invalid-argument", "id and patch required");
    try {
      const r = await canon().patch(uid, id, patch);
      return { applied: r.applied, meta: r.doc };
    } catch (e) { throw toHttpsError(e); }
  }
  if (ph !== "legacy") throw new HttpsError("unavailable", "migration in progress");
  if (typeof folder !== "string" || typeof base !== "string" || !patch || typeof patch !== "object") {
    throw new HttpsError("invalid-argument", "folder, base and patch required");
  }
  if (!/^(?!\.)(?!_)[^/\\]{1,80}$/.test(folder) || /[/\\]/.test(base)) {
    throw new HttpsError("invalid-argument", "bad folder or base");
  }
  if ("folder" in patch) throw new HttpsError("failed-precondition", "folder changes are not synced yet");
  const path = `recordings/${uid}/${folder}/${base}.json`;
  try {
    let applied = [];
    const r = await mutateSidecar(path, async (cur) => {
      if (!cur || !cur.id) throw new PatchError(404, "not found");
      const out = applyPatch(cur, patch);
      applied = out.applied;
      return out.meta;
    });
    return { applied, meta: r.meta };
  } catch (e) {
    if (e instanceof PatchError) {
      const code = { 400: "invalid-argument", 404: "not-found", 409: "failed-precondition" }[e.status] || "internal";
      throw new HttpsError(code, e.message, e.extra);
    }
    throw new HttpsError("internal", String((e && e.message) || e));
  }
});

function toHttpsError(e) {
  if (e instanceof PatchError) {
    const code = { 400: "invalid-argument", 404: "not-found", 409: "failed-precondition" }[e.status] || "internal";
    return new HttpsError(code, e.message, e.extra);
  }
  if (isCanonError(e)) return new HttpsError(e.code, e.message, e.extra);
  return new HttpsError("internal", String((e && e.message) || e));
}
const authed = (req) => { const uid = req.auth && req.auth.uid; if (!uid) throw new HttpsError("unauthenticated", "Sign in required."); return uid; };

// Canonical-only callables (fail with unavailable until cutover).
exports.createRecording = onCall({ region: "us-central1" }, async (req) => {
  const uid = authed(req);
  try { return await canon().createRecording(uid, req.data || {}); } catch (e) { throw toHttpsError(e); }
});
exports.retranscribe = onCall({ region: "us-central1", secrets: ["ASSEMBLYAI_KEY", "ANTHROPIC_KEY", "TRANSCRIBE_WEBHOOK_SECRET"] }, async (req) => {
  const uid = authed(req);
  const { id, opId } = req.data || {};
  try { return await canon().retranscribe(uid, String(id), String(opId || "")); } catch (e) { throw toHttpsError(e); }
});
exports.deleteRecording = onCall({ region: "us-central1" }, async (req) => {
  const uid = authed(req);
  const { id, opId } = req.data || {};
  try { return await canon().deleteRecording(uid, String(id), String(opId || "")); } catch (e) { throw toHttpsError(e); }
});
// Trusted {generation,size,crc32c} of the recording's audio object: the JS
// SDK cannot read crc32c, and the phone must not adopt an object it did not
// write without checking the bytes.
exports.audioDescriptor = onCall({ region: "us-central1" }, async (req) => {
  const uid = authed(req);
  const { id } = req.data || {};
  if (typeof id !== "string") throw new HttpsError("invalid-argument", "id required");
  return { audio: await canon().audioDescriptor(uid, id) };
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
  if ((await phase()) === "canonical") {
    const id = needId(req, res); if (!id) return;
    const u = await canon().audioUrl(req.uid, id);
    return u ? res.redirect(302, u) : res.status(404).json({ error: "not found" });
  }
  const q = await resolveLegacy(req, res);
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
// /tmp is a tmpfs on Cloud Functions, so every byte downloaded here counts
// against this memory limit alongside ffmpeg's own usage. The byte budget
// below is sized against it; raising one without the other trades a clean
// error for an OOM kill.
const MERGE_MAX_BYTES = 1_500_000_000;

// Runs fn over items with at most `limit` in flight. A long recording is
// hundreds of segments; firing them all at once trades one bottleneck for a
// burst of sockets.
async function pooled(items, limit, fn) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (let i = next++; i < items.length; i = next++) await fn(items[i], i);
    })
  );
}

exports.mergeAudio = onCall(
  { region: "us-central1", memory: "4GiB", timeoutSeconds: 540 },
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

    // No "already exists, skip" shortcut here. dest is the recording's own
    // object, and a failed take leaves a stub there — the first segment that
    // was uploaded before the merge gave up. Treating that as a finished merge
    // reports success, and the caller then marks a 3-minute stub transcribable
    // in place of the hour it stands for.

    // Fail with something readable rather than being OOM-killed mid-ffmpeg.
    let total = 0;
    await pooled(segments, 16, async (p) => {
      const [md] = await bucket.file(p).getMetadata();
      total += Number(md.size || 0);
    });
    if (total > MERGE_MAX_BYTES) {
      throw new HttpsError(
        "invalid-argument",
        `segments total ${Math.round(total / 1e6)}MB, over the ${Math.round(
          MERGE_MAX_BYTES / 1e6
        )}MB merge budget — split the recording.`
      );
    }

    const work = await fsp.mkdtemp(path.join(os.tmpdir(), "merge-"));
    try {
      // Downloading one at a time made the round trips, not the bytes, the
      // cost: a 20-segment hour spent most of a minute waiting. Bounded so a
      // long recording doesn't open hundreds of sockets at once.
      const local = new Array(segments.length);
      await pooled(segments, 8, async (seg, i) => {
        const f = path.join(work, `seg${String(i).padStart(4, "0")}.m4a`);
        await bucket.file(seg).download({ destination: f });
        local[i] = f;
      });
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
// Questions allowed per share per day. Generous for a reader, useless for
// anyone trying to run up the bill.
const ASK_DAILY_LIMIT = 50;

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

      // This endpoint is public — a share id is the only thing gating it — and
      // every call spends the project's Anthropic budget. Capping the prompt
      // bounds one call; this bounds the number of them. The counter lives on
      // the share doc, so it costs no extra read.
      const today = new Date().toISOString().slice(0, 10);
      const askedToday = s.askDay === today ? s.askCount || 0 : 0;
      if (askedToday >= ASK_DAILY_LIMIT) {
        res.status(429).json({ error: "daily question limit reached" });
        return;
      }
      snap.ref
        .set({ askDay: today, askCount: askedToday + 1 }, { merge: true })
        .catch(() => {});

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
async function saveJson(p, obj) {
  await bkt().file(p).save(JSON.stringify(obj, null, 2), { contentType: "application/json" });
}

// Every sidecar write goes through here: the Mac's PATCH, the phone's callable,
// the transcription starter and the webhook. Read the object with its
// generation, let the caller mutate that exact content, save only if the
// generation is unchanged, and on a precondition failure re-read and retry
// once. Two writers can no longer each read, each decide, and the second
// quietly erase the first — which is how a finished transcription or a
// confirmed label could vanish.
async function mutateSidecar(path, fn) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const file = bkt().file(path);
    let meta = {}, generation = 0;
    try {
      const [md] = await file.getMetadata();
      generation = Number(md.generation);
      const [buf] = await file.download({ ifGenerationMatch: generation });
      meta = JSON.parse(buf.toString());
    } catch (e) {
      if (!(e && e.code === 404)) throw e;
    }
    const out = await fn(meta, generation);
    if (out === null) return { meta, generation, saved: false };
    try {
      await file.save(JSON.stringify(out, null, 2), {
        contentType: "application/json",
        preconditionOpts: { ifGenerationMatch: generation },
      });
      return { meta: out, generation, saved: true };
    } catch (e) {
      if (!(e && e.code === 412)) throw e;
      // Someone wrote in between. Re-read and apply ours over the new state.
    }
  }
  throw new Error("sidecar changed twice during one write; try again");
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
    const ph = await phase();
    const c = name.match(/^rec2\/([^/]+)\/([^/]+)\/audio\.m4a$/);
    if (c) {
      if (ph !== "canonical") return; // inert until cutover (migration copies land here first)
      const [, uid, id] = c;
      const r = await canon().audioFinalized(uid, id, event.data.generation);
      if (r && (r.set || r.stub)) await canon().maybeStart(uid, id);
      return;
    }
    if (name.startsWith("rec2/") || name.startsWith("rec2-archive/") || name.startsWith("rec2-quarantine/")) return;
    if (ph !== "legacy") return; // frozen: no new legacy jobs; canonical: legacy is dead
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
    // An empty speakers list means "transcribe, count unknown" — diarization
    // runs with no floor and finds its own number. It used to mean "skip",
    // which is why every recording recovered from the cache imported its audio
    // and then silently never transcribed.
    if (!Array.isArray(meta.speakers)) return;

    const m4a = `recordings/${uid}/${folder}/${base}.m4a`;
    const [audioExists] = await bkt().file(m4a).exists();
    if (!audioExists) return; // audio not up yet (m4a normally uploads first)

    // One job per (recording, transcript revision), keyed by the recording's
    // stable id rather than its path, so a later move cannot create a second
    // identity for the same job. The revision is bumped on the sidecar first,
    // under the generation check, so a concurrent writer cannot race it.
    let revision;
    try {
      const r = await mutateSidecar(name, async (cur) => {
        if (!cur || cur.transcriptStatus !== "pending") return null;
        revision = Number(cur.transcriptRevision || 0) + 1;
        return { ...cur, transcriptRevision: revision, transcriptStatus: "processing",
                 fieldsUpdatedAt: { ...(cur.fieldsUpdatedAt || {}) } };
      });
      if (!r.saved) return; // someone else took it, or it is no longer pending
    } catch (e) {
      console.error("startTranscription claim", base, String((e && e.message) || e));
      return;
    }
    const lockId = sha256(`${uid}:${meta.id}:${revision}`);
    const lockRef = admin.firestore().collection("transcriptions").doc(lockId);
    const acquired = await admin.firestore().runTransaction(async (tx) => {
      const d = await tx.get(lockRef);
      if (d.exists) return false;
      tx.set(lockRef, {
        uid, folder, base, recordingId: meta.id, revision,
        // Written BEFORE the paid request. If the response is lost we must
        // not resubmit: the webhook will still arrive, carrying this lockId
        // in its URL, and complete the job. Never deleted — a terminal record
        // is what stops a retry from paying twice.
        status: "submitted-unconfirmed",
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
      // The speaker count is a FLOOR, not just a ceiling: left to itself the
      // model can return one label for a two-person conversation. The ceiling
      // is one above, so an unexpected extra voice gets its own label rather
      // than being merged into someone else. Mirrors src/transcription.ts.
      if (meta.speakers.length) {
        body.speaker_options = {
          min_speakers_expected: Math.max(1, meta.speakers.length),
          max_speakers_expected: Math.max(2, meta.speakers.length + 1),
        };
      }
      const su = speakerIdentification(meta);
      if (su) body.speech_understanding = su;
      const lang = LANG_CODES[meta.language];
      if (lang) {
        body.language_code = lang;
      } else {
        // Detection beats a wrong pin, and code switching keeps English terms
        // intact inside a French conversation. Mirrors src/transcription.ts.
        body.language_detection = true;
        body.language_detection_options = { code_switching: true };
      }
      // Our own job id travels in the URL (AssemblyAI passes query params
      // through), so the callback can find its lock even when we never got
      // the transcript id back.
      body.webhook_url = `https://${process.env.GCLOUD_PROJECT}.web.app/hooks/transcription?job=${lockId}`;
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
      // transcriptStatus was already set to "processing" when the revision
      // was claimed; nothing to write here, and no stale snapshot to save.
    } catch (e) {
      // The request may or may not have reached AssemblyAI. Keep the lock as
      // the record of that ambiguity; a human or the webhook resolves it.
      const msg = String((e && e.message) || e);
      await lockRef.set({ status: "submit-failed", error: msg.slice(0, 300) }, { merge: true }).catch(() => {});
      try {
        await mutateSidecar(name, async (cur) =>
          cur && Number(cur.transcriptRevision || 0) === revision && cur.transcriptStatus === "processing"
            ? { ...cur, transcriptStatus: "error" }
            : null);
      } catch {}
      console.error("startTranscription", base, msg);
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
      if (typeof req.query.id === "string") {
        // Canonical job. The uid travels in the URL too, so the lookup is a
        // direct document read; the lock id is still what authorizes it.
        const ph = await phase();
        if (ph !== "canonical") return res.status(200).json({ ok: true, note: "recorded; phase " + ph });
        const r = await canon().webhook({ uid: String(req.query.uid || ""), id: req.query.id, lockId: String(req.query.job || ""), payload: req.body });
        return res.status(200).json({ ok: true, ...r });
      }
      if ((await phase()) === "canonical") return res.status(200).json({ ok: true, note: "legacy job after cutover; ignored" });

      // Our job id comes back in the URL, so a job whose submit response was
      // lost (no transcriptId stored) is still found. transcriptId is the
      // fallback for jobs created before the URL carried it.
      let lockRef = null, job = null;
      const jobId = typeof req.query.job === "string" && /^[0-9a-f]{64}$/.test(req.query.job) ? req.query.job : null;
      if (jobId) {
        const d = await admin.firestore().collection("transcriptions").doc(jobId).get();
        if (d.exists) { lockRef = d.ref; job = d.data(); }
      }
      if (!job) {
        const snap = await admin.firestore().collection("transcriptions")
          .where("transcriptId", "==", transcriptId).limit(1).get();
        if (!snap.empty) { lockRef = snap.docs[0].ref; job = snap.docs[0].data(); }
      }
      if (!job) return res.status(200).json({ ok: true, note: "no matching job" });
      // A 2xx here is deliberate: a 4xx stops AssemblyAI retrying and a 5xx
      // asks for retries of something we have decided not to process.
      if (job.status === "done" || job.status === "error") {
        return res.status(200).json({ ok: true, note: "already final" });
      }
      await lockRef.set({ transcriptId, status: job.status === "submitted-unconfirmed" ? "processing" : job.status }, { merge: true });
      const metaPath = `recordings/${job.uid}/${job.folder}/${job.base}.json`;
      const prefix = `recordings/${job.uid}/${job.folder}/${job.base}`;

      // Current sidecar, to check this callback is for the live revision. A
      // callback from an older run must not replace a newer transcript.
      let current = {};
      try { current = await readJson(metaPath); } catch {}
      if (job.revision && Number(current.transcriptRevision || 0) !== Number(job.revision)) {
        await lockRef.set({ status: "superseded" }, { merge: true });
        return res.status(200).json({ ok: true, note: "superseded by a newer transcription" });
      }
      // Stable per job: a retried callback must stamp the same instant, or it
      // beats labels the owner set after the first delivery.
      const transcribedAt = job.transcribedAt || new Date().toISOString();
      if (!job.transcribedAt) await lockRef.set({ transcribedAt }, { merge: true });

      const patchMeta = async (patch) => {
        const r = await mutateSidecar(metaPath, async (cur) => {
          if (job.revision && Number((cur || {}).transcriptRevision || 0) !== Number(job.revision)) return null;
          return { ...(cur || {}), ...patch };
        });
        return r.meta;
      };

      if (status !== "completed") {
        await patchMeta({ transcriptStatus: "error" });
        await lockRef.set({ status: "error" }, { merge: true });
        return res.status(200).json({ ok: true });
      }

      const data = await (
        await fetch(`${AAI}/transcript/${transcriptId}`, {
          headers: { authorization: process.env.ASSEMBLYAI_KEY },
        })
      ).json();
      const utterances = data.utterances || [];
      const speakers = job.speakers || [];
      // AssemblyAI reads the whole transcript for identification; our own pass
      // only sees a sample, so it's the fallback when nothing comes back.
      const identified = acceptSpeakerMapping(
        (((data.speech_understanding || {}).response || {}).speaker_identification || {}).mapping,
        utterances.map((u) => u.text).join(" "),
        speakers
      );
      // Two automatic sources, recorded as such: AssemblyAI's identification
      // when it had per-person evidence, else Claude's guess. Neither is ever
      // "verified" — only the owner confirming on the phone or the Mac is.
      const claudeMap = identified
        ? null
        : await inferSpeakerMap(utterances, speakers, process.env.ANTHROPIC_KEY);
      const speakerMap = identified || claudeMap || null;
      const speakerLabels = {};
      const labelStamps = {};
      for (const [letter, name] of Object.entries(speakerMap || {})) {
        speakerLabels[letter] = { name, by: identified ? "aai" : "claude", at: transcribedAt };
        labelStamps[`speakerLabels.${letter}`] = transcribedAt;
      }
      const text = renderTranscript(utterances, speakers, speakerMap);
      const topic = await inferTopic(text, process.env.ANTHROPIC_KEY);
      const audioDurationSec = data.audio_duration || 0;

      await bkt().file(prefix + ".txt").save(text, { contentType: "text/plain" });
      await bkt().file(prefix + ".aai.json").save(JSON.stringify(utterances), { contentType: "application/json" });
      let meta = await patchMeta({
        transcriptStatus: "done",
        speakerMap: speakerMap,
        // Re-transcription resets labels: letters can change between runs.
        // Stamped with the job's own time so the phone's merge sees the reset
        // as newer than labels made against the previous run.
        speakerLabels,
        speakerId: null,
        fieldsUpdatedAt: { ...(current.fieldsUpdatedAt || {}), ...labelStamps, speakerId: transcribedAt },
        topic: topic,
        aaiTranscriptId: transcriptId,
        // What AssemblyAI says it ran, read from the job — never assumed.
        speechModelUsed: data.speech_model || data.speech_model_used || null,
        audioDurationSec,
        transcribedAt,
        estCostUsd: (audioDurationSec / 3600) * AAI_RATE_PER_HOUR,
        // Record what the audio actually was, so it stops saying "Auto".
        ...(job.language && LANG_CODES[job.language]
          ? {}
          : data.language_code
            ? { language: LANG_NAMES[data.language_code] || data.language_code }
            : {}),
      });
      // A cap-stopped take reports durationSeconds 0 from the phone; AAI's
      // measured audio length is ground truth, so backfill it server-side.
      if (!meta.durationSeconds && audioDurationSec) {
        meta = await patchMeta({ durationSeconds: Math.round(audioDurationSec) });
      }

      if (meta.shareId) {
        // meta came out of the uploaded sidecar, so shareId is whatever the
        // client put there — and this runs with admin rights, which bypass the
        // Firestore rules. Without an ownership check anyone who knows one of
        // someone else's /r/<id> links could name it here and have their own
        // transcript published in its place.
        const shareRef = admin.firestore().doc(`shares/${meta.shareId}`);
        const shareSnap = await shareRef.get().catch(() => null);
        const ownsShare =
          shareSnap && shareSnap.exists && shareSnap.data().ownerUid === job.uid;
        if (ownsShare) {
          await shareRef
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
        } else {
          console.warn(
            `share ${meta.shareId} not owned by ${job.uid} — not updating`
          );
        }
      }
      await lockRef.set({ status: "done" }, { merge: true }).catch(() => {});
      res.status(200).json({ ok: true });
    } catch (e) {
      console.error("transcriptionWebhook", String((e && e.message) || e));
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  }
);


// Repairs what a crash between steps leaves behind: starts pending
// recordings whose audio is up, turns a claim that never got its POST
// response into needs-review, and polls jobs whose webhook never came.
exports.transcriptionSweep = onSchedule(
  { region: "us-central1", schedule: "every 15 minutes", secrets: TRANSCRIBE_SECRETS, timeoutSeconds: 300 },
  async () => { console.log(JSON.stringify(await canon().sweepAll())); }
);

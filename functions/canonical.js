// Canonical recording model: one Firestore document per recording is the
// record of truth; Storage holds only immutable blobs under rec2/{uid}/{id}/.
// Every state change that must be atomic (claim, publish, supersede, patch,
// delete) is a single-document transaction, and every transaction body is a
// pure function of the snapshot it read, so a re-run body makes the same
// decision. The only non-transactional side effects are blob writes (made
// create-only, adopted on retry) and the paid AssemblyAI POST (ambiguity is
// resolved by the sweep, never by resubmitting under the same revision).
//
// Built as a factory so tests inject the emulator's db/bucket and a fake
// AssemblyAI; index.js wires the production instances.
const crypto = require("crypto");
const lib = require("./lib");

// An ISO instant, optionally with a short suffix (a split recording such as
// 2026-07-27T14:31:53.488Z-5h). Mirrored in storage.rules.
const ID_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z(-[A-Za-z0-9]{1,8})?$/;
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

const CLAIMED_STALE_MS = 10 * 60 * 1000;
const SUBMITTED_STALE_MS = 2 * 60 * 60 * 1000;
const SUBMITTED_DEAD_MS = 24 * 60 * 60 * 1000;
const ATTEMPTS_KEPT = 20;
const OPS_KEPT = 50;
// No take is longer than 10h (AssemblyAI's ceiling), so a live link still
// open after this was orphaned by a crash.
const LIVE_SHARE_MAX_MS = 12 * 60 * 60 * 1000;
// Live diarization scratch (_live/<epoch ms>/) is only read during the take.
const LIVE_SCRATCH_MAX_MS = 24 * 60 * 60 * 1000;

// frozen: admitted legacy jobs may still finish; sealed: nothing legacy is
// admitted at all (the migrator copies under sealed); canonical: cut over.
// rolling-back: the migrator is deleting its own copies; nothing is admitted.
const PHASES = ["legacy", "frozen", "sealed", "rolling-back", "canonical"];

class CanonError extends Error {
  constructor(code, message, extra) { super(message); this.code = code; this.extra = extra || {}; }
}

// Allowed attempt-state transitions. Anything not listed is a no-op, which is
// what makes a duplicate or late event harmless by construction.
const ATTEMPT_NEXT = {
  claimed: ["submitted", "needs-review", "published", "failed", "superseded"],
  submitted: ["published", "failed", "superseded"],
  "needs-review": ["submitted", "published", "failed", "superseded"],
  published: [],
  failed: [],
  superseded: ["audit"],
  audit: [],
};
const canMove = (from, to) => (ATTEMPT_NEXT[from] || []).includes(to);

function makeCanonical({ db, bucket, fetchImpl, env, now, signer, isOwner }) {
  const sign = signer || ((file, opts) => file.getSignedUrl(opts));
  // Who may spend the AssemblyAI/Anthropic budget; index.js passes the owner
  // check, tests run as owner.
  const ownerOk = isOwner || (async () => true);
  const clock = now || (() => new Date());
  const iso = () => clock().toISOString();
  const doFetch = fetchImpl || fetch;
  const docRef = (uid, id) => db.collection("recordings").doc(uid).collection("items").doc(id);
  const phaseRef = () => db.collection("config").doc("migration");
  const shareRef = (shareId) => db.collection("shares").doc(shareId);
  const blob = (uid, id, name) => bucket.file(`rec2/${uid}/${id}/${name}`);
  const audioName = "audio.m4a";
  const txtName = (rev) => `transcript-r${rev}.txt`;
  const aaiName = (rev) => `utterances-r${rev}.aai.json`;

  async function readPhase(tx) {
    const s = tx ? await tx.get(phaseRef()) : await phaseRef().get();
    // No document yet means the migration never started. A document with a
    // value this build does not know is NOT legacy: it admits nothing, so a
    // typo or a newer tool can never silently reopen the old pipeline.
    if (!s.exists) return "legacy";
    const p = s.data().phase;
    return PHASES.includes(p) ? p : "sealed";
  }
  async function setPhase(phase, by) {
    if (!PHASES.includes(phase)) throw new CanonError("invalid-argument", "bad phase");
    await phaseRef().set({ phase, changedAt: iso(), by: by || "unknown" });
  }

  // Folders whose recordings are private whatever the switch says (routes.json
  // defaults.private, mirrored as alwaysPrivate in placement.local.ts). The
  // list is personal, so it lives in config/privacy, written by
  // tools/backfill-always-private.js, not in this public repo.
  async function alwaysPrivateFolders() {
    const s = await db.collection("config").doc("privacy").get();
    const list = s.exists && Array.isArray(s.data().alwaysPrivateFolders) ? s.data().alwaysPrivateFolders : [];
    return list.map((f) => String(f).toLowerCase());
  }
  // Privacy only goes up from a folder's default: moving into such a folder,
  // or a newer-stamped private:false while there, still ends private. The
  // stamp is the server's, after any client stamp, so every merge accepts it.
  function forcePrivate(doc, folders) {
    if (doc.private === true || !folders.includes(String(doc.folder || "").toLowerCase())) return doc;
    const fu = doc.fieldsUpdatedAt || {};
    const at = new Date(Math.max(clock().getTime(), Date.parse(fu.private || 0) + 1)).toISOString();
    return { ...doc, private: true, fieldsUpdatedAt: { ...fu, private: at } };
  }
  const isPrivateDoc = (doc, folders) => doc.private === true || folders.includes(String(doc.folder || "").toLowerCase());

  // ---- public share links ----
  // A share doc is readable by anyone holding its id. Closing one leaves a
  // content-free tombstone rather than deleting it: firestore.rules refuse to
  // read or update a revoked share, so neither a phone's live updater nor a
  // stale publish can bring the transcript back under the same id.
  async function revokeShare(uid, shareId, reason) {
    if (typeof shareId !== "string" || !shareId) return false;
    return db.runTransaction(async (tx) => {
      const s = await tx.get(shareRef(shareId));
      if (!s.exists || s.data().ownerUid !== uid) return false;
      if (s.data().revoked === true) return true;
      tx.set(shareRef(shareId), { ownerUid: uid, revoked: true, revokedAt: iso(), reason });
      return true;
    });
  }
  // A private or deleted recording has no public link, and a live (QR) link
  // closes once its take is saved: it was for the room, not for the final
  // named transcript. Runs after every write that can change either.
  async function enforceShare(uid, id, doc) {
    const shareId = doc && doc.shareId;
    if (!shareId) return null;
    let reason = doc.deletedAt ? "deleted" : isPrivateDoc(doc, await alwaysPrivateFolders()) ? "private" : null;
    if (!reason) {
      const s = await shareRef(shareId).get();
      if (s.exists && s.data().ownerUid === uid && "live" in s.data()) reason = "live take ended";
    }
    if (!reason) return null;
    await revokeShare(uid, shareId, reason);
    const t = iso();
    await mutate(uid, id, (cur) => (cur.shareId === shareId
      ? { doc: { ...cur, shareId: null, shareDirty: null, fieldsUpdatedAt: { ...(cur.fieldsUpdatedAt || {}), shareId: t } } }
      : null));
    return reason;
  }

  // Every mutation: read phase + doc in one transaction, require canonical,
  // apply a pure body, write. `body(doc)` returns the new doc or null (no-op).
  // `opId` makes a mutation replay-safe: the result of the first run is
  // stored on the doc and returned again for the same opId.
  async function mutate(uid, id, body, { opId, allowMissing, requirePhase = "canonical" } = {}) {
    return db.runTransaction(async (tx) => {
      const phase = await readPhase(tx);
      if (requirePhase && phase !== requirePhase) {
        throw new CanonError("unavailable", `phase is ${phase}`, { phase });
      }
      const ref = docRef(uid, id);
      const snap = await tx.get(ref);
      const cur = snap.exists ? snap.data() : null;
      if (!cur && !allowMissing) throw new CanonError("not-found", "not found");
      if (opId && cur && cur.ops && cur.ops[opId]) return { doc: cur, result: cur.ops[opId], replayed: true };
      const out = body(cur ? clone(cur) : null);
      if (out === null) return { doc: cur, result: null, replayed: false };
      const next = out.doc;
      next.updatedAt = iso();
      if (opId) {
        const ops = { ...(next.ops || {}) };
        ops[opId] = { at: next.updatedAt, ...(out.result || {}) };
        next.ops = trimMap(ops, OPS_KEPT, "at");
      }
      next.attempts = trimMap(next.attempts || {}, ATTEMPTS_KEPT, "rev", (k, v) => k === next.active || (next.current && next.current.lockId === k) || !!(v.txt || v.aai));
      tx.set(ref, next);
      return { doc: next, result: out.result || null, replayed: false };
    });
  }

  function newDoc(uid, id, fields) {
    const t = iso();
    return {
      id, uid, schema: 2,
      folder: "Inbox", base: id, note: null, place: null, inputName: null,
      speakers: [], speakerLabels: {}, speakerId: null, meIncluded: null, tags: [], private: false,
      language: "", recordedAt: t, durationSeconds: 0, owner: null, topic: null, summary: null, speakerMap: null,
      fieldsUpdatedAt: {},
      ...fields,
      audio: null, rev: 0, active: null, attempts: {}, current: null, status: "none",
      ops: {}, deletedAt: null, purge: null, migration: null, createdAt: t, updatedAt: t,
    };
  }

  // ---- createRecording ----
  async function createRecording(uid, data) {
    const { id, opId, ...rest } = data || {};
    if (typeof id !== "string" || !ID_RE.test(id)) throw new CanonError("invalid-argument", "bad id");
    const fields = {};
    for (const [k, v] of Object.entries(rest)) {
      if (!lib.CLIENT_FIELDS.includes(k) && !lib.CREATE_ONLY_FIELDS.includes(k)) continue;
      if (lib.CLIENT_FIELDS.includes(k) && !lib.validField(k, v)) throw new CanonError("invalid-argument", `bad value for ${k}`);
      fields[k] = v;
    }
    const folders = await alwaysPrivateFolders();
    const r = await mutate(uid, id, (cur) => {
      if (!cur) return { doc: forcePrivate(newDoc(uid, id, fields), folders), result: { created: true } };
      if (cur.deletedAt) throw new CanonError("failed-precondition", "tombstoned");
      if (cur.stub) {
        // Audio landed before the create: adopt the stub, keep its audio and
        // anything the pipeline already did with it.
        const { stub, ...keep } = cur;
        return { doc: forcePrivate({ ...newDoc(uid, id, fields), ...keep, ...fields }, folders), result: { created: true, adoptedStub: true } };
      }
      return { doc: cur, result: { created: false } };
    }, { opId, allowMissing: true });
    const closed = await enforceShare(uid, id, r.doc);
    return { ...r.result, doc: project(closed ? await docRef(uid, id).get().then((s) => s.data()) : r.doc) };
  }

  // ---- audio finalize ----
  // Called with the LIVE object's metadata (the caller HEADs it); the event's
  // own generation is only used to detect a stale event.
  async function audioFinalized(uid, id, eventGeneration) {
    if (!ID_RE.test(id)) return { ignored: "bad id" };
    const file = blob(uid, id, audioName);
    let md;
    try { [md] = await file.getMetadata(); } catch (e) { if (e.code === 404) return { ignored: "gone" }; throw e; }
    const live = { generation: String(md.generation), size: Number(md.size), crc32c: md.crc32c, uploadedAt: iso() };
    if (eventGeneration && String(eventGeneration) !== live.generation) return { ignored: "stale event" };
    const r = await mutate(uid, id, (cur) => {
      if (!cur) return { doc: { ...newDoc(uid, id, {}), stub: true, audio: live, status: "pending" }, result: { stub: true } };
      if (cur.deletedAt) return { doc: { ...cur, purge: { ...(cur.purge || {}), strayAudio: live.generation } }, result: { tombstoned: true } };
      if (cur.audio && cur.audio.generation === live.generation) return null;
      if (cur.audio) {
        console.error("audio generation changed under create-only rules", uid, id, cur.audio.generation, live.generation);
        return null;
      }
      return { doc: { ...cur, audio: live, status: cur.status === "none" ? "pending" : cur.status }, result: { set: true } };
    }, { allowMissing: true });
    if (r.result && r.result.tombstoned) {
      await file.delete({ ifGenerationMatch: live.generation }).catch(() => {});
      return { deletedStray: true };
    }
    return r.result || { noop: true };
  }

  // ---- maybeStart: the single owner of revision allocation ----
  async function maybeStart(uid, id, { rerunForEdit = false } = {}) {
    // Every paid job starts here, including audio uploaded without a create.
    if (!(await ownerOk(uid))) return { started: false, refused: "not the owner" };
    // The claim is whatever the COMMITTED transaction returned: a body that
    // ran, lost the conflict and re-ran against someone else's claim returns
    // null, and nothing is submitted here.
    const r = await mutate(uid, id, (cur) => {
      if (cur.deletedAt || !cur.audio || cur.status !== "pending" || cur.active) return null;
      const rev = Number(cur.rev || 0) + 1;
      const lockId = sha256(`${uid}:${id}:${rev}`);
      const t = iso();
      const attempts = { ...cur.attempts, [lockId]: { rev, state: "claimed", aaiTranscriptId: null, sourceAudioGeneration: cur.audio.generation, createdAt: t, updatedAt: t, languageAtSubmit: cur.language || "", speakersAtSubmit: cur.speakers || [], ...(rerunForEdit ? { rerunForEdit: true } : {}) } };
      return { doc: { ...cur, rev, active: lockId, attempts, status: "processing" }, result: { claimed: { rev, lockId, sourceAudioGeneration: cur.audio.generation } } };
    });
    const claimed = r.result && r.result.claimed;
    if (!claimed) return { started: false };
    const doc = r.doc;
    let created;
    try {
      created = await submitToAai(uid, id, doc, claimed);
    } catch (e) {
      // Ambiguous: the POST may have landed. Leave the attempt claimed; the
      // sweep turns it into needs-review and a late webhook still resolves it.
      console.error("maybeStart submit", id, String((e && e.message) || e));
      // AssemblyAI answered and said no (a 4xx other than a rate limit):
      // nothing was created, so it is a failure, not a lost answer.
      if (e && e.definitive) {
        await mutate(uid, id, (cur) => {
          const a = cur.attempts && cur.attempts[claimed.lockId];
          if (!a || !canMove(a.state, "failed")) return null;
          const attempts = { ...cur.attempts, [claimed.lockId]: { ...a, state: "failed", error: String(e.message).slice(0, 300), updatedAt: iso() } };
          const isActive = cur.active === claimed.lockId;
          return { doc: { ...cur, attempts, active: isActive ? null : cur.active, status: isActive ? "failed" : cur.status } };
        });
        return { started: false, failed: true };
      }
      return { started: true, submitted: false, lockId: claimed.lockId };
    }
    await mutate(uid, id, (cur) => {
      const a = cur.attempts && cur.attempts[claimed.lockId];
      if (!a) return null;
      if (!canMove(a.state, "submitted")) {
        // The webhook beat us (published) or the attempt was superseded.
        if (a.aaiTranscriptId) return null;
        return { doc: { ...cur, attempts: { ...cur.attempts, [claimed.lockId]: { ...a, aaiTranscriptId: created.id } } } };
      }
      // A late response to a claim the sweep already flagged: back to a
      // normal in-flight job.
      const status = cur.active === claimed.lockId && cur.status === "stuck" ? "processing" : cur.status;
      return { doc: { ...cur, status, attempts: { ...cur.attempts, [claimed.lockId]: { ...a, state: "submitted", aaiTranscriptId: created.id, updatedAt: iso() } } } };
    });
    return { started: true, submitted: true, lockId: claimed.lockId, aaiTranscriptId: created.id };
  }

  async function submitToAai(uid, id, doc, claimed) {
    const [signed] = await sign(blob(uid, id, audioName), {
      version: "v4", action: "read", expires: Date.now() + 6 * 60 * 60 * 1000,
      queryParams: { generation: claimed.sourceAudioGeneration },
    });
    // Who the owner is lives in the cloud profile (tools/push-owner-profile.js);
    // a phone that stamped its own wins for that recording.
    let owner = doc.owner;
    if (!owner || !owner.name) {
      const p = await db.collection("ownerProfiles").doc(uid).get();
      if (p.exists && p.data().name) owner = { name: p.data().name, bio: p.data().bio || "" };
    }
    const body = lib.aaiRequestBody({ ...doc, owner }, signed);
    body.webhook_url = `https://${env.GCLOUD_PROJECT}.web.app/hooks/transcription?job=${claimed.lockId}&id=${encodeURIComponent(id)}&uid=${uid}`;
    body.webhook_auth_header_name = "x-mixtape-secret";
    body.webhook_auth_header_value = env.TRANSCRIBE_WEBHOOK_SECRET;
    const res = await doFetch(`${lib.AAI}/transcript`, {
      method: "POST",
      headers: { authorization: env.ASSEMBLYAI_KEY, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const created = await res.json().catch(() => null);
    if (!created || !created.id) {
      const err = new Error("AAI create failed: " + JSON.stringify(created).slice(0, 200));
      err.definitive = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
      throw err;
    }
    return created;
  }

  // ---- webhook ----
  // Returns {status, note}; the HTTP layer always answers 2xx once auth passed
  // (a 4xx stops AssemblyAI retrying, a 5xx asks for retries of a decision).
  async function webhook({ uid, id, lockId, payload }) {
    if (!ID_RE.test(id) || !/^[0-9a-f]{64}$/.test(lockId || "")) return { note: "bad params" };
    const transcriptId = payload && payload.transcript_id;
    if (!transcriptId) return { note: "no transcript_id" };
    const whRef = docRef(uid, id).collection("webhooks").doc(`${transcriptId}:${payload.status || "?"}`);
    await whRef.set({ uid, id, lockId, payload, receivedAt: iso(), processed: false }, { merge: true });
    const out = await webhookBody({ uid, id, lockId, payload, transcriptId });
    await whRef.set({ processed: true, note: out.note, processedAt: iso() }, { merge: true }).catch(() => {});
    return out;
  }
  // Stores a callback that arrived while the pipeline could not act on it
  // (wrong phase); the sweep replays it once the phase allows.
  async function recordDeferredWebhook({ uid, id, lockId, payload }) {
    if (!ID_RE.test(id || "") || !payload || !payload.transcript_id) return;
    await docRef(uid, id).collection("webhooks").doc(`${payload.transcript_id}:${payload.status || "?"}`)
      .set({ uid, id, lockId, payload, receivedAt: iso(), processed: false, deferred: true }, { merge: true });
  }
  async function webhookBody({ uid, id, lockId, payload, transcriptId }) {

    const snap = await docRef(uid, id).get();
    if (!snap.exists) return { note: "unknown recording" };
    const doc = snap.data();
    // A job that finishes after a delete writes nothing, pays for no
    // post-processing, and AssemblyAI's copy is deleted too. The purge may
    // already have stripped the attempts, so this can't wait for the lock.
    if (doc.deletedAt) {
      if (payload.status === "completed" && transcriptId) {
        await doFetch(`${lib.AAI}/transcript/${transcriptId}`, { method: "DELETE", headers: { authorization: env.ASSEMBLYAI_KEY } }).catch(() => {});
      }
      return { note: "recording deleted; transcript not kept" };
    }
    const a = doc.attempts && doc.attempts[lockId];
    if (!a) return { note: "unknown lock; recorded, ignored" };
    if (doc.current && doc.current.lockId === lockId) return { note: "duplicate after publish" };
    if (a.state === "published" || a.state === "failed" || a.state === "audit") return { note: "terminal; ignored" };
    if (a.aaiTranscriptId && a.aaiTranscriptId !== transcriptId) return { note: "transcript id mismatch; ignored" };

    if (payload.status !== "completed") {
      await mutate(uid, id, (cur) => {
        const at = cur.attempts[lockId];
        if (!at || !canMove(at.state, "failed")) return null;
        const attempts = { ...cur.attempts, [lockId]: { ...at, state: "failed", aaiTranscriptId: transcriptId, error: String(payload.error || payload.status), updatedAt: iso() } };
        const isActive = cur.active === lockId;
        return { doc: { ...cur, attempts, active: isActive ? null : cur.active, status: isActive ? "failed" : cur.status } };
      });
      return { note: "failed" };
    }

    const res = await doFetch(`${lib.AAI}/transcript/${transcriptId}`, { headers: { authorization: env.ASSEMBLYAI_KEY } });
    const data = res && res.ok !== false ? await res.json() : null;
    // Fail closed: the transcript must be the one named, completed, and made
    // from exactly this recording's audio object and generation.
    if (!data || data.id !== transcriptId || data.status !== "completed") return { note: "transcript not completed at AAI; ignored" };
    const gen = genFromAudioUrl(data.audio_url);
    const objectPath = `rec2/${uid}/${id}/${audioName}`;
    // A signed URL percent-encodes the id's colons; compare decoded paths.
    const objectOk = typeof data.audio_url === "string" && decodedPath(data.audio_url).includes(objectPath);
    if (!objectOk) return { note: "audio object mismatch; ignored" };
    if (!gen || gen !== String(a.sourceAudioGeneration)) return { note: "audio generation mismatch; ignored" };

    const rev = a.rev;
    const prov = { lockId, aaiTranscriptId: transcriptId, rev, sourceAudioGeneration: a.sourceAudioGeneration };
    // Post-processing (Claude speaker inference, topic) is not deterministic,
    // so a retried delivery reuses the FIRST run's result: it is persisted as
    // a create-only artifact before any transcript bytes are written.
    const postName = `post-r${rev}.json`;
    let post = await readOwnArtifact(uid, id, postName, prov);
    if (!post) {
      const fresh = await lib.postProcess(data, doc, env, doFetch);
      await writeArtifact(uid, id, postName, JSON.stringify(fresh), "application/json", prov);
      post = await readOwnArtifact(uid, id, postName, prov);
      if (!post) throw new Error("post artifact exists with different provenance");
    }
    const utterances = post.utterances || [];
    const txt = await writeArtifact(uid, id, txtName(rev), post.text, "text/plain", prov);
    const aai = await writeArtifact(uid, id, aaiName(rev), JSON.stringify(utterances), "application/json", prov);

    const transcribedAt = a.transcribedAt || iso();
    const r = await mutate(uid, id, (cur) => {
      const at = cur.attempts[lockId];
      if (!at) return null;
      if (cur.current && cur.current.lockId === lockId) return null;
      const t = iso();
      if (cur.active !== lockId || !canMove(at.state, "published")) {
        if (!canMove(at.state, "audit")) return null;
        return { doc: { ...cur, attempts: { ...cur.attempts, [lockId]: { ...at, state: "audit", aaiTranscriptId: transcriptId, txt, aai, updatedAt: t } } }, result: { audit: true } };
      }
      // Labels: a first transcript seeds only letters the owner has not set
      // by hand; a re-transcription resets them all (letters are new voices),
      // stamped with the job's time so a phone merge sees the reset as newer.
      const firstRun = !cur.current;
      const labelStamps = {};
      const speakerLabels = {};
      if (firstRun) {
        for (const [L, v] of Object.entries(cur.speakerLabels || {})) if (v && v.by === "user") speakerLabels[L] = v;
      }
      for (const [letter, name] of Object.entries(post.speakerMap || {})) {
        if (speakerLabels[letter]) continue;
        speakerLabels[letter] = { name, by: post.identified ? "aai" : "claude", at: transcribedAt };
        labelStamps[`speakerLabels.${letter}`] = transcribedAt;
      }
      const keepOwner = firstRun && cur.speakerId && speakerLabels[cur.speakerId] && speakerLabels[cur.speakerId].by === "user";
      const current = { rev, lockId, aaiTranscriptId: transcriptId, sourceAudioGeneration: at.sourceAudioGeneration, txt, aai, post: { name: postName }, publishedAt: t, producer: "aai", speechModelUsed: post.speechModelUsed, transcribedAt };
      const attempts = { ...cur.attempts, [lockId]: { ...at, state: "published", aaiTranscriptId: transcriptId, txt, aai, updatedAt: t, transcribedAt } };
      const speakerMap = Object.fromEntries(Object.entries(speakerLabels).map(([L, v]) => [L, v.name]));
      // The owner changed the language (or the names fed to identification)
      // while this job ran: what it produced is in the wrong language or
      // without the names. Publish it, then run again once, automatically.
      const langStamp = (cur.fieldsUpdatedAt || {}).language || "";
      const spkStamp = (cur.fieldsUpdatedAt || {}).speakers || "";
      const changedMeanwhile =
        (langStamp > at.createdAt && (cur.language || "") !== (at.languageAtSubmit || "")) ||
        (spkStamp > at.createdAt && JSON.stringify(cur.speakers || []) !== JSON.stringify(at.speakersAtSubmit || []));
      const doc2 = {
        ...cur, attempts, active: null, current, status: changedMeanwhile ? "pending" : "done",
        // Which voices this transcript has: the phone colours by these, not
        // by labels left from an earlier run.
        speakerKeys: Array.from(new Set(utterances.map((u) => u.speaker))).sort(),
        // The review step (review.js) runs on every new transcript. On a
        // re-run it needs the names the owner had settled, by the old
        // voices, to find them again among the new ones.
        reviewDue: { rev, at: t },
        // Newest first: a name the last run did not settle is still found
        // in the one before.
        priorLabels: firstRun ? null : priorLabelsAfter(cur),
        // Each re-run needs a new edit made after its own start, so this
        // cannot loop; a second change during the automatic re-run counts.
        rerunQueued: changedMeanwhile ? { afterRev: rev, reason: "language or speakers changed while the job ran" } : null,
        speakerMap: Object.keys(speakerMap).length ? speakerMap : null, speakerLabels, speakerId: keepOwner ? cur.speakerId : null,
        fieldsUpdatedAt: { ...(cur.fieldsUpdatedAt || {}), ...labelStamps, ...(keepOwner ? {} : { speakerId: transcribedAt }),
          // The inferred title is a server edit of a client field: stamped,
          // or no phone merge would ever accept it over its blank.
          ...(post.topic && post.topic !== cur.topic && !(cur.fieldsUpdatedAt || {}).topic ? { topic: transcribedAt } : {}) },
        topic: (cur.fieldsUpdatedAt || {}).topic ? cur.topic : post.topic || cur.topic, aaiTranscriptId: transcriptId, speechModelUsed: post.speechModelUsed,
        audioDurationSec: post.audioDurationSec, transcribedAt, estCostUsd: post.estCostUsd,
        durationSeconds: cur.durationSeconds || Math.round(post.audioDurationSec || 0),
        // The owner's choice stays theirs; what detection found is shown apart.
        ...(post.language ? { language: post.language } : {}),
        detectedLanguage: post.detectedLanguage || null,
        // Derived share doc is updated after this commit; the marker makes
        // the sweep finish it if we die in between.
        shareDirty: cur.shareId ? { shareId: cur.shareId, rev } : null,
      };
      return { doc: doc2, result: { published: true } };
    });
    if (r.result && r.result.published) await syncShare(uid, id);
    if (r.result && r.result.published && r.doc.rerunQueued) {
      await mutate(uid, id, (cur) => (cur.rerunQueued ? { doc: { ...cur, rerunQueued: null } } : null));
      await maybeStart(uid, id, { rerunForEdit: true });
    }
    return r.result && r.result.published ? { note: "published", rev } : r.result && r.result.audit ? { note: "audit", rev } : { note: "no-op" };
  }

  // Pushes the published transcript into the public share doc, then clears
  // the marker; idempotent, so the sweep can retry it.
  async function syncShare(uid, id) {
    const snap = await docRef(uid, id).get();
    const d = snap.data();
    if (!d || !d.shareDirty || !d.current) return false;
    // Never publish into a link that must be closed; closing clears the marker.
    if (await enforceShare(uid, id, d)) return true;
    const post = await readOwnArtifact(uid, id, d.current.post.name, { lockId: d.current.lockId, aaiTranscriptId: d.current.aaiTranscriptId });
    if (!post) return false;
    const ok = await pushShare(d.shareDirty.shareId, uid, {
      utterances: post.utterances || [], speakerMap: lib.publicSpeakerMap(d), topic: d.topic,
      durationSeconds: d.durationSeconds || 0, speakers: d.speakers, language: lib.shownLanguage(d),
    }, d.current.rev);
    if (!ok) return false;
    await mutate(uid, id, (cur) => (cur.shareDirty && cur.shareDirty.rev === d.shareDirty.rev ? { doc: { ...cur, shareDirty: null } } : null));
    return true;
  }

  // lib.updateShare, plus: a revoked share stays a tombstone.
  async function pushShare(shareId, uid, fields, rev) {
    try {
      return await db.runTransaction(async (tx) => {
        const s = await tx.get(shareRef(shareId));
        if (!s.exists || s.data().ownerUid !== uid) { console.warn(`share not owned by ${uid}`); return false; }
        if (s.data().revoked === true) return true;
        if (Number(s.data().transcriptRev || 0) > rev) return true; // newer already there
        tx.set(shareRef(shareId), { ...fields, transcriptRev: rev }, { merge: true });
        return true;
      });
    } catch (e) {
      console.error("pushShare", String((e && e.message) || e));
      return false;
    }
  }

  // Reads an artifact only if it carries this attempt's provenance.
  async function readOwnArtifact(uid, id, name, prov) {
    const file = blob(uid, id, name);
    let md;
    try { [md] = await file.getMetadata(); } catch (e) { if (e.code === 404) return null; throw e; }
    const m = md.metadata || {};
    if (m.lockId !== prov.lockId || m.aaiTranscriptId !== prov.aaiTranscriptId) return null;
    const [buf] = await file.download({ ifGenerationMatch: Number(md.generation) });
    return JSON.parse(buf.toString());
  }

  // Create-only artifact write. On 412, adopt the existing object iff it was
  // written by this same attempt (custom metadata) and its bytes match.
  async function writeArtifact(uid, id, name, content, contentType, meta) {
    const file = blob(uid, id, name);
    const crc = crc32cBase64(Buffer.from(content));
    const metadata = { contentType, metadata: { ...stringify(meta), crc32c: crc } };
    const adopt = async () => {
      const [md] = await file.getMetadata();
      const m = md.metadata || {};
      if (m.lockId !== meta.lockId || m.aaiTranscriptId !== String(meta.aaiTranscriptId) || md.crc32c !== crc) throw new Error(`artifact ${name} exists with different provenance`);
      return { name, generation: String(md.generation), size: Number(md.size), crc32c: md.crc32c };
    };
    // Look before writing (the emulator ignores preconditions; production
    // GCS enforces the one below as well, which closes the race).
    if ((await file.exists())[0]) return adopt();
    try {
      await file.save(content, { metadata, preconditionOpts: { ifGenerationMatch: 0 }, resumable: false });
    } catch (e) {
      if (!(e && e.code === 412)) throw e;
      return adopt();
    }
    const [md] = await file.getMetadata();
    return { name, generation: String(md.generation), size: Number(md.size), crc32c: md.crc32c };
  }

  // ---- sweep ----
  async function sweepOne(uid, id) {
    const snap = await docRef(uid, id).get();
    if (!snap.exists) return null;
    const d = snap.data();
    const age = (t) => clock().getTime() - Date.parse(t || 0);
    if (!d.deletedAt && d.audio && d.status === "pending" && !d.active) return maybeStart(uid, id);
    const a = d.active && d.attempts[d.active];
    if (!a) return null;
    if (a.state === "claimed" && age(a.updatedAt) > CLAIMED_STALE_MS) {
      const lockId = d.active;
      const r = await mutate(uid, id, (cur) => {
        const at = cur.attempts[lockId];
        if (!at || cur.active !== lockId || at.state !== "claimed" || age(at.updatedAt) <= CLAIMED_STALE_MS) return null;
        return { doc: { ...cur, status: "stuck", attempts: { ...cur.attempts, [lockId]: { ...at, state: "needs-review", updatedAt: iso() } } }, result: { needsReview: lockId } };
      });
      return r.result;
    }
    if (d.shareDirty) await syncShare(uid, id);
    if (a.state === "submitted" && a.aaiTranscriptId && age(a.updatedAt) > SUBMITTED_STALE_MS) {
      const data = await (await doFetch(`${lib.AAI}/transcript/${a.aaiTranscriptId}`, { headers: { authorization: env.ASSEMBLYAI_KEY } })).json();
      if (data.status === "completed" || data.status === "error") {
        return webhook({ uid, id, lockId: d.active, payload: { transcript_id: a.aaiTranscriptId, status: data.status, error: data.error } });
      }
      // Still not done a day after submit: AssemblyAI is not finishing it.
      if (age(a.createdAt || a.updatedAt) > SUBMITTED_DEAD_MS) {
        return webhook({ uid, id, lockId: d.active, payload: { transcript_id: a.aaiTranscriptId, status: "error", error: `not finished after 24 h (${data.status})` } });
      }
    }
    return null;
  }
  async function sweepAll() {
    if ((await readPhase()) !== "canonical") return { skipped: true };
    const out = [];
    const q = await db.collectionGroup("items").where("status", "in", ["pending", "processing", "stuck"]).get();
    const dirty = await db.collectionGroup("items").where("shareDirty", "!=", null).get();
    for (const s of dirty.docs) { const d = s.data(); try { await syncShare(d.uid, d.id); } catch (e) { out.push([d.id, "share: " + String((e && e.message) || e)]); } }
    const pending = await db.collectionGroup("webhooks").where("processed", "==", false).get();
    for (const w of pending.docs) { const p = w.data(); try { out.push([p.id, await webhook({ uid: p.uid, id: p.id, lockId: p.lockId, payload: p.payload })]); } catch (e) { out.push([p.id, "replay: " + String((e && e.message) || e)]); } }
    for (const s of q.docs) {
      const d = s.data();
      try { out.push([d.id, await sweepOne(d.uid, d.id)]); } catch (e) { out.push([d.id, String((e && e.message) || e)]); }
    }
    // Guarded like the live sweep: cleanup must never stop the transcription
    // repair above from running (a missing index would throw here).
    try {
      const purges = await db.collectionGroup("items").where("purgePending", "==", true).get();
      for (const s of purges.docs) { const d = s.data(); try { await purge(d.uid, d.id); out.push([d.id, "purged"]); } catch (e) { out.push([d.id, "purge: " + String((e && e.message) || e)]); } }
    } catch (e) { out.push(["purge", String((e && e.message) || e)]); }
    try { out.push(["live", await sweepLive()]); } catch (e) { out.push(["live", String((e && e.message) || e)]); }
    return { swept: out };
  }

  // Closes live links a crash orphaned (the phone keeps their id only in
  // memory) or that ended without a saved take, and deletes live diarization
  // scratch audio once its take is long over: each pass's merged.m4a was
  // handed out as a download URL that works for as long as the object exists.
  async function sweepLive() {
    let shares = 0, scratch = 0;
    const live = await db.collection("shares").where("live", "in", [true, false]).get();
    for (const s of live.docs) {
      const d = s.data();
      if (d.live === true && clock().getTime() - Date.parse(d.createdAt || 0) < LIVE_SHARE_MAX_MS) continue;
      if (await revokeShare(d.ownerUid, s.id, d.live === false ? "live take ended" : "live link expired")) shares++;
    }
    const [files] = await bucket.getFiles({ prefix: "recordings/", matchGlob: "recordings/*/_live/**" });
    for (const f of files) {
      if (!/^recordings\/[^/]+\/_live\/\d+\//.test(f.name)) continue;
      if (clock().getTime() - Date.parse(f.metadata.updated || f.metadata.timeCreated || 0) < LIVE_SCRATCH_MAX_MS) continue;
      await f.delete().catch(() => {});
      scratch++;
    }
    return { shares, scratch };
  }

  // ---- retranscribe / delete / patch ----
  async function retranscribe(uid, id, opId) {
    if (!opId) throw new CanonError("invalid-argument", "opId required");
    const r = await mutate(uid, id, (cur) => {
      if (cur.deletedAt) throw new CanonError("failed-precondition", "tombstoned");
      if (!cur.audio) throw new CanonError("failed-precondition", "no audio");
      const t = iso();
      const attempts = { ...cur.attempts };
      if (cur.active && attempts[cur.active] && canMove(attempts[cur.active].state, "superseded")) {
        attempts[cur.active] = { ...attempts[cur.active], state: "superseded", updatedAt: t };
      }
      return { doc: { ...cur, attempts, active: null, status: "pending" }, result: { queued: true } };
    }, { opId });
    if (!r.replayed) await maybeStart(uid, id);
    return r.result;
  }

  async function deleteRecording(uid, id, opId) {
    if (!opId) throw new CanonError("invalid-argument", "opId required");
    const r = await mutate(uid, id, (cur) => {
      if (cur.deletedAt) return { doc: cur, result: { deletedAt: cur.deletedAt } };
      const t = iso();
      const attempts = { ...cur.attempts };
      if (cur.active && attempts[cur.active] && canMove(attempts[cur.active].state, "superseded")) {
        attempts[cur.active] = { ...attempts[cur.active], state: "superseded", updatedAt: t };
      }
      return { doc: { ...cur, attempts, active: null, status: "none", deletedAt: t, purgePending: true }, result: { deletedAt: t } };
    }, { opId });
    // The tombstone is committed, so nothing can recreate or republish the
    // recording; what follows is cleanup, which the sweep retries.
    await purge(uid, id).catch((e) => console.error("purge", id, String((e && e.message) || e)));
    return r.result;
  }

  // Deletes everything a tombstoned recording left: its public link, every
  // blob under rec2/<uid>/<id>/ (audio, transcripts, utterances, post, the
  // per-recording voice embeddings voices-r*.json), its live segments, and
  // every content field of the document. Enrolled voice samples
  // (recordings/<uid>/_voiceprint/) are shared by all recordings and are not
  // touched. The tombstone keeps only what blocks a re-create and makes the
  // delete replay-safe.
  async function purge(uid, id) {
    const snap = await docRef(uid, id).get();
    if (!snap.exists || !snap.data().deletedAt) return false;
    const d = snap.data();
    if (d.shareId) await revokeShare(uid, d.shareId, "deleted");
    for (const prefix of [`rec2/${uid}/${id}/`, `recordings/${uid}/_live/${id}/`]) {
      const [files] = await bucket.getFiles({ prefix });
      await Promise.all(files.map((f) => f.delete().catch((e) => { if (e.code !== 404) throw e; })));
    }
    await mutate(uid, id, (cur) => (cur.deletedAt
      ? { doc: { id, uid, schema: cur.schema || 2, deletedAt: cur.deletedAt, status: "none", rev: cur.rev || 0, active: null, current: null, audio: null,
          attempts: {}, ops: cur.ops || {}, purge: cur.purge || null, createdAt: cur.createdAt || null, purgePending: null, purgedAt: iso() } }
      : null));
    return true;
  }

  async function patch(uid, id, body, ownerName) {
    const folders = await alwaysPrivateFolders();
    const r = await mutate(uid, id, (cur) => {
      if (cur.deletedAt) throw new CanonError("failed-precondition", "tombstoned");
      const out = lib.applyPatch(cur, body, ownerName, { revision: cur.current ? cur.current.rev : 0, now: clock().getTime() });
      return { doc: forcePrivate(out.meta, folders), result: { applied: out.applied } };
    });
    const applied = r.result ? r.result.applied : [];
    const closed = await enforceShare(uid, id, r.doc);
    if (closed) return { applied, doc: project((await docRef(uid, id).get()).data()) };
    // A naming edit reaches the public share of the same transcript.
    const d = r.doc;
    if (d.shareId && d.current && !d.shareDirty && applied.some((k) => k.startsWith("speakerLabels."))) {
      await pushShare(d.shareId, uid, { speakerMap: lib.publicSpeakerMap(d) }, d.current.rev);
    }
    return { applied, doc: project(d) };
  }

  // ---- reads ----
  async function get(uid, id) {
    const s = await docRef(uid, id).get();
    if (!s.exists || s.data().deletedAt) return null;
    return s.data();
  }
  async function list(uid, { since } = {}) {
    let q = db.collection("recordings").doc(uid).collection("items").where("deletedAt", "==", null);
    const snap = await q.get();
    return snap.docs.map((d) => d.data()).filter((d) => !d.stub && (!since || Date.parse(d.recordedAt || 0) >= since));
  }
  function artifactFor(doc, kind, rev) {
    if (!doc.current && rev == null) return null;
    const r = rev == null ? doc.current.rev : Number(rev);
    if (doc.current && doc.current.rev === r) return doc.current[kind];
    // Only revisions that were once current are readable; audit artifacts
    // (a superseded job that finished late) are kept for forensics only.
    const a = Object.values(doc.attempts || {}).find((x) => x.rev === r && x[kind] && x.state === "published");
    return a ? a[kind] : null;
  }
  async function readArtifact(uid, id, kind, rev) {
    const doc = await get(uid, id);
    if (!doc) return null;
    const d = artifactFor(doc, kind, rev);
    if (!d) return null;
    const [buf] = await blob(uid, id, d.name).download({ ifGenerationMatch: Number(d.generation) });
    return { content: buf, rev: Number(d.name.match(/-r(\d+)\./)[1]) };
  }
  async function audioUrl(uid, id) {
    const doc = await get(uid, id);
    if (!doc || !doc.audio) return null;
    const [signed] = await sign(blob(uid, id, audioName), {
      version: "v4", action: "read", expires: Date.now() + 15 * 60 * 1000,
      queryParams: { generation: doc.audio.generation },
    });
    return signed;
  }
  // The phone cannot read crc32c through the JS SDK; this is the trusted
  // descriptor it compares against before adopting an existing audio object.
  async function audioDescriptor(uid, id) {
    const [md] = await blob(uid, id, audioName).getMetadata().catch(() => [null]);
    return md ? { generation: String(md.generation), size: Number(md.size), crc32c: md.crc32c, md5: md.md5Hash || null } : null;
  }

  // The document as clients and the API see it: no attempts/ops internals,
  // legacy-shaped status and attribution so comm-relay and the phone keep
  // reading the same fields.
  function project(d) {
    if (!d) return null;
    const { attempts, ops, stub, purge, ...rest } = d;
    const transcriptStatus = { none: "none", pending: "pending", processing: "processing", stuck: "stuck", done: "done", failed: "error" }[d.status] || d.status;
    return {
      ...rest, transcriptStatus,
      transcriptRevision: d.current ? d.current.rev : 0,
      ...lib.ownerAttribution(d),
      speech_model_used: d.speechModelUsed || undefined,
    };
  }

  return {
    ID_RE, CanonError, readPhase, setPhase, createRecording, audioFinalized, maybeStart, webhook, recordDeferredWebhook, syncShare, sweepOne, sweepAll,
    retranscribe, deleteRecording, purge, patch, get, list, readArtifact, audioUrl, audioDescriptor, project, docRef, blob,
    alwaysPrivateFolders, isPrivateDoc, revokeShare, enforceShare, sweepLive,
    _internal: { canMove, mutate },
  };
}

function priorLabelsAfter(cur) {
  // Only the owner's own names: a review's "auto" is not their word, and
  // letting it cover an older revision dropped the name they did give.
  const keep = Object.fromEntries(Object.entries(cur.speakerLabels || {}).filter(([, l]) => l && l.by === "user"));
  const older = [].concat(cur.priorLabels || []).filter((p) => p && p.rev !== cur.current.rev);
  const list = Object.keys(keep).length ? [{ rev: cur.current.rev, labels: keep }, ...older] : older;
  // An older transcript is kept only while it holds a name no newer one has.
  const covered = new Set();
  const kept = list.filter((p) => {
    const names = Object.values(p.labels || {}).map((l) => l.name);
    const adds = names.some((n) => !covered.has(n));
    names.forEach((n) => covered.add(n));
    return adds;
  }).slice(0, 5);
  return kept.length ? kept : null;
}
function decodedPath(u) {
  try { return decodeURIComponent(new URL(u).pathname); } catch { return String(u); }
}
function genFromAudioUrl(u) {
  try { return new URL(u).searchParams.get("generation"); } catch { return null; }
}
function stringify(o) { return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v)])); }
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function trimMap(map, keep, timeKey, pin) {
  const entries = Object.entries(map);
  if (entries.length <= keep) return map;
  entries.sort((a, b) => {
    const x = a[1][timeKey], y = b[1][timeKey];
    return typeof x === "number" && typeof y === "number" ? y - x : String(y || "").localeCompare(String(x || ""));
  });
  const out = {};
  for (const [k, v] of entries) if (Object.keys(out).length < keep || (pin && pin(k, v))) out[k] = v;
  return out;
}

// CRC32C (Castagnoli), base64 like GCS reports it.
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32cBase64(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  c = (c ^ 0xffffffff) >>> 0;
  const b = Buffer.alloc(4);
  b.writeUInt32BE(c);
  return b.toString("base64");
}

module.exports = { makeCanonical, ID_RE, CanonError, crc32cBase64, PHASES, priorLabelsAfter };

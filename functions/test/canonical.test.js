// Runs against the Firestore + Storage emulators:
//   npm test   (see package.json: firebase emulators:exec wraps node --test)
const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");
const { makeCanonical, crc32cBase64 } = require("../canonical");

const PROJECT = "demo-mixtape";
const BUCKET = "demo-mixtape.appspot.com";
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_STORAGE_EMULATOR_HOST) {
  throw new Error("run under firebase emulators:exec (FIRESTORE_EMULATOR_HOST / FIREBASE_STORAGE_EMULATOR_HOST)");
}
admin.initializeApp({ projectId: PROJECT, storageBucket: BUCKET });
const db = admin.firestore();
const bucket = admin.storage().bucket();
const UID = "u1";
const ID = "2026-10-25T10:00:00.000Z";

// A fake AssemblyAI + Anthropic. Each test configures what POST /transcript
// and GET /transcript/:id return, and can throw to simulate a lost response.
function fakeAai() {
  const state = { posts: [], gets: [], postResult: null, postThrow: false, transcript: null, onPost: null };
  const f = async (url, opts = {}) => {
    const u = String(url);
    if (u.endsWith("/v2/transcript") && opts.method === "POST") {
      state.posts.push(JSON.parse(opts.body));
      if (state.onPost) await state.onPost(JSON.parse(opts.body));
      if (state.postThrow) throw new Error("socket hang up");
      return { json: async () => state.postResult || { id: "t1" } };
    }
    if (u.includes("/v2/transcript/")) {
      state.gets.push(u);
      return { json: async () => state.transcript };
    }
    if (u.includes("anthropic")) return { json: async () => ({ content: [{ type: "text", text: "Topic" }] }) };
    throw new Error("unexpected fetch " + u);
  };
  return { fetch: f, state };
}
const signer = async (file, opts) => [`https://signed.test/${file.name}?generation=${opts.queryParams.generation}`];

function build(aai, clockRef) {
  return makeCanonical({
    db, bucket, fetchImpl: aai.fetch, signer,
    env: { GCLOUD_PROJECT: PROJECT, ASSEMBLYAI_KEY: "k", TRANSCRIBE_WEBHOOK_SECRET: "s" },
    now: () => new Date(clockRef.t),
  });
}
const completed = (gen, extra = {}) => ({
  id: "t1", status: "completed",
  audio_url: `https://signed.test/rec2/${UID}/${ID}/audio.m4a?generation=${gen}`,
  utterances: [{ speaker: "A", start: 0, end: 1000, text: "Hello there" }, { speaker: "B", start: 1000, end: 2000, text: "Hi" }],
  audio_duration: 2, speech_model: "best", ...extra,
});

async function reset() {
  const [files] = await bucket.getFiles();
  await Promise.all(files.map((f) => f.delete().catch(() => {})));
  const snap = await db.collectionGroup("items").get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
  await db.collection("config").doc("migration").set({ phase: "canonical" });
}
async function uploadAudio(id = ID, bytes = "audio-bytes") {
  const f = bucket.file(`rec2/${UID}/${id}/audio.m4a`);
  await f.save(bytes, { contentType: "audio/mp4", resumable: false });
  const [md] = await f.getMetadata();
  return String(md.generation);
}
const docOf = async (id = ID) => (await db.collection("recordings").doc(UID).collection("items").doc(id).get()).data();

test("happy path: create, audio, claim, submit, webhook, publish, read", async () => {
  await reset();
  const aai = fakeAai(); const clock = { t: Date.parse("2026-10-25T12:00:00Z") };
  const c = build(aai, clock);
  const created = await c.createRecording(UID, { id: ID, folder: "Work", speakers: ["Basile", "Erica"], note: "n", opId: "op1" });
  assert.equal(created.created, true);
  assert.equal((await c.createRecording(UID, { id: ID, folder: "Other", opId: "op1" })).created, true, "same opId replays the first result");
  assert.equal((await docOf()).folder, "Work");
  const gen = await uploadAudio();
  const fin = await c.audioFinalized(UID, ID, gen);
  assert.equal(fin.set, true);
  const st = await c.maybeStart(UID, ID);
  assert.equal(st.submitted, true);
  let d = await docOf();
  assert.equal(d.rev, 1); assert.equal(d.status, "processing"); assert.equal(d.attempts[d.active].state, "submitted");
  assert.equal(aai.state.posts[0].audio_url, `https://signed.test/rec2/${UID}/${ID}/audio.m4a?generation=${gen}`);
  assert.match(aai.state.posts[0].webhook_url, new RegExp(`job=${st.lockId}&id=`));
  aai.state.transcript = completed(gen);
  const w = await c.webhook({ uid: UID, id: ID, lockId: st.lockId, payload: { transcript_id: "t1", status: "completed" } });
  assert.equal(w.note, "published");
  d = await docOf();
  assert.equal(d.status, "done"); assert.equal(d.active, null); assert.equal(d.current.rev, 1);
  assert.equal(d.current.txt.name, "transcript-r1.txt"); assert.equal(d.attempts[st.lockId].state, "published");
  const [md] = await bucket.file(`rec2/${UID}/${ID}/transcript-r1.txt`).getMetadata();
  assert.equal(md.crc32c, d.current.txt.crc32c); assert.equal(md.metadata.lockId, st.lockId);
  const t = await c.readArtifact(UID, ID, "txt");
  assert.equal(t.rev, 1); assert.match(t.content.toString(), /Hello there/);
  assert.equal((await c.webhook({ uid: UID, id: ID, lockId: st.lockId, payload: { transcript_id: "t1", status: "completed" } })).note, "duplicate after publish");
  assert.equal(c.project(d).transcriptStatus, "done");
  assert.equal((await c.list(UID)).length, 1);
});

test("phase gate: nothing mutates outside canonical", async () => {
  await reset();
  await db.collection("config").doc("migration").set({ phase: "legacy" });
  const c = build(fakeAai(), { t: Date.now() });
  await assert.rejects(c.createRecording(UID, { id: ID }), (e) => e.code === "unavailable");
  await db.collection("config").doc("migration").set({ phase: "frozen" });
  await assert.rejects(c.createRecording(UID, { id: ID }), (e) => e.code === "unavailable");
  await db.collection("config").doc("migration").set({ phase: "sealed" });
  await assert.rejects(c.createRecording(UID, { id: ID }), (e) => e.code === "unavailable");
  await db.collection("config").doc("migration").set({ phase: "rolling-back" });
  await assert.rejects(c.createRecording(UID, { id: ID }), (e) => e.code === "unavailable");
  await db.collection("config").doc("migration").set({ phase: "garbage" });
  assert.equal(await c.readPhase(), "sealed", "unknown phase values admit nothing");
  await db.collection("config").doc("migration").delete();
  assert.equal(await c.readPhase(), "legacy", "no phase document means legacy");
  const { _inflight } = require("../index.js");
  await db.collection("config").doc("migration").set({ phase: "rolling-back" });
  assert.equal(await _inflight.admit("patch", "x"), null, "nothing legacy admitted while rolling back");
  assert.deepEqual(await c.sweepAll(), { skipped: true });
});

test("lost POST response: stays claimed, sweep -> needs-review, late webhook still publishes", async () => {
  await reset();
  const aai = fakeAai(); const clock = { t: Date.parse("2026-10-25T12:00:00Z") };
  const c = build(aai, clock);
  await c.createRecording(UID, { id: ID });
  const gen = await uploadAudio();
  await c.audioFinalized(UID, ID, gen);
  aai.state.postThrow = true;
  const st = await c.maybeStart(UID, ID);
  assert.equal(st.submitted, false);
  let d = await docOf();
  assert.equal(d.attempts[st.lockId].state, "claimed");
  assert.equal(await c.sweepOne(UID, ID), null, "not stale yet");
  clock.t += 11 * 60 * 1000;
  assert.deepEqual(await c.sweepOne(UID, ID), { needsReview: st.lockId });
  d = await docOf(); assert.equal(d.status, "stuck");
  assert.equal(aai.state.posts.length, 1, "never resubmitted under the same revision");
  aai.state.transcript = completed(gen);
  const w = await c.webhook({ uid: UID, id: ID, lockId: st.lockId, payload: { transcript_id: "t1", status: "completed" } });
  assert.equal(w.note, "published");
  assert.equal((await docOf()).status, "done");
});

test("webhook arrives before the submit response is stored", async () => {
  await reset();
  const aai = fakeAai(); const clock = { t: Date.now() };
  const c = build(aai, clock);
  await c.createRecording(UID, { id: ID });
  const gen = await uploadAudio();
  await c.audioFinalized(UID, ID, gen);
  aai.state.transcript = completed(gen);
  aai.state.onPost = async (body) => {
    const lockId = new URL(body.webhook_url).searchParams.get("job");
    const w = await c.webhook({ uid: UID, id: ID, lockId, payload: { transcript_id: "t1", status: "completed" } });
    assert.equal(w.note, "published");
  };
  const st = await c.maybeStart(UID, ID);
  const d = await docOf();
  assert.equal(d.status, "done");
  assert.equal(d.attempts[st.lockId].state, "published", "submit response must not move published back to submitted");
  assert.equal(d.attempts[st.lockId].aaiTranscriptId, "t1");
});

test("concurrent duplicate callbacks: one publish, artifacts adopted", async () => {
  await reset();
  const aai = fakeAai(); const c = build(aai, { t: Date.now() });
  await c.createRecording(UID, { id: ID });
  const gen = await uploadAudio();
  await c.audioFinalized(UID, ID, gen);
  const st = await c.maybeStart(UID, ID);
  aai.state.transcript = completed(gen);
  const p = { transcript_id: "t1", status: "completed" };
  const rs = await Promise.all([1, 2, 3].map(() => c.webhook({ uid: UID, id: ID, lockId: st.lockId, payload: p })));
  const notes = rs.map((r) => r.note).sort();
  assert.equal(notes.filter((n) => n === "published").length, 1, notes.join(","));
  assert.ok(notes.every((n) => ["published", "no-op", "duplicate after publish"].includes(n)), notes.join(","));
  const d = await docOf(); assert.equal(d.current.rev, 1);
});

test("retranscribe: idempotent by opId; superseded callback becomes audit, never publishes", async () => {
  await reset();
  const aai = fakeAai(); const c = build(aai, { t: Date.now() });
  await c.createRecording(UID, { id: ID });
  const gen = await uploadAudio();
  await c.audioFinalized(UID, ID, gen);
  const first = await c.maybeStart(UID, ID);
  aai.state.postResult = { id: "t2" };
  await c.retranscribe(UID, ID, "re1");
  await c.retranscribe(UID, ID, "re1");
  let d = await docOf();
  assert.equal(d.rev, 2, "a replayed opId allocates nothing");
  assert.equal(d.attempts[first.lockId].state, "superseded");
  // The old job finishes late.
  aai.state.transcript = { ...completed(gen), id: "t1" };
  const late = await c.webhook({ uid: UID, id: ID, lockId: first.lockId, payload: { transcript_id: "t1", status: "completed" } });
  assert.equal(late.note, "audit");
  d = await docOf();
  assert.equal(d.current, null); assert.equal(d.attempts[first.lockId].state, "audit"); assert.equal(d.attempts[first.lockId].txt.name, "transcript-r1.txt");
  // The new one publishes r2.
  aai.state.transcript = { ...completed(gen), id: "t2" };
  assert.equal((await c.webhook({ uid: UID, id: ID, lockId: d.active, payload: { transcript_id: "t2", status: "completed" } })).note, "published");
  d = await docOf(); assert.equal(d.current.rev, 2);
  assert.equal(await c.readArtifact(UID, ID, "txt", 1), null, "an audit revision is never served");
});

test("provenance: a transcript made from another audio generation is ignored", async () => {
  await reset();
  const aai = fakeAai(); const c = build(aai, { t: Date.now() });
  await c.createRecording(UID, { id: ID });
  const gen = await uploadAudio();
  await c.audioFinalized(UID, ID, gen);
  const st = await c.maybeStart(UID, ID);
  aai.state.transcript = completed(String(Number(gen) + 1));
  assert.equal((await c.webhook({ uid: UID, id: ID, lockId: st.lockId, payload: { transcript_id: "t1", status: "completed" } })).note, "audio generation mismatch; ignored");
  assert.equal((await c.webhook({ uid: UID, id: ID, lockId: "0".repeat(64), payload: { transcript_id: "t1", status: "completed" } })).note, "unknown lock; recorded, ignored");
  assert.equal((await docOf()).status, "processing");
});

test("failed job: active attempt fails; error callback for a stale lock does not touch the active one", async () => {
  await reset();
  const aai = fakeAai(); const c = build(aai, { t: Date.now() });
  await c.createRecording(UID, { id: ID });
  await c.audioFinalized(UID, ID, await uploadAudio());
  const first = await c.maybeStart(UID, ID);
  aai.state.postResult = { id: "t2" };
  await c.retranscribe(UID, ID, "re");
  await c.webhook({ uid: UID, id: ID, lockId: first.lockId, payload: { transcript_id: "t1", status: "error", error: "x" } });
  let d = await docOf();
  assert.equal(d.status, "processing"); assert.equal(d.attempts[first.lockId].state, "superseded");
  await c.webhook({ uid: UID, id: ID, lockId: d.active, payload: { transcript_id: "t2", status: "error", error: "boom" } });
  d = await docOf();
  assert.equal(d.status, "failed"); assert.equal(d.active, null);
});

test("tombstone: delete is idempotent, blocks create, stray audio is removed", async () => {
  await reset();
  const c = build(fakeAai(), { t: Date.now() });
  await c.createRecording(UID, { id: ID });
  const r1 = await c.deleteRecording(UID, ID, "del1");
  const r2 = await c.deleteRecording(UID, ID, "del1");
  assert.equal(r1.deletedAt, r2.deletedAt);
  await assert.rejects(c.createRecording(UID, { id: ID }), (e) => e.code === "failed-precondition");
  const gen = await uploadAudio();
  assert.deepEqual(await c.audioFinalized(UID, ID, gen), { deletedStray: true });
  assert.equal((await bucket.file(`rec2/${UID}/${ID}/audio.m4a`).exists())[0], false);
  assert.equal(await c.get(UID, ID), null);
  assert.equal((await c.list(UID)).length, 0);
});

test("audio before create: stub adopted, transcription starts once", async () => {
  await reset();
  const aai = fakeAai(); const c = build(aai, { t: Date.now() });
  const gen = await uploadAudio();
  assert.deepEqual(await c.audioFinalized(UID, ID, gen), { stub: true });
  assert.equal((await c.list(UID)).length, 0, "stubs are not listed");
  assert.equal((await c.maybeStart(UID, ID)).started, true, "a stub with audio may transcribe; the create fills names later");
  const cr = await c.createRecording(UID, { id: ID, folder: "Work", speakers: ["A"] });
  assert.equal(cr.adoptedStub, true);
  const d = await docOf();
  assert.equal(d.folder, "Work"); assert.equal(d.audio.generation, gen); assert.equal(d.status, "processing"); assert.equal(d.stub, undefined);
  assert.equal(aai.state.posts.length, 1);
});

test("patch: allowlist, newest wins, server fields untouchable, folder is a field", async () => {
  await reset();
  const c = build(fakeAai(), { t: Date.parse("2026-10-25T12:00:00Z") });
  await c.createRecording(UID, { id: ID, folder: "Inbox" });
  const r = await c.patch(UID, ID, { folder: "Work", note: "x", fieldsUpdatedAt: { folder: "2026-10-25T11:00:00Z", note: "2026-10-25T11:00:00Z" } });
  assert.deepEqual(r.applied.sort(), ["folder", "note"]);
  const older = await c.patch(UID, ID, { folder: "Old", fieldsUpdatedAt: { folder: "2026-10-25T10:00:00Z" } });
  assert.deepEqual(older.applied, []); assert.equal(older.doc.folder, "Work");
  await assert.rejects(c.patch(UID, ID, { status: "done", fieldsUpdatedAt: { status: "2026-10-25T11:00:00Z" } }), /not a client-editable field/);
  await assert.rejects(c.patch(UID, ID, { folder: "_x", fieldsUpdatedAt: { folder: "2026-10-25T11:30:00Z" } }), /bad value/);
  assert.equal((await docOf()).status, "none");
});

test("attempt retention is bounded but keeps the active and published ones", async () => {
  await reset();
  const aai = fakeAai(); const c = build(aai, { t: Date.now() });
  await c.createRecording(UID, { id: ID });
  const gen = await uploadAudio();
  await c.audioFinalized(UID, ID, gen);
  let first = null;
  for (let i = 0; i < 25; i++) {
    aai.state.postResult = { id: "t" + i };
    const st = i === 0 ? await c.maybeStart(UID, ID) : null;
    if (st) first = st.lockId;
    if (i > 0) await c.retranscribe(UID, ID, "re" + i);
  }
  const d = await docOf();
  assert.ok(Object.keys(d.attempts).length <= 21, String(Object.keys(d.attempts).length));
  assert.ok(d.attempts[d.active]);
  assert.equal(d.attempts[first], undefined, "oldest superseded attempts are compacted away");
});

test("retention never drops an attempt that holds artifacts", async () => {
  await reset();
  const aai = fakeAai(); const c = build(aai, { t: Date.now() });
  await c.createRecording(UID, { id: ID });
  const gen = await uploadAudio();
  await c.audioFinalized(UID, ID, gen);
  const st = await c.maybeStart(UID, ID);
  aai.state.transcript = completed(gen);
  assert.equal((await c.webhook({ uid: UID, id: ID, lockId: st.lockId, payload: { transcript_id: "t1", status: "completed" } })).note, "published");
  for (let i = 2; i < 30; i++) { aai.state.postResult = { id: "t" + i }; await c.retranscribe(UID, ID, "re" + i); }
  const d = await docOf();
  assert.ok(d.attempts[st.lockId], "published r1 kept"); assert.equal(d.attempts[st.lockId].state, "published");
  assert.equal((await c.readArtifact(UID, ID, "txt", 1)).rev, 1);
});

test("webhook fails closed on a bad AssemblyAI response", async () => {
  await reset();
  const aai = fakeAai(); const c = build(aai, { t: Date.now() });
  await c.createRecording(UID, { id: ID });
  const gen = await uploadAudio();
  await c.audioFinalized(UID, ID, gen);
  const st = await c.maybeStart(UID, ID);
  const p = { transcript_id: "t1", status: "completed" };
  aai.state.transcript = { error: "not found" };
  assert.match((await c.webhook({ uid: UID, id: ID, lockId: st.lockId, payload: p })).note, /not completed/);
  aai.state.transcript = { ...completed(gen), id: "other" };
  assert.match((await c.webhook({ uid: UID, id: ID, lockId: st.lockId, payload: p })).note, /not completed/);
  aai.state.transcript = { ...completed(gen), audio_url: undefined };
  assert.match((await c.webhook({ uid: UID, id: ID, lockId: st.lockId, payload: p })).note, /object mismatch/);
  aai.state.transcript = { ...completed(gen), audio_url: `https://signed.test/rec2/${UID}/other/audio.m4a?generation=${gen}` };
  assert.match((await c.webhook({ uid: UID, id: ID, lockId: st.lockId, payload: p })).note, /object mismatch/);
  assert.equal((await docOf()).status, "processing");
  assert.equal((await bucket.file(`rec2/${UID}/${ID}/transcript-r1.txt`).exists())[0], false);
});

test("retry reuses the first delivery's post-processing; foreign artifact is a hard stop", async () => {
  await reset();
  const aai = fakeAai(); const c = build(aai, { t: Date.now() });
  await c.createRecording(UID, { id: ID });
  const gen = await uploadAudio();
  await c.audioFinalized(UID, ID, gen);
  const st = await c.maybeStart(UID, ID);
  // Someone else's bytes under our artifact name.
  await bucket.file(`rec2/${UID}/${ID}/post-r1.json`).save("{}", { resumable: false, metadata: { metadata: { lockId: "x", aaiTranscriptId: "t1" } } });
  aai.state.transcript = completed(gen);
  await assert.rejects(c.webhook({ uid: UID, id: ID, lockId: st.lockId, payload: { transcript_id: "t1", status: "completed" } }), /different provenance/);
  assert.equal((await docOf()).status, "processing");
});

test("first transcript keeps hand-set labels; re-transcription resets them", async () => {
  await reset();
  const aai = fakeAai(); const c = build(aai, { t: Date.parse("2026-10-25T12:00:00Z") });
  await c.createRecording(UID, { id: ID, speakers: ["Basile", "Erica"], owner: { name: "Basile" } });
  await c.patch(UID, ID, { speakerLabels: { A: { name: "Basile", by: "user", at: "2026-10-25T11:00:00Z" } }, speakerId: "A", expectedRevision: 0,
    fieldsUpdatedAt: { "speakerLabels.A": "2026-10-25T11:00:00Z", speakerId: "2026-10-25T11:00:00Z" } }, "Basile");
  const gen = await uploadAudio();
  await c.audioFinalized(UID, ID, gen);
  const st = await c.maybeStart(UID, ID);
  aai.state.transcript = completed(gen, { speech_understanding: { response: { speaker_identification: { mapping: { A: "Erica", B: "Basile" } } } } });
  await c.webhook({ uid: UID, id: ID, lockId: st.lockId, payload: { transcript_id: "t1", status: "completed" } });
  let d = await docOf();
  assert.equal(d.speakerLabels.A.by, "user"); assert.equal(d.speakerLabels.A.name, "Basile"); assert.equal(d.speakerId, "A");
  aai.state.postResult = { id: "t2" };
  await c.retranscribe(UID, ID, "re");
  aai.state.transcript = { ...completed(gen), id: "t2" };
  await c.webhook({ uid: UID, id: ID, lockId: (await docOf()).active, payload: { transcript_id: "t2", status: "completed" } });
  d = await docOf();
  assert.equal(d.speakerLabels.A, undefined, "letters mean new voices after a re-run"); assert.equal(d.speakerId, null);
});

test("share sync: marker survives a crash and the sweep finishes it", async () => {
  await reset();
  const aai = fakeAai(); const c = build(aai, { t: Date.now() });
  await db.doc("shares/sh1").set({ ownerUid: UID });
  await c.createRecording(UID, { id: ID, shareId: "sh1" });
  const gen = await uploadAudio();
  await c.audioFinalized(UID, ID, gen);
  const st = await c.maybeStart(UID, ID);
  aai.state.transcript = completed(gen);
  // Simulate the crash: publish, then wipe the share doc's update and re-arm the marker.
  await c.webhook({ uid: UID, id: ID, lockId: st.lockId, payload: { transcript_id: "t1", status: "completed" } });
  assert.ok((await db.doc("shares/sh1").get()).data().utterances);
  await db.doc("shares/sh1").set({ ownerUid: UID });
  await c.docRef(UID, ID).update({ shareDirty: { shareId: "sh1", rev: 1 } });
  await c.sweepAll();
  assert.ok((await db.doc("shares/sh1").get()).data().utterances, "sweep re-synced the share");
  assert.equal((await docOf()).shareDirty, null);
});

test("share sync: a failed write keeps the marker; an older revision never overwrites a newer share", async () => {
  await reset();
  const aai = fakeAai(); const c = build(aai, { t: Date.now() });
  await c.createRecording(UID, { id: ID, shareId: "sh2" }); // share doc does not exist yet -> write fails
  const gen = await uploadAudio();
  await c.audioFinalized(UID, ID, gen);
  const st = await c.maybeStart(UID, ID);
  aai.state.transcript = completed(gen);
  await c.webhook({ uid: UID, id: ID, lockId: st.lockId, payload: { transcript_id: "t1", status: "completed" } });
  assert.deepEqual((await docOf()).shareDirty, { shareId: "sh2", rev: 1 }, "marker kept");
  await db.doc("shares/sh2").set({ ownerUid: UID, transcriptRev: 5, topic: "newer" });
  await c.sweepAll();
  const sh = (await db.doc("shares/sh2").get()).data();
  assert.equal(sh.topic, "newer"); assert.equal(sh.transcriptRev, 5);
  assert.equal((await docOf()).shareDirty, null, "older sync is a no-op and clears its own marker");
});

test("a callback that arrived in the wrong phase is replayed by the sweep", async () => {
  await reset();
  const aai = fakeAai(); const c = build(aai, { t: Date.now() });
  await c.createRecording(UID, { id: ID });
  const gen = await uploadAudio();
  await c.audioFinalized(UID, ID, gen);
  const st = await c.maybeStart(UID, ID);
  await c.recordDeferredWebhook({ uid: UID, id: ID, lockId: st.lockId, payload: { transcript_id: "t1", status: "completed" } });
  aai.state.transcript = completed(gen);
  await c.sweepAll();
  assert.equal((await docOf()).status, "done");
});

test("crc32c helper matches GCS", async () => {
  const f = bucket.file("rec2/u/x/t.txt");
  await f.save("hello world", { resumable: false });
  const [md] = await f.getMetadata();
  assert.equal(crc32cBase64(Buffer.from("hello world")), md.crc32c);
});

test("legacy admission: open under legacy, webhooks only under frozen, closed under sealed", async () => {
  await reset();
  process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: "demo-mixtape", storageBucket: "demo-mixtape.appspot.com" });
  const { _inflight } = require("../index.js");
  const inflight = async () => (await db.collection("inflight").get()).size;
  for (const [phase, plain, hook] of [["legacy", true, true], ["frozen", false, true], ["sealed", false, false], ["canonical", false, false]]) {
    await db.collection("config").doc("migration").set({ phase });
    const r1 = await _inflight.admit("patch", "x");
    assert.equal(!!r1, plain, phase + " plain");
    const r2 = await _inflight.admit("webhook", "x", { allowFrozen: true });
    assert.equal(!!r2, hook, phase + " webhook");
    assert.equal(await inflight(), (plain ? 1 : 0) + (hook ? 1 : 0));
    for (const r of [r1, r2]) if (r) await r();
    assert.equal(await inflight(), 0, "released");
  }
});

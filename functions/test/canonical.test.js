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
  assert.equal((await c.readArtifact(UID, ID, "txt", 1)).rev, 1, "older revision still readable");
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

test("crc32c helper matches GCS", async () => {
  const f = bucket.file("rec2/u/x/t.txt");
  await f.save("hello world", { resumable: false });
  const [md] = await f.getMetadata();
  assert.equal(crc32cBase64(Buffer.from("hello world")), md.crc32c);
});

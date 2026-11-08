// Private recordings, public links, delete and the owner gate, against the
// Firestore + Storage emulators (npm test).
const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");
const { makeCanonical } = require("../canonical");

const PROJECT = "demo-mixtape";
const BUCKET = "demo-mixtape.appspot.com";
if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT, storageBucket: BUCKET });
const db = admin.firestore();
const bucket = admin.storage().bucket();
const UID = "u1";
const ID = "2026-10-25T10:00:00.000Z";

function fakeAai() {
  const state = { posts: [], transcript: null };
  const f = async (url, opts = {}) => {
    const u = String(url);
    if (u.endsWith("/v2/transcript") && opts.method === "POST") { state.posts.push(JSON.parse(opts.body)); return { json: async () => ({ id: "t1" }) }; }
    if (u.includes("/v2/transcript/")) return { json: async () => state.transcript };
    if (u.includes("anthropic")) return { json: async () => ({ content: [{ type: "text", text: "Topic" }] }) };
    throw new Error("unexpected fetch " + u);
  };
  return { fetch: f, state };
}
const signer = async (file, opts) => [`https://signed.test/${encodeURI(file.name).replace(/:/g, "%3A")}?generation=${opts.queryParams.generation}`];
const build = (aai, clock, extra = {}) => makeCanonical({
  db, bucket, fetchImpl: aai.fetch, signer,
  env: { GCLOUD_PROJECT: PROJECT, ASSEMBLYAI_KEY: "k", TRANSCRIBE_WEBHOOK_SECRET: "s" },
  now: () => new Date(clock.t), ...extra,
});
const completed = (gen) => ({
  id: "t1", status: "completed",
  audio_url: `https://signed.test/${encodeURI(`rec2/${UID}/${ID}/audio.m4a`).replace(/:/g, "%3A")}?generation=${gen}`,
  utterances: [{ speaker: "A", start: 0, end: 1000, text: "Hello there" }],
  audio_duration: 2, speech_model: "best",
});
async function reset() {
  const [files] = await bucket.getFiles();
  await Promise.all(files.map((f) => f.delete().catch(() => {})));
  for (const c of ["shares"]) { const s = await db.collection(c).get(); await Promise.all(s.docs.map((d) => d.ref.delete())); }
  const snap = await db.collectionGroup("items").get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
  await db.collection("config").doc("migration").set({ phase: "canonical" });
  await db.collection("config").doc("privacy").set({ alwaysPrivateFolders: ["self"] });
}
async function uploadAudio(id = ID) {
  const f = bucket.file(`rec2/${UID}/${id}/audio.m4a`);
  await f.save("audio-bytes", { contentType: "audio/mp4", resumable: false });
  return String((await f.getMetadata())[0].generation);
}
const docOf = async (id = ID) => (await db.collection("recordings").doc(UID).collection("items").doc(id).get()).data();
const share = async (id) => (await db.doc(`shares/${id}`).get()).data();
const exists = async (p) => (await bucket.file(p).exists())[0];

test("always-private folder: private on create, on a move in, and against a newer private:false", async () => {
  await reset();
  const clock = { t: Date.parse("2026-10-25T12:00:00Z") };
  const c = build(fakeAai(), clock);
  await c.createRecording(UID, { id: ID, folder: "Self", private: false });
  let d = await docOf();
  assert.equal(d.private, true, "folder match ignores case");
  assert.ok(d.fieldsUpdatedAt.private);
  await c.patch(UID, ID, { private: false, fieldsUpdatedAt: { private: "2026-10-25T13:00:00Z" } });
  d = await docOf();
  assert.equal(d.private, true);
  assert.ok(Date.parse(d.fieldsUpdatedAt.private) > Date.parse("2026-10-25T13:00:00Z"), "the server's stamp is after the client's");

  const ID2 = "2026-10-25T11:00:00.000Z";
  await c.createRecording(UID, { id: ID2, folder: "Inbox" });
  assert.equal((await docOf(ID2)).private, false);
  await c.patch(UID, ID2, { folder: "self", fieldsUpdatedAt: { folder: "2026-10-25T11:30:00Z" } });
  assert.equal((await docOf(ID2)).private, true, "moving in makes it private");
  await c.patch(UID, ID2, { folder: "Work", fieldsUpdatedAt: { folder: "2026-10-25T11:40:00Z" } });
  assert.equal((await docOf(ID2)).private, true, "moving out keeps it private");
  assert.equal(c.isPrivateDoc({ folder: "SELF", private: false }, await c.alwaysPrivateFolders()), true);
});

test("marking private closes the link; publishing into it later does nothing", async () => {
  await reset();
  const aai = fakeAai(); const c = build(aai, { t: Date.now() });
  await db.doc("shares/sh1").set({ ownerUid: UID, utterances: [{ text: "x" }] });
  await c.createRecording(UID, { id: ID, folder: "Work", shareId: "sh1" });
  assert.equal((await docOf()).shareId, "sh1", "a public recording keeps its link");
  const r = await c.patch(UID, ID, { private: true, fieldsUpdatedAt: { private: new Date().toISOString() } });
  assert.equal(r.doc.shareId, null, "the patch result already shows the link gone");
  const s = await share("sh1");
  assert.equal(s.revoked, true); assert.equal(s.utterances, undefined, "tombstone holds no content");
  assert.equal((await docOf()).shareId, null);

  // A private recording that gets a link anyway (phone offline, stale UI):
  // the patch that names it closes it.
  await db.doc("shares/sh2").set({ ownerUid: UID, utterances: [] });
  await c.patch(UID, ID, { shareId: "sh2", fieldsUpdatedAt: { shareId: new Date(Date.now() + 1000).toISOString() } });
  assert.equal((await share("sh2")).revoked, true);

  // The transcript never reaches a revoked share.
  const gen = await uploadAudio();
  await c.audioFinalized(UID, ID, gen);
  await c.docRef(UID, ID).update({ private: false, shareId: "sh1" });
  const st = await c.maybeStart(UID, ID);
  aai.state.transcript = completed(gen);
  await c.webhook({ uid: UID, id: ID, lockId: st.lockId, payload: { transcript_id: "t1", status: "completed" } });
  assert.equal((await share("sh1")).utterances, undefined);
  assert.equal((await share("sh1")).revoked, true);
});

test("a live link closes when its take is saved, and the sweep closes orphans", async () => {
  await reset();
  const clock = { t: Date.now() };
  const c = build(fakeAai(), clock);
  await db.doc("shares/live1").set({ ownerUid: UID, live: true, liveText: "hi", createdAt: new Date(clock.t).toISOString() });
  await c.createRecording(UID, { id: ID, folder: "Work", shareId: "live1" });
  assert.equal((await share("live1")).revoked, true);
  assert.equal((await docOf()).shareId, null);

  await db.doc("shares/ended").set({ ownerUid: UID, live: false, createdAt: new Date(clock.t).toISOString() });
  await db.doc("shares/running").set({ ownerUid: UID, live: true, createdAt: new Date(clock.t + 2 * 86400e3 - 3600e3).toISOString() });
  await db.doc("shares/old").set({ ownerUid: UID, live: true, createdAt: new Date(clock.t - 13 * 3600e3).toISOString() });
  await db.doc("shares/normal").set({ ownerUid: UID, utterances: [] });
  await bucket.file(`recordings/${UID}/_live/1730000000000/merged.m4a`).save("x", { resumable: false });
  await bucket.file(`recordings/${UID}/_live/${ID}/seg0000.m4a`).save("x", { resumable: false });
  clock.t += 2 * 86400e3;
  await c.sweepLive();
  clock.t -= 2 * 86400e3;
  assert.equal((await share("ended")).revoked, true);
  assert.equal((await share("old")).revoked, true);
  assert.equal((await share("normal")).revoked, undefined, "published links are not live links");
  assert.equal(await exists(`recordings/${UID}/_live/1730000000000/merged.m4a`), false, "diarization scratch goes");
  assert.equal(await exists(`recordings/${UID}/_live/${ID}/seg0000.m4a`), true, "a take's segments stay until merged or deleted");
  assert.equal((await share("running")).revoked, undefined, "a live take in progress stays open");
});

test("delete: link closed, every blob and live segment gone, voice samples kept, tombstone stripped, late job ignored", async () => {
  await reset();
  const aai = fakeAai(); const c = build(aai, { t: Date.now() });
  await db.doc("shares/sh3").set({ ownerUid: UID, utterances: [{ text: "x" }] });
  await c.createRecording(UID, { id: ID, folder: "Work", shareId: "sh3", speakers: ["Erica"], note: "secret", topic: "t" });
  const gen = await uploadAudio();
  await c.audioFinalized(UID, ID, gen);
  const st = await c.maybeStart(UID, ID);
  for (const n of ["voices-r1.json", "transcript-r0.txt"]) await bucket.file(`rec2/${UID}/${ID}/${n}`).save("x", { resumable: false });
  await bucket.file(`recordings/${UID}/_live/${ID}/seg0000.m4a`).save("x", { resumable: false });
  await bucket.file(`recordings/${UID}/_voiceprint/enroll.m4a`).save("x", { resumable: false });

  await c.deleteRecording(UID, ID, "del1");
  assert.equal((await share("sh3")).revoked, true);
  const [left] = await bucket.getFiles({ prefix: `rec2/${UID}/${ID}/` });
  assert.deepEqual(left.map((f) => f.name), []);
  assert.equal(await exists(`recordings/${UID}/_live/${ID}/seg0000.m4a`), false);
  assert.equal(await exists(`recordings/${UID}/_voiceprint/enroll.m4a`), true);
  const d = await docOf();
  assert.ok(d.deletedAt); assert.ok(d.purgedAt); assert.equal(d.purgePending, null);
  for (const k of ["note", "topic", "speakers", "folder", "shareId", "speakerLabels"]) assert.equal(d[k], undefined, k);
  assert.equal((await c.deleteRecording(UID, ID, "del1")).deletedAt, d.deletedAt, "replay-safe");
  await assert.rejects(c.createRecording(UID, { id: ID }), (e) => e.code === "failed-precondition");

  aai.state.transcript = completed(gen);
  assert.equal((await c.webhook({ uid: UID, id: ID, lockId: st.lockId, payload: { transcript_id: "t1", status: "completed" } })).note, "recording deleted; transcript not kept");
  const [after] = await bucket.getFiles({ prefix: `rec2/${UID}/${ID}/` });
  assert.equal(after.length, 0, "a late job writes nothing");
});

test("a purge the delete call did not finish is finished by the sweep", async () => {
  await reset();
  const c = build(fakeAai(), { t: Date.now() });
  await c.createRecording(UID, { id: ID, folder: "Work" });
  await uploadAudio();
  await c.docRef(UID, ID).update({ deletedAt: new Date().toISOString(), purgePending: true });
  await c.sweepAll();
  assert.equal(await exists(`rec2/${UID}/${ID}/audio.m4a`), false);
  assert.ok((await docOf()).purgedAt);
});

test("only the owner's uploads are transcribed", async () => {
  await reset();
  const aai = fakeAai();
  const c = build(aai, { t: Date.now() }, { isOwner: async (uid) => uid === "owner" });
  const gen = await uploadAudio();
  assert.deepEqual(await c.audioFinalized(UID, ID, gen), { stub: true });
  assert.equal((await c.maybeStart(UID, ID)).started, false);
  assert.equal(aai.state.posts.length, 0, "nothing paid for");
});

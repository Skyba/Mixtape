// The REST gate for read-only keys and the public Ask endpoint, served from
// index.js against the emulators (npm test). Nothing here reaches Anthropic:
// every Ask request below is refused before the model call.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const express = require("express");
const crypto = require("crypto");
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: "demo-mixtape", storageBucket: "demo-mixtape.appspot.com" });
process.env.GCLOUD_PROJECT = "demo-mixtape";
const m = require("../index.js");
const admin = require("firebase-admin");
const db = admin.firestore();

const UID = "owner1";
const PUB = "2026-10-25T10:00:00.000Z", PRIV = "2026-10-25T11:00:00.000Z", SELF = "2026-10-25T12:00:00.000Z";
const tok = (n) => "mxt_live_" + String(n).repeat(48).slice(0, 48);
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

// Cloud Functions hands the handler Express req/res with the body parsed.
async function serve(fn) {
  const app = express();
  app.use(express.json());
  app.use((req, res) => fn(req, res));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}
test.after(() => admin.app().delete());

test("read-only key: private and always-private recordings, share ids and odd ids are out of reach", async () => {
  await db.doc("config/migration").set({ phase: "canonical" });
  await db.doc("config/privacy").set({ alwaysPrivateFolders: ["self"] });
  const items = db.collection("recordings").doc(UID).collection("items");
  const base = { uid: UID, deletedAt: null, recordedAt: "2026-10-25T10:00:00.000Z", status: "none", folder: "Work" };
  await items.doc(PUB).set({ ...base, id: PUB, private: false, shareId: "abc", shareDirty: { shareId: "abc", rev: 1 } });
  await items.doc(PRIV).set({ ...base, id: PRIV, private: true });
  await items.doc(SELF).set({ ...base, id: SELF, private: false, folder: "self" });
  await db.doc(`apiKeys/${sha(tok(1))}`).set({ ownerUid: UID, hidePrivate: true, scopes: ["read:meta", "read:transcripts", "read:json"] });
  await db.doc(`apiKeys/${sha(tok(2))}`).set({ ownerUid: UID, scopes: ["read:meta"] });
  await db.doc(`apiKeys/${sha(tok(3))}`).set({ ownerUid: UID, scopes: ["read:meta"], expiresAt: "2026-01-01T00:00:00.000Z" });
  const s = await serve(m.api);
  const get = (p, n) => fetch(s.url + "/v1" + p, { headers: { authorization: "Bearer " + tok(n) } });
  try {
    const list = await (await get("/recordings", 1)).json();
    assert.deepEqual(list.recordings.map((r) => r.id), [PUB]);
    assert.equal((await get(`/meta?id=${PRIV}`, 1)).status, 404);
    assert.equal((await get(`/META/?id=${SELF}`, 1)).status, 404, "folder default counts, any case");
    assert.equal((await get(`/transcript?id=${SELF}`, 1)).status, 404);
    assert.equal((await get(`/meta?id=${PUB}/webhooks/t1:completed`, 1)).status, 404, "no subdocument addressing");
    const meta = await (await get(`/meta?id=${PUB}`, 1)).json();
    assert.equal(meta.id, PUB); assert.equal("shareId" in meta, false); assert.equal("shareDirty" in meta, false);
    assert.equal((await get("/logs", 1)).status, 403);
    // The owner's own key (the laptop's) still reaches private recordings.
    assert.equal((await (await get("/recordings", 2)).json()).recordings.length, 3);
    assert.equal((await get(`/meta?id=${PRIV}`, 2)).status, 200);
    assert.equal((await get("/recordings", 3)).status, 401, "expired key");
  } finally { s.close(); }
});

test("ask: closed, foreign and over-budget links are refused before any model call", async () => {
  await db.doc(`ownerProfiles/${UID}`).set({ name: "Owner" });
  await db.doc("shares/rev1").set({ ownerUid: UID, revoked: true });
  await db.doc("shares/ended1").set({ ownerUid: UID, live: false, utterances: [] });
  await db.doc("shares/foreign1").set({ ownerUid: "stranger", utterances: [] });
  const today = new Date().toISOString().slice(0, 10);
  await db.doc("shares/busy1").set({ ownerUid: UID, utterances: [], askDay: today, askCount: 50 });
  await db.doc("shares/open1").set({ ownerUid: UID, utterances: [] });
  await db.doc(`askQuota/${today}`).set({ count: 200 });
  const s = await serve(m.askSonnet);
  const ask = (id) => fetch(s.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, prompt: "hi" }) });
  try {
    for (const id of ["rev1", "ended1", "foreign1", "nope", "a/b"]) assert.equal((await ask(id)).status, 404, id);
    assert.equal((await ask("busy1")).status, 429, "per-share cap");
    assert.equal((await ask("open1")).status, 429, "global cap");
    assert.equal((await db.doc(`askQuota/${today}`).get()).data().count, 200, "a refused question is not counted");
  } finally { s.close(); await db.doc(`askQuota/${today}`).delete(); }
});

// Security rules under the emulator: storage.rules (R1), storage.rules.frozen
// (the freeze), firestore.rules. Run via npm test.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const rut = require("@firebase/rules-unit-testing");
const { initializeTestEnvironment } = rut;
const assertSucceeds = async (p, label) => { try { return await rut.assertSucceeds(p); } catch (e) { throw new Error(`${label || "?"}: ${e.message}`); } };
const assertFails = async (p, label) => { try { return await rut.assertFails(p); } catch (e) { throw new Error(`${label || "?"}: ${e.message}`); } };
const { ref, uploadBytes, getBytes, deleteObject } = require("firebase/storage");
const { doc, getDoc, setDoc } = require("firebase/firestore");

const PROJECT = "demo-mixtape";
const root = path.join(__dirname, "..", "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
const [fh, fp] = process.env.FIRESTORE_EMULATOR_HOST.split(":");
const [sh, sp] = process.env.FIREBASE_STORAGE_EMULATOR_HOST.split(":");
const ID = "2026-10-25T10:00:00.000Z";
const bytes = new Uint8Array([1, 2, 3]);

async function envWith(storageRules) {
  const env = await initializeTestEnvironment({
    projectId: PROJECT,
    firestore: { rules: read("firestore.rules"), host: fh, port: Number(fp) },
    storage: { rules: read(storageRules), host: sh, port: Number(sp), storageBucket: `${PROJECT}.appspot.com` },
  });
  await env.clearStorage();
  return env;
}
const setPhase = (env, phase) =>
  env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "config/migration"), { phase }));
const up = (ctx, p) => uploadBytes(ref(ctx.storage(), p), bytes);

test("R1 storage rules: legacy writable, canonical audio create-only and phase-gated, artifacts server-only", async () => {
  const env = await envWith("storage.rules");
  const me = env.authenticatedContext("u1");
  const other = env.authenticatedContext("u2");
  await setPhase(env, "legacy");
  await assertSucceeds(up(me, "recordings/u1/Work/x.json"));
  await assertFails(up(other, "recordings/u1/Work/y.json"));
  await setPhase(env, "canonical");
  await assertSucceeds(up(me, `rec2/u1/${ID}/audio.m4a`), "up(me, `rec2/u1/${ID}/audio.m4a`)");
  await assertFails(up(me, `rec2/u1/${ID}/audio.m4a`), "create-only: no overwrite");
  await assertFails(deleteObject(ref(me.storage(), `rec2/u1/${ID}/audio.m4a`)), "deleteObject(ref(me.storage(), `rec2/u1/${ID}/audio.m4a`))");
  await assertFails(up(me, "rec2/u1/not-an-id/audio.m4a"));
  await assertSucceeds(up(me, "rec2/u1/2026-07-27T14:31:53.488Z-5h/audio.m4a"), "suffixed id accepted");
  await assertFails(up(me, "rec2/u1/2026-07-27T14:31:53.488Z-toolongsuffix/audio.m4a"), "long suffix rejected");
  await assertFails(up(other, `rec2/u1/2026-10-25T10:00:01.000Z/audio.m4a`), "up(other, `rec2/u1/2026-10-25T10:00:01.000Z/audio.m4a`)");
  await assertFails(up(me, `rec2/u1/${ID}/transcript-r1.txt`), "up(me, `rec2/u1/${ID}/transcript-r1.txt`)");
  await assertFails(up(me, `rec2/u1/${ID}/meta.json`), "up(me, `rec2/u1/${ID}/meta.json`)");
  await assertFails(up(me, "rec2-archive/u1/legacy/Work/x.m4a"));
  await assertFails(up(me, "rec2-quarantine/u1/orphans/x.m4a"));
  await assertSucceeds(getBytes(ref(me.storage(), `rec2/u1/${ID}/audio.m4a`)), "getBytes(ref(me.storage(), `rec2/u1/${ID}/audio.m4a`))");
  await assertFails(getBytes(ref(other.storage(), `rec2/u1/${ID}/audio.m4a`)), "getBytes(ref(other.storage(), `rec2/u1/${ID}/audio.m4a`))");
  await env.cleanup();
});

test("frozen storage rules: legacy read-only except logs and live chunks", async () => {
  const env = await envWith("storage.rules.frozen");
  const me = env.authenticatedContext("u1");
  await setPhase(env, "frozen");
  await env.withSecurityRulesDisabled((ctx) => up(ctx, "recordings/u1/Work/x.json"));
  await assertFails(up(me, "recordings/u1/Work/x.json"));
  await assertFails(up(me, "recordings/u1/Work/new.m4a"));
  await assertFails(deleteObject(ref(me.storage(), "recordings/u1/Work/x.json")));
  await assertSucceeds(getBytes(ref(me.storage(), "recordings/u1/Work/x.json")));
  await assertSucceeds(up(me, "recordings/u1/_logs/log.txt"));
  await assertSucceeds(up(me, "recordings/u1/_live/abc/seg0001.m4a"));
  await assertSucceeds(up(me, "recordings/u1/_voiceprint/enroll.m4a"), "voiceprint stays writable");
  await env.cleanup();
});

test("firestore rules: items owner-readable, never client-writable; phase readable", async () => {
  const env = await envWith("storage.rules");
  const me = env.authenticatedContext("u1");
  const other = env.authenticatedContext("u2");
  await setPhase(env, "canonical");
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), `recordings/u1/items/${ID}`), { id: ID, folder: "Work" }));
  await assertSucceeds(getDoc(doc(me.firestore(), `recordings/u1/items/${ID}`)), "getDoc(doc(me.firestore(), `recordings/u1/items/${ID}`))");
  await assertFails(getDoc(doc(other.firestore(), `recordings/u1/items/${ID}`)), "getDoc(doc(other.firestore(), `recordings/u1/items/${ID}`))");
  await assertFails(setDoc(doc(me.firestore(), `recordings/u1/items/${ID}`), { folder: "Hack" }), "setDoc(doc(me.firestore(), `recordings/u1/items/${ID}`), { folder: \"Hack\" })");
  await assertFails(setDoc(doc(me.firestore(), `recordings/u1/items/${ID}/webhooks/x`), { a: 1 }), "setDoc(doc(me.firestore(), `recordings/u1/items/${ID}/webhooks/x`), { a: 1 })");
  await assertFails(getDoc(doc(me.firestore(), `recordings/u1/items/${ID}/webhooks/x`)), "getDoc(doc(me.firestore(), `recordings/u1/items/${ID}/webhooks/x`))");
  await assertSucceeds(getDoc(doc(me.firestore(), "config/migration")));
  await assertFails(setDoc(doc(me.firestore(), "config/migration"), { phase: "legacy" }));
  await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), "config/migration")));
  await env.cleanup();
});

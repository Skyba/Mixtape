// The review's claim and commit against the Firestore emulator (npm test).
// The decision itself is stubbed: test/review.test.js covers it.
const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");
const { makeCanonical, priorLabelsAfter } = require("../canonical");
const { makeReview } = require("../review");

if (!admin.apps.length) admin.initializeApp({ projectId: "demo-mixtape", storageBucket: "demo-mixtape.appspot.com" });
const db = admin.firestore();
const bucket = admin.storage().bucket();
const UID = "u-review";
const ID = "2026-10-28T10:00:00.000Z";
const T0 = "2026-10-28T10:00:00.000Z";

const canon = makeCanonical({ db, bucket, env: {} });
const ref = canon.docRef(UID, ID);
async function seed(fields = {}) {
  await db.collection("config").doc("migration").set({ phase: "canonical" });
  await ref.set({
    id: ID, uid: UID, status: "done", deletedAt: null, folder: "erica", speakers: ["Basile", "Erica"], owner: { name: "Basile" },
    current: { rev: 2, aai: { name: "utterances-r2.aai.json" } }, speakerKeys: ["A", "B"],
    speakerLabels: {}, speakerId: null, meIncluded: null, fieldsUpdatedAt: {}, reviewDue: { rev: 2, at: T0 }, ...fields,
  });
}
const decided = (extra = {}) => async () => ({
  labels: { A: { name: "Basile", by: "auto", evidence: "voice 80%" }, B: { name: "Erica", by: "auto", evidence: "voice 70%" } },
  flag: null, folder: null, ownerName: "Basile", ...extra,
});

test("commit: settles the voices, sets the owner, clears the marker", async () => {
  await seed();
  const r = makeReview({ db, bucket, env: {}, canon, runner: decided() });
  await r.reviewOne(UID, ID);
  const d = (await ref.get()).data();
  assert.equal(d.speakerLabels.A.by, "auto");
  assert.equal(d.speakerLabels.B.name, "Erica");
  assert.equal(d.speakerId, "A");
  assert.equal(d.meIncluded, "yes");
  assert.equal(d.reviewDue, null);
  assert.equal(d.reviewClaim, null);
  assert.equal(d.review.rev, 2);
  assert.ok(d.fieldsUpdatedAt["speakerLabels.A"]);
});

test("a name the owner set is never overwritten", async () => {
  await seed({ speakerLabels: { A: { name: "Erica", by: "user", at: T0 } } });
  await makeReview({ db, bucket, env: {}, canon, runner: decided() }).reviewOne(UID, ID);
  const d = (await ref.get()).data();
  assert.deepEqual(d.speakerLabels.A, { name: "Erica", by: "user", at: T0 });
});

test("the owner edits while the review runs: nothing written, the review is due again", async () => {
  await seed();
  const runner = async (...a) => {
    // Stamps are keyed by the literal "speakerLabels.B", as the patch path writes them.
    await ref.update("speakerLabels.B", { name: "Keri", by: "user", at: "2026-10-28T10:05:00.000Z" },
      new admin.firestore.FieldPath("fieldsUpdatedAt", "speakerLabels.B"), "2026-10-28T10:05:00.000Z");
    return decided({ flag: "B: something" })(...a);
  };
  await makeReview({ db, bucket, env: {}, canon, runner }).reviewOne(UID, ID);
  const d = (await ref.get()).data();
  assert.equal(d.speakerLabels.A, undefined);
  assert.equal(d.speakerLabels.B.name, "Keri");
  assert.equal(d.reviewFlag, undefined);
  assert.equal(d.reviewDue.again, true);
  assert.equal(d.reviewClaim, null);
});

test("a new transcript published meanwhile: nothing written for the old one", async () => {
  await seed();
  const runner = async (...a) => { await ref.update({ current: { rev: 3, aai: { name: "x" } } }); return decided()(...a); };
  await makeReview({ db, bucket, env: {}, canon, runner }).reviewOne(UID, ID);
  assert.deepEqual((await ref.get()).data().speakerLabels, {});
});

test("a deleted recording loses its marker instead of blocking the sweep", async () => {
  await seed({ deletedAt: T0 });
  const out = await makeReview({ db, bucket, env: {}, canon, runner: decided() }).reviewOne(UID, ID);
  assert.equal(out.skipped, true);
  assert.equal((await ref.get()).data().reviewDue, null);
});

test("a failed review releases its claim and counts the failure", async () => {
  await seed();
  const r = makeReview({ db, bucket, env: {}, canon, runner: async () => { throw new Error("Claude down"); } });
  await assert.rejects(r.reviewOne(UID, ID), /Claude down/);
  const d = (await ref.get()).data();
  assert.equal(d.reviewClaim, null);
  assert.equal(d.reviewFailures, 1);
  assert.ok(d.reviewDue);
});

test("a flag is raised, and cleared when the next review finds nothing", async () => {
  await seed();
  await makeReview({ db, bucket, env: {}, canon, runner: decided({ flag: "A: voice Erica" }) }).reviewOne(UID, ID);
  assert.equal((await ref.get()).data().reviewFlag.reason, "A: voice Erica");
  await ref.update({ reviewDue: { rev: 2, at: "2026-10-28T11:00:00.000Z" } });
  await makeReview({ db, bucket, env: {}, canon, runner: decided() }).reviewOne(UID, ID);
  assert.equal((await ref.get()).data().reviewFlag, null);
});

test("re-run history: names the last run did not settle are kept from the one before", () => {
  const cur = {
    current: { rev: 2 },
    speakerLabels: { A: { name: "Alice", by: "auto" }, B: { name: "Speaker B", by: "aai" } },
    priorLabels: [{ rev: 1, labels: { A: { name: "Alice", by: "user" }, B: { name: "Bob", by: "user" } } }],
  };
  assert.deepEqual(priorLabelsAfter(cur).map((p) => p.rev), [2, 1]);
  assert.deepEqual(priorLabelsAfter({ current: { rev: 3 }, speakerLabels: {}, priorLabels: priorLabelsAfter(cur) }).map((p) => p.rev), [2, 1]);
});

test("re-run history keeps an old transcript while it is the only one with a name", () => {
  let cur = { current: { rev: 1 }, speakerLabels: { A: { name: "Alice", by: "user" }, B: { name: "Bob", by: "user" } }, priorLabels: null };
  for (let rev = 2; rev <= 5; rev++) {
    cur = { current: { rev }, speakerLabels: { A: { name: "Alice", by: "auto" } }, priorLabels: priorLabelsAfter(cur) };
  }
  const names = new Set(priorLabelsAfter(cur).flatMap((p) => Object.values(p.labels).map((l) => l.name)));
  assert.deepEqual([...names].sort(), ["Alice", "Bob"]);
});

// One-off: purges recordings deleted before delete purged anything. Closes
// each one's public link, deletes its blobs under rec2/<uid>/<id>/ and its
// live segments, and strips the tombstone to the fields that block a
// re-create (functions/canonical.js purge). Deletes cannot be undone.
//
//   node tools/purge-tombstones.js --uid <uid>          # dry run
//   node tools/purge-tombstones.js --uid <uid> --yes    # delete
//
// Uses Google application-default credentials with admin rights.
const admin = require("../functions/node_modules/firebase-admin");
const { makeCanonical } = require("../functions/canonical");

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const uid = arg("uid"), write = process.argv.includes("--yes");
if (!uid) { console.error("usage: purge-tombstones.js --uid <uid> [--yes]"); process.exit(1); }
admin.initializeApp({ projectId: "recorder-bv001", storageBucket: "recorder-bv001.firebasestorage.app" });
const db = admin.firestore();
const bucket = admin.storage().bucket();
const canon = makeCanonical({ db, bucket, env: {} });

(async () => {
  const snap = await db.collection("recordings").doc(uid).collection("items").where("deletedAt", "!=", null).get();
  const todo = snap.docs.filter((s) => !s.data().purgedAt);
  for (const s of todo) {
    const [files] = await bucket.getFiles({ prefix: `rec2/${uid}/${s.id}/` });
    const [live] = await bucket.getFiles({ prefix: `recordings/${uid}/_live/${s.id}/` });
    console.log(`${s.id}  deleted ${s.data().deletedAt}  ${files.length + live.length} objects${s.data().shareId ? "  has link" : ""}`);
    if (write) await canon.purge(uid, s.id);
  }
  console.log(`${todo.length} tombstones${write ? " purged" : " (dry run; --yes to delete)"}`);
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });

// One-off: makes every existing recording in an always-private folder
// private, and closes its public link. Until the app fix (2da0cd5) a
// recording made in such a folder was shown as private on the phone but
// stored as private:false, so read-only keys could reach it.
//
// Also writes the folder list to config/privacy, where the server reads it
// from then on (functions/canonical.js forces private on create, patch and
// move, and the REST gate treats those folders as private). The list comes
// from src/placement.local.ts (alwaysPrivate: true, the mirror of
// routes.json defaults.private), or --folders a,b to override.
//
//   node tools/backfill-always-private.js --uid <uid>          # dry run
//   node tools/backfill-always-private.js --uid <uid> --yes    # write
//
// Uses Google application-default credentials with admin rights.
const fs = require("fs");
const path = require("path");
const admin = require("../functions/node_modules/firebase-admin");
const { makeCanonical } = require("../functions/canonical");

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const uid = arg("uid"), write = process.argv.includes("--yes");
if (!uid) { console.error("usage: backfill-always-private.js --uid <uid> [--folders a,b] [--yes]"); process.exit(1); }

function foldersFromPlacement() {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "placement.local.ts"), "utf8");
  return [...src.matchAll(/\{\s*name:\s*"([^"]+)"[^}]*alwaysPrivate:\s*true[^}]*\}/g)].map((m) => m[1]);
}
const folders = (arg("folders") ? arg("folders").split(",") : foldersFromPlacement()).map((f) => f.trim().toLowerCase()).filter(Boolean);
if (!folders.length) { console.error("no always-private folders found"); process.exit(1); }

admin.initializeApp({ projectId: "recorder-bv001", storageBucket: "recorder-bv001.firebasestorage.app" });
const db = admin.firestore();
const canon = makeCanonical({ db, bucket: admin.storage().bucket(), env: {} });

(async () => {
  console.log(`always-private folders: ${folders.join(", ")}${write ? "" : "  (dry run; --yes to write)"}`);
  if (write) await db.collection("config").doc("privacy").set({ alwaysPrivateFolders: folders, updatedAt: new Date().toISOString(), by: "backfill-always-private" }, { merge: true });
  const snap = await db.collection("recordings").doc(uid).collection("items").where("deletedAt", "==", null).get();
  const todo = snap.docs.filter((s) => folders.includes(String(s.data().folder || "").toLowerCase()) && (s.data().private !== true || s.data().shareId));
  let flipped = 0, links = 0;
  for (const s of todo) {
    const d = s.data();
    console.log(`${d.private === true ? "link only" : "private  "} ${s.id}  [${d.folder}]${d.shareId ? "  has link" : ""}`);
    if (!write) continue;
    // Same stamp rule as the server's forcePrivate: after any client stamp,
    // so the phone's merge takes it.
    const doc = await db.runTransaction(async (tx) => {
      const cur = (await tx.get(s.ref)).data();
      if (!cur || cur.deletedAt || cur.private === true) return { doc: cur, changed: false };
      const fu = cur.fieldsUpdatedAt || {};
      const now = new Date();
      const at = new Date(Math.max(now.getTime(), Date.parse(fu.private || 0) + 1)).toISOString();
      const next = { ...cur, private: true, fieldsUpdatedAt: { ...fu, private: at }, updatedAt: now.toISOString() };
      tx.set(s.ref, next);
      return { doc: next, changed: true };
    });
    if (doc.changed) flipped++;
    if (doc.doc && (await canon.enforceShare(uid, s.id, doc.doc))) links++;
  }
  console.log(`${todo.length} to fix; ${write ? `${flipped} made private, ${links} links closed` : "nothing written"}`);
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });

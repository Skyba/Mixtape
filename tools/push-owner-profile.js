// Puts the owner's profile in the cloud, where transcription (AssemblyAI's
// speaker identification) and the review (functions/review.js) read it, and
// the phone shows it. The source is a Markdown file kept with the owner's
// notes (mixtape-private/docs/owner-profile.md); edit there, then run:
//
//   node tools/push-owner-profile.js <profile.md> --uid <uid> --name Basile --bio "one line for AssemblyAI"
//
// Uses Google application-default credentials with admin rights.
const fs = require("fs");
const admin = require("../functions/node_modules/firebase-admin");

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const file = process.argv[2], uid = arg("uid"), name = arg("name"), bio = arg("bio") || "";
if (!file || !uid || !name) { console.error("usage: push-owner-profile.js <profile.md> --uid <uid> --name <name> [--bio <line>]"); process.exit(1); }
admin.initializeApp({ projectId: "recorder-bv001" });
admin.firestore().collection("ownerProfiles").doc(uid)
  .set({ name, bio, profile: fs.readFileSync(file, "utf8"), updatedAt: new Date().toISOString() })
  .then(() => console.log(`profile for ${name} pushed`));

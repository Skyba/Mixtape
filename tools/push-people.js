// Puts the id and display name of the owner's first-degree people in the
// cloud, for the name picker: nothing else from the CRM leaves the Mac.
//
//   node tools/push-people.js <crm>/db/people.jsonl --uid <uid>
//
// Uses Google application-default credentials with admin rights.
const fs = require("fs");
const admin = require("../functions/node_modules/firebase-admin");

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const file = process.argv[2], uid = arg("uid");
if (!file || !uid) { console.error("usage: push-people.js <people.jsonl> --uid <uid>"); process.exit(1); }
const people = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  .filter((p) => p.degree === 1 && !/^Unknown \(/.test(p.name))
  .map((p) => ({ id: p.id, name: p.name }));
admin.initializeApp({ projectId: "recorder-bv001" });
admin.firestore().collection("ownerPeople").doc(uid).set({ people, updatedAt: new Date().toISOString() })
  .then(() => console.log(`${people.length} people pushed`));

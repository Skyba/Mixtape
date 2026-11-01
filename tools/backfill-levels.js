// Writes the loudness overview (voice.levels) on recordings that lack it or
// whose audio changed since. New recordings get it from the review step.
//
//   node tools/backfill-levels.js --uid <uid>
//
// Uses Google application-default credentials with admin rights.
const admin = require("../functions/node_modules/firebase-admin");
const voice = require("../functions/voice");

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const uid = arg("uid");
if (!uid) { console.error("usage: backfill-levels.js --uid <uid>"); process.exit(1); }
admin.initializeApp({ projectId: "recorder-bv001", storageBucket: "recorder-bv001.firebasestorage.app" });

(async () => {
  const bucket = admin.storage().bucket();
  const snap = await admin.firestore().collection("recordings").doc(uid).collection("items").where("deletedAt", "==", null).get();
  // Newest first, four at a time: the recent ones are the ones being opened.
  const todo = snap.docs.filter((s) => { const d = s.data(); return d.audio && d.audio.generation && !(d.levels && d.levels.gen === d.audio.generation); })
    .sort((a, b) => String(b.data().recordedAt).localeCompare(String(a.data().recordedAt)));
  const one = async (s) => {
    const d = s.data(), gen = d.audio.generation;
    let wav;
    try {
      wav = await voice.decode(bucket.file(`rec2/${uid}/${s.id}/audio.m4a`));
      await s.ref.update({ levels: { gen, v: voice.levels(wav) } });
      console.log("ok", s.id, d.topic || "");
    } catch (e) {
      console.log("fail", s.id, String(e.message || e).slice(0, 120));
    } finally {
      if (wav) wav.close();
    }
  };
  const queue = [...todo];
  await Promise.all(Array.from({ length: 4 }, async () => { while (queue.length) await one(queue.shift()); }));
})();

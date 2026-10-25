// The whole functions module must load: a reference-before-declaration or a
// bad trigger option fails deployment, not a unit test.
const test = require("node:test");
const assert = require("node:assert/strict");
test("functions module loads and exports every function", () => {
  process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: "demo-mixtape", storageBucket: "demo-mixtape.appspot.com" });
  process.env.GCLOUD_PROJECT = "demo-mixtape";
  const m = require("../index.js");
  for (const k of ["api", "createApiKey", "patchMeta", "createRecording", "retranscribe", "deleteRecording", "audioDescriptor", "mergeAudio", "startTranscription", "transcriptionWebhook", "transcriptionSweep"]) {
    assert.ok(m[k], k);
  }
});

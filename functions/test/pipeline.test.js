// Cloud pipeline fixes: Claude failures, speaker identification, patch
// conflicts, rendering, and the audio merge.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const lib = require("../lib");

const fake = (status, body) => async () => ({ ok: status < 400, status, json: async () => body });

test("a Claude error or an answer with no text throws instead of reading as empty", async () => {
  await assert.rejects(lib.anthropic("k", 10, "p", "m", fake(529, { type: "error", error: { type: "overloaded_error" } })), /Anthropic 529/);
  await assert.rejects(lib.anthropic("k", 10, "p", "m", fake(200, { content: [{ type: "thinking", thinking: "" }], stop_reason: "max_tokens" })), /no text.*max_tokens/);
  assert.equal(await lib.anthropic("k", 10, "p", "m", fake(200, { content: [{ type: "thinking" }, { type: "text", text: "{}" }] })), "{}");
});

test("speaker identification never sends the owner's bio, which names other people", () => {
  const su = lib.speakerIdentification({ speakers: ["Basile", "Danny", "Speaker 3"], owner: { name: "Basile", bio: "Lives with his partner Erica" } });
  const sent = JSON.stringify(su);
  assert.doesNotMatch(sent, /Erica/);
  assert.deepEqual(su.request.speaker_identification.speakers.map((s) => s.name), ["Basile", "Danny"]);
});

test("an utterance key AssemblyAI named after someone not listed becomes a free letter", () => {
  const u = [{ speaker: "Basile", text: "a" }, { speaker: "Erica", text: "b" }, { speaker: "A", text: "c" }];
  const out = lib.anonymiseUnlisted(u, ["Basile", "Logina"]);
  assert.deepEqual(out.map((x) => x.speaker), ["Basile", "B", "A"]);
});

test("postProcess reports the detected language without writing it as the owner's choice", async () => {
  const post = await lib.postProcess({ utterances: [], language_code: "fr", audio_duration: 60 }, { speakers: [], language: "" }, {}, fake(200, {}));
  assert.equal(post.language, null);
  assert.equal(post.detectedLanguage, "French");
});

test("a name key renders as the name, like the app", () => {
  assert.equal(lib.renderTranscript([{ start: 0, speaker: "Basile", text: "hi" }], [], null), "[00:00] Basile: hi");
});

test("naming a voice takes the name off a model's suggestion on another voice instead of refusing", () => {
  const meta = {
    speakers: ["Basile", "Danny", "Logina"], transcriptRevision: 1, fieldsUpdatedAt: {},
    speakerLabels: { A: { name: "Logina", by: "voiceprint", at: "2026-11-01T00:00:00.000Z" }, B: { name: "Basile", by: "aai" }, C: { name: "Danny", by: "claude" } },
  };
  const t = "2026-11-06T10:00:00.000Z";
  const { meta: out, applied } = lib.applyPatch(meta, {
    speakerLabels: { C: { name: "Logina", by: "user", at: t } }, fieldsUpdatedAt: { "speakerLabels.C": t }, expectedRevision: 1,
  }, "Basile", { now: Date.parse(t) });
  assert.equal(out.speakerLabels.C.name, "Logina");
  assert.equal(out.speakerLabels.A, undefined);
  assert.ok(applied.includes("speakerLabels.A"));
  assert.ok(out.fieldsUpdatedAt["speakerLabels.A"]);
  // Two of your own names on two voices is still a merge, not a conflict.
  const both = lib.applyPatch(out, {
    speakerLabels: { B: { name: "Logina", by: "user", at: t } }, fieldsUpdatedAt: { "speakerLabels.B": "2026-11-06T10:01:00.000Z" }, expectedRevision: 1,
  }, "Basile", { now: Date.parse(t) });
  assert.equal(both.meta.speakerLabels.C.name, "Logina");
});

test("the names that leave the app skip single-signal guesses", () => {
  const map = lib.publicSpeakerMap({ speakerLabels: { A: { name: "Erica", by: "voiceprint" }, B: { name: "Basile", by: "user" }, C: { name: "Danny", by: "ai-review" }, D: { name: "Tyler", by: "claude" } } });
  assert.deepEqual(map, { A: "Speaker A", B: "Basile", C: "Danny", D: "Speaker D" });
});

test("merge: a bad segment fails the merge instead of giving a short file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "concat-"));
  try {
    const segs = [0, 1, 2].map((i) => {
      const f = path.join(dir, `s${i}.m4a`);
      execFileSync(ffmpegPath, ["-loglevel", "error", "-f", "lavfi", "-i", `sine=frequency=${300 + i * 100}:duration=5`, "-c:a", "aac", "-b:a", "64k", f]);
      return f;
    });
    const ok = await lib.concatAudio(ffmpegPath, segs, path.join(dir, "ok.m4a"));
    assert.ok(ok.size >= 0.97 * ok.total);
    const bad = path.join(dir, "bad.m4a");
    fs.writeFileSync(bad, fs.readFileSync(segs[1]).subarray(0, 20000));
    await assert.rejects(lib.concatAudio(ffmpegPath, [segs[0], bad, segs[2]], path.join(dir, "short.m4a")));
    const empty = path.join(dir, "empty.m4a");
    fs.writeFileSync(empty, "");
    await assert.rejects(lib.concatAudio(ffmpegPath, [segs[0], empty, segs[2]], path.join(dir, "e.m4a")), /empty/);
    const junk = path.join(dir, "junk.m4a");
    fs.writeFileSync(junk, Buffer.alloc(30000, 7));
    await assert.rejects(lib.concatAudio(ffmpegPath, [segs[0], junk, segs[2]], path.join(dir, "j.m4a")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("withheld voices are pushed as Speaker X, never left for a reader to name by position", () => {
  const map = lib.publicSpeakerMap({ speakerLabels: { A: { name: "Erica", by: "voiceprint" }, B: { name: "Basile", by: "user" }, Danny: { name: "Danny", by: "claude" }, C: { name: "", by: "user" } } });
  assert.deepEqual(map, { A: "Speaker A", B: "Basile", Danny: "Unnamed voice", C: "Speaker C" });
});

test("the language shown is the owner's pick, else what detection found", () => {
  assert.equal(lib.shownLanguage({ language: "Auto", detectedLanguage: "French" }), "French");
  assert.equal(lib.shownLanguage({ language: "", detectedLanguage: "French" }), "French");
  assert.equal(lib.shownLanguage({ language: "English", detectedLanguage: "French" }), "English");
  assert.equal(lib.shownLanguage({ language: "Auto" }), "Auto");
});

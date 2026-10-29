const { test } = require("node:test");
const assert = require("node:assert");
const { decide } = require("../review");

const V = (name, score = 0.7, from = "sample") => ({ name, score, margin: 0.4, from });
const run = (o) => decide({ ownerName: "Basile", fresh: {}, voiceBy: {}, seconds: {}, ...o });
const doc = (o = {}) => ({ speakers: [], speakerLabels: {}, ...o });

test("preset 1-1: both voices match the listed names -> auto, no flag", () => {
  const r = run({
    doc: doc({ speakers: ["Basile", "Erica"], speakerLabels: { A: { name: "Basile", by: "aai" }, B: { name: "Erica", by: "aai" } } }),
    keys: ["A", "B"], seconds: { A: 600, B: 500 }, voiceBy: { A: V("Basile"), B: V("Erica") },
  });
  assert.deepStrictEqual([r.labels.A.by, r.labels.B.by], ["auto", "auto"]);
  assert.strictEqual(r.flag, null);
});

test("a third short voice is suggested as a merge into the voice it sounds like", () => {
  const r = run({
    doc: doc({ speakers: ["Basile", "Erica"] }),
    keys: ["A", "B", "C"], seconds: { A: 600, B: 500, C: 12 }, voiceBy: { A: V("Basile"), B: V("Erica") },
    similar: (a, b) => (a === "C" && b === "B" ? 0.62 : 0.1),
  });
  assert.deepStrictEqual(r.labels.C, { name: "Erica", by: "ai-review", merge: true, evidence: "short voice, sounds like Erica (62%)" });
  assert.strictEqual(r.flag, null);
});

test("a short voice that sounds like nobody stays unnamed", () => {
  const r = run({ doc: doc({ speakers: ["Basile"] }), keys: ["A", "B"], seconds: { A: 600, B: 8 }, voiceBy: { A: V("Basile") }, similar: () => 0.2 });
  assert.strictEqual(r.labels.B, undefined);
});

test("slot name contradicted by the voice -> red, nothing named", () => {
  const r = run({
    doc: doc({ speakers: ["Basile", "Erica"], speakerLabels: { A: { name: "Erica", by: "aai" } } }),
    keys: ["A", "B"], seconds: { A: 600, B: 600 }, voiceBy: { A: V("Basile") },
  });
  assert.strictEqual(r.labels.A, undefined);
  assert.match(r.flag, /A: AssemblyAI Erica vs voice Basile/);
});

test("a confirmed name is never changed, but a clear voice contradiction raises red", () => {
  const r = run({
    doc: doc({ speakers: ["Basile", "Erica"], speakerLabels: { A: { name: "Erica", by: "user" } } }),
    keys: ["A"], seconds: { A: 600 }, voiceBy: { A: V("Basile") },
  });
  assert.deepStrictEqual(r.labels, {});
  assert.match(r.flag, /Erica: the voice sounds like Basile/);
});

test("no slots: owner by voice alone stays a suggestion; with the blind content check it is two signals", () => {
  const base = { doc: doc(), keys: ["A", "B"], seconds: { A: 600, B: 600 }, voiceBy: { A: V("Basile") } };
  assert.strictEqual(run(base).labels.A.by, "voiceprint");
  const r = run({ ...base, ownerCheck: { key: "A", quote: "my partner Erica and I" } });
  assert.strictEqual(r.labels.A.by, "ai-review");
  const against = run({ ...base, ownerCheck: { key: "B", quote: "as Basile I think" } });
  assert.strictEqual(against.labels.A, undefined);
  assert.match(against.flag, /conversation says B is/);
});

test("solo on the owner's phone -> ai-review, not auto without a listed name", () => {
  const r = run({ doc: doc(), keys: ["A"], seconds: { A: 120 }, voiceBy: { A: V("Basile") } });
  assert.strictEqual(r.labels.A.by, "ai-review");
  const listed = run({ doc: doc({ speakers: ["Basile"] }), keys: ["A"], seconds: { A: 120 }, voiceBy: { A: V("Basile") } });
  assert.strictEqual(listed.labels.A.by, "auto");
});

test("re-run: names confirmed before carry over by voice", () => {
  const r = run({
    doc: doc(), keys: ["A", "B", "C"], seconds: { A: 600, B: 600, C: 600 }, carried: ["Basile", "Erica"],
    voiceBy: { B: V("Basile", 0.9, "earlier"), C: V("Erica", 0.8, "earlier") },
  });
  assert.strictEqual(r.labels.B.by, "auto");
  assert.match(r.labels.B.evidence, /before the re-run/);
  assert.strictEqual(r.labels.C.name, "Erica");
  assert.strictEqual(r.labels.A, undefined);
});

test("the one left is never someone with a voice sample: their voice has to match", () => {
  const r = run({ doc: doc({ speakers: ["Basile", "Erica"] }), keys: ["A", "B"], seconds: { A: 600, B: 300 }, voiceBy: { A: V("Basile") }, sampled: ["Basile", "Erica"] });
  assert.strictEqual(r.labels.B, undefined);
});

test("sample and earlier transcript disagreeing on a voice -> red, nothing settled", () => {
  const r = run({ doc: doc({ speakers: ["Basile", "Keri"] }), keys: ["A", "B"], seconds: { A: 600, B: 300 }, voiceBy: { A: V("Basile") }, voiceClash: { B: ["Erica", "Keri"] } });
  assert.strictEqual(r.labels.B, undefined);
  assert.match(r.flag, /B: the voice sounds like both Erica and Keri/);
});

test("the one voice left of the listed names: settled when the content also names them, else a suggestion", () => {
  const alone = run({ doc: doc({ speakers: ["Basile", "Keri"] }), keys: ["A", "B"], seconds: { A: 600, B: 300 }, voiceBy: { A: V("Basile") } });
  assert.deepStrictEqual([alone.labels.B.name, alone.labels.B.by], ["Keri", "ai-review"]);
  const said = run({ doc: doc({ speakers: ["Basile", "Keri"], speakerLabels: { B: { name: "Keri", by: "aai" } } }), keys: ["A", "B"], seconds: { A: 600, B: 300 }, voiceBy: { A: V("Basile") } });
  assert.deepStrictEqual([said.labels.B.name, said.labels.B.by], ["Keri", "auto"]);
});

test("a settled name is checked against the blind owner check and a voice clash", () => {
  const owner = run({ doc: doc({ speakers: ["Basile", "Erica"], speakerLabels: { A: { name: "Basile", by: "user" } } }), keys: ["A", "B"], seconds: { A: 600, B: 600 }, ownerCheck: { key: "B", quote: "I am Basile by the way" } });
  assert.match(owner.flag, /Basile: the conversation says B is/);
  const clash = run({ doc: doc({ speakerLabels: { A: { name: "Alice", by: "user" } } }), keys: ["A"], seconds: { A: 600 }, voiceClash: { A: ["Alice", "Bob"] } });
  assert.match(clash.flag, /Alice: the voice sounds like both Alice and Bob/);
});

test("one left does not fire when a signal points elsewhere, nothing is placed, or the voice is short", () => {
  const against = run({ doc: doc({ speakers: ["Basile", "Keri"], speakerLabels: { B: { name: "Basile", by: "aai" } } }), keys: ["A", "B"], seconds: { A: 600, B: 300 }, voiceBy: { A: V("Basile") } });
  assert.notStrictEqual((against.labels.B || {}).by, "auto");
  const none = run({ doc: doc({ speakers: ["Keri"] }), keys: ["A"], seconds: { A: 300 } });
  assert.strictEqual(none.labels.A, undefined);
  const short = run({ doc: doc({ speakers: ["Basile", "Keri"] }), keys: ["A", "B"], seconds: { A: 600, B: 20 }, voiceBy: { A: V("Basile") } });
  assert.strictEqual(short.labels.B, undefined);
});

test("AssemblyAI name keys: the voice agreeing with the key's name settles it", () => {
  const r = run({ doc: doc({ speakers: ["Basile", "Erica"] }), keys: ["Basile", "Erica"], seconds: { Basile: 600, Erica: 600 }, voiceBy: { Basile: V("Basile"), Erica: V("Erica") } });
  assert.deepStrictEqual([r.labels.Basile.by, r.labels.Erica.by], ["auto", "auto"]);
  const swapped = run({ doc: doc({ speakers: ["Basile", "Erica"] }), keys: ["Basile", "Erica"], seconds: { Basile: 600, Erica: 600 }, voiceBy: { Basile: V("Erica"), Erica: V("Basile") } });
  assert.deepStrictEqual(swapped.labels, {});
  assert.match(swapped.flag, /Basile: AssemblyAI Basile vs voice Erica/);
});

test("a name already on another untouched voice is not given twice", () => {
  const r = run({ doc: doc({ speakerLabels: { B: { name: "Basile", by: "claude" } } }), keys: ["A", "B"], seconds: { A: 600, B: 600 }, voiceBy: { A: V("Basile") } });
  assert.strictEqual(r.labels.A, undefined);
  assert.ok(r.flag);
});

test("a label that would not change is not rewritten", () => {
  const r = run({ doc: doc({ speakers: ["Basile"], speakerLabels: { A: { name: "Basile", by: "auto" } } }), keys: ["A"], seconds: { A: 100 }, voiceBy: { A: V("Basile") } });
  assert.deepStrictEqual(r.labels, {});
});

test("transcript pass disagreeing with the voice on an open key -> red", () => {
  const r = run({ doc: doc({ speakers: ["Basile", "Erica"] }), keys: ["A", "B"], seconds: { A: 600, B: 600 }, voiceBy: { A: V("Basile") }, fresh: { A: { name: "Erica", quote: "Erica, what do you think" } } });
  assert.strictEqual(r.labels.A, undefined);
  assert.match(r.flag, /transcript Erica vs voice Basile/);
});

test("a weaker answer never downgrades an earlier review's label for the same name", () => {
  const r = run({ doc: doc({ speakerLabels: { A: { name: "Basile", by: "ai-review" } } }), keys: ["A", "B"], seconds: { A: 600, B: 600 }, voiceBy: { A: V("Basile") } });
  assert.deepStrictEqual(r.labels, {});
});

test("the conversation alone naming a voice is shown as a suggestion", () => {
  const r = run({ doc: doc(), keys: ["A", "B"], seconds: { A: 600, B: 600 }, fresh: { B: { name: "Michael", quote: "Michael, what do you think? Well I" } } });
  assert.deepStrictEqual([r.labels.B.name, r.labels.B.by], ["Michael", "claude"]);
});

test("a voice the owner left unnamed is not contradicted by a voice match", () => {
  const r = run({ doc: doc({ speakerLabels: { A: { name: "", by: "user" } } }), keys: ["A"], seconds: { A: 600 }, voiceBy: { A: V("Erica") } });
  assert.strictEqual(r.flag, null);
  assert.deepStrictEqual(r.labels, {});
});

// Voice matching: which diarized voice of a recording is which enrolled
// person. SpeechBrain's ECAPA speaker model (spkrec-ecapa-voxceleb), exported
// to ONNX with its feature front-end, so a 16 kHz mono waveform goes in and a
// 192-dim embedding comes out. The export is checked against the PyTorch
// model to cosine 1.0; tools/voiceprint-export.py rebuilds it.
//
// Decision rule (validated 2026-10-26 on six self-introduced recordings: five
// right, one abstention, no wrong call): voice k is person P's when
//   cosine(k, P) >= 0.35, it beats every other voice for P by >= 0.15,
//   and P is k's best-matching person.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

const MODEL_OBJECT = "models/ecapa-voxceleb.onnx";
const MIN_SCORE = 0.35, MIN_MARGIN = 0.15;
const MIN_UTT_MS = 1500, MAX_SECONDS_PER_VOICE = 90, MAX_CHUNK_SECONDS = 20, MIN_SECONDS = 5;
const SR = 16000;

let session = null;
async function model(bucket) {
  if (session) return session;
  const ort = require("onnxruntime-node");
  const local = path.join(os.tmpdir(), "ecapa-voxceleb.onnx");
  if (!fs.existsSync(local)) await bucket.file(MODEL_OBJECT).download({ destination: local });
  session = await ort.InferenceSession.create(local);
  return session;
}

/** A storage object decoded to 16 kHz mono 16-bit samples in a temp file.
 * Only the stretches asked for are read into memory: a five-hour recording
 * decoded whole does not fit the function. close() removes the file. */
async function decode(file) {
  const tmp = path.join(os.tmpdir(), `v-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const raw = tmp + ".s16";
  await file.download({ destination: tmp });
  try {
    await new Promise((resolve, reject) => {
      execFile(ffmpegPath, ["-loglevel", "error", "-y", "-i", tmp, "-ac", "1", "-ar", String(SR), "-f", "s16le", raw], (e) => (e ? reject(e) : resolve()));
    });
  } catch (e) {
    fs.promises.unlink(raw).catch(() => {});
    throw e;
  } finally {
    fs.promises.unlink(tmp).catch(() => {});
  }
  const fd = fs.openSync(raw, "r");
  const length = fs.fstatSync(fd).size >> 1;
  return {
    length,
    subarray(from, to) {
      from = Math.max(0, Math.min(from, length));
      to = Math.max(from, Math.min(to, length));
      const buf = Buffer.alloc((to - from) * 2);
      fs.readSync(fd, buf, 0, buf.length, from * 2);
      const out = new Float32Array(to - from);
      for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
      return out;
    },
    close() {
      try { fs.closeSync(fd); } catch {}
      fs.promises.unlink(raw).catch(() => {});
    },
  };
}

function normalize(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return Array.from(v, (x) => x / n);
}
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

async function embed(bucket, samples) {
  const ort = require("onnxruntime-node");
  const s = await model(bucket);
  const out = await s.run({ wav: new ort.Tensor("float32", Float32Array.from(samples), [1, samples.length]) });
  return normalize(out.emb.data);
}

/** One embedding per diarized voice with enough clean speech: its longest
 * turns, up to 90 s, each embedded and averaged. */
async function voiceEmbeddings(bucket, wav, utterances) {
  const by = Object.create(null);
  for (const u of utterances) if (u.end - u.start >= MIN_UTT_MS) (by[u.speaker] = by[u.speaker] || []).push(u);
  const out = Object.create(null);
  for (const [k, us] of Object.entries(by)) {
    us.sort((a, b) => (b.end - b.start) - (a.end - a.start));
    const es = [];
    let total = 0;
    for (const u of us) {
      // One turn can be a whole dictation: never more than 20 s per pass.
      const secs = Math.min((u.end - u.start) / 1000, MAX_CHUNK_SECONDS, MAX_SECONDS_PER_VOICE - total);
      const from = Math.floor(u.start * SR / 1000);
      const chunk = wav.subarray(from, from + Math.floor(secs * SR));
      if (chunk.length > SR) es.push(await embed(bucket, chunk));
      total += secs;
      if (total >= MAX_SECONDS_PER_VOICE) break;
    }
    if (total >= MIN_SECONDS && es.length) out[k] = normalize(es[0].map((_, i) => es.reduce((s, e) => s + e[i], 0) / es.length));
  }
  return out;
}

/** Voices against references ({name: embedding}): scores, and the voices
 * that decisively belong to someone. */
function match(voices, refs) {
  const scores = Object.create(null);
  for (const [k, e] of Object.entries(voices)) {
    scores[k] = Object.create(null);
    for (const [p, r] of Object.entries(refs)) scores[k][p] = Math.round(dot(e, r) * 1000) / 1000;
  }
  const matches = Object.create(null);
  for (const p of Object.keys(refs)) {
    const ranked = Object.keys(scores).map((k) => [scores[k][p], k]).sort((a, b) => b[0] - a[0]);
    if (!ranked.length) continue;
    const [top, k] = ranked[0];
    const margin = top - (ranked.length > 1 ? ranked[1][0] : -1);
    const best = Object.entries(scores[k]).sort((a, b) => b[1] - a[1])[0][0];
    if (top >= MIN_SCORE && margin >= MIN_MARGIN && best === p) matches[k] = { name: p, score: top, margin: Math.round(margin * 1000) / 1000 };
  }
  return { scores, matches };
}

module.exports = { MODEL_OBJECT, decode, embed, voiceEmbeddings, match, dot, normalize };

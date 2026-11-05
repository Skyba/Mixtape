// Creates a read-only API key for someone else: it never reaches a recording
// marked private, and has no audio or write access. The value goes straight to
// 1Password and is never printed.
//
//   node tools/create-reader-key.js --uid <uid> --name grok --vault Agent-Grok
//
// Uses Google application-default credentials with admin rights.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const admin = require("../functions/node_modules/firebase-admin");

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const uid = arg("uid"), name = arg("name"), vault = arg("vault");
if (!uid || !name || !vault) { console.error("usage: create-reader-key.js --uid <uid> --name <name> --vault <vault>"); process.exit(1); }

(async () => {
  const token = "mxt_live_" + crypto.randomBytes(24).toString("hex");
  const item = `MIXTAPE_API_KEY-${name}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mxt-"));
  const tpl = path.join(dir, "item.json");
  fs.writeFileSync(tpl, JSON.stringify({
    title: item, category: "API_CREDENTIAL",
    fields: [{ id: "credential", label: "credential", type: "CONCEALED", value: token }],
  }), { mode: 0o600 });
  try {
    execFileSync("op", ["item", "create", "--vault", vault, "--template", tpl], { stdio: "ignore" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  admin.initializeApp({ projectId: "recorder-bv001" });
  await admin.firestore().collection("apiKeys").doc(crypto.createHash("sha256").update(token).digest("hex")).set({
    ownerUid: uid, name, hidePrivate: true,
    scopes: ["read:transcripts", "read:meta", "read:json"],
    createdAt: new Date().toISOString(),
  });
  console.log(`key stored as op://${vault}/${item}/credential`);
})().catch((e) => { console.error(e.message); process.exit(1); });

/**
 * MIRROR of comm-relay/routes.json `folders[]` — the archive is the source of
 * truth and this is a hand-kept copy (the app deliberately does not fetch it).
 * When routes.json changes, make the same edit here.
 *
 * The folder a recording is stored in IS the folder the archive files it into:
 * pull.py reads the API's `folder` and matches it against routes.json, treating
 * "Inbox" as unset. A folder that isn't in routes.json still records fine, it
 * just lands at the archive root until the same name is added there.
 */
export const INBOX = "Inbox";

export type FolderSpec = {
  name: string;
  tags: string[];
  /** routes.json `defaults.private` — privacy only ever goes up from here. */
  alwaysPrivate?: boolean;
};

export const FOLDERS: FolderSpec[] = [
  { name: "self", tags: ["journal", "idea", "plan", "rant"], alwaysPrivate: true },
  { name: "erica", tags: ["poly", "update", "conflit", "plans"] },
  { name: "chainlabs", tags: ["tech", "hiring", "okr"] },
  { name: "cell & sat", tags: ["strat", "produit", "rh", "nego"] },
  { name: "retrace", tags: ["standup", "ads", "1-1"] },
  { name: "volt", tags: ["fund", "france"] },
  { name: "martin", tags: ["venture", "content", "policy"] },
  { name: "famille", tags: ["logist", "sante"] },
  { name: "boys club", tags: ["plans", "banter"] },
  { name: "olivier coste", tags: [] },
  { name: "kim-fundraising", tags: [] },
  { name: "varia personal", tags: [] },
  { name: "egypt", tags: [] },
  { name: "nllm", tags: ["founder-talk"] },
];

/** Starting icon per folder; overridable in Settings ▸ Folder icons. */
export const DEFAULT_ICONS: Record<string, string> = {
  Inbox: "📥",
  self: "🪞",
  erica: "👩",
  chainlabs: "⛓️",
  "cell & sat": "🛰️",
  retrace: "🔎",
  volt: "⚡",
  martin: "🚀",
  famille: "👨‍👩‍👧",
  "boys club": "🍻",
  "olivier coste": "📘",
  "kim-fundraising": "💰",
  "varia personal": "🗂️",
  egypt: "🏜️",
  nllm: "🤖",
};

const KNOWN = new Set(FOLDERS.map((f) => f.name.toLowerCase()));

/** A folder the archive doesn't know about yet — recordings land at its root. */
export function isUnknownFolder(name: string): boolean {
  const n = (name || "").trim();
  return !!n && n.toLowerCase() !== INBOX.toLowerCase() && !KNOWN.has(n.toLowerCase());
}

/** routes.json says this folder is private whatever the switch says. */
export function alwaysPrivate(name: string): boolean {
  const f = FOLDERS.find((x) => x.name.toLowerCase() === (name || "").toLowerCase());
  return !!f?.alwaysPrivate;
}

export function builtinTags(name: string): string[] {
  const f = FOLDERS.find((x) => x.name.toLowerCase() === (name || "").toLowerCase());
  return f ? f.tags : [];
}

/**
 * Tags travel to the archive verbatim (pull.py keeps yours even outside the
 * folder's vocabulary), so they only need to survive a filename: lowercase and
 * at most 10 characters.
 */
export function normalizeTag(raw: string): string {
  return (raw || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9à-ÿ_-]/g, "")
    .slice(0, 10);
}

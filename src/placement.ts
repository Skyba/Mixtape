/**
 * Folder and tag rules. The folder list itself is personal, so it lives in the
 * gitignored placement.local.ts — copy placement.local.example.ts to create it.
 *
 * The folder a recording is stored in IS the folder the archive files it into:
 * pull.py reads the API's `folder` and matches it against routes.json, treating
 * "Inbox" as unset. A folder that isn't in routes.json still records fine, it
 * just lands at the archive root until the same name is added there.
 */
export { DEFAULT_ICONS, FOLDERS } from "./placement.local";
import { FOLDERS } from "./placement.local";

export const INBOX = "Inbox";

export type FolderSpec = {
  name: string;
  tags: string[];
  /** routes.json `defaults.private` — privacy only ever goes up from here. */
  alwaysPrivate?: boolean;
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

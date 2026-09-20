/**
 * Copy to placement.local.ts and put your own folders in. The app will not
 * bundle without that file â same arrangement as firebaseConfig.example.ts.
 *
 * `name`   the folder a recording is filed into.
 * `tags`   the tags offered for it (you can always type others).
 * `alwaysPrivate` forces privacy on for everything in the folder.
 */
import type { FolderSpec } from "./placement";

export const FOLDERS: FolderSpec[] = [
  { name: "personal", tags: ["journal", "idea"], alwaysPrivate: true },
  { name: "work", tags: ["standup", "1-1", "plan"] },
  { name: "calls", tags: [] },
];

/** Starting icon per folder; overridable in Settings > Folder icons. */
export const DEFAULT_ICONS: Record<string, string> = {
  Inbox: "ð¥",
  personal: "ðª",
  work: "ð¼",
  calls: "ð",
};

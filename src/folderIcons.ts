import { useEffect, useState } from "react";
import { DEFAULT_ICONS } from "./placement";
import { getFolderIcons, setFolderIcon } from "./storage";

/** Grouped so an icon can be found by what the folder is about. */
export const ICON_GROUPS: { label: string; icons: string[] }[] = [
  { label: "People", icons: ["👩", "👨", "🧑", "👶", "👨‍👩‍👧", "❤️", "🍻", "🤝"] },
  { label: "Work", icons: ["💼", "🏢", "📈", "💰", "⚖️", "🤖", "💻", "⛓️"] },
  { label: "Places", icons: ["🏠", "🏔️", "🏜️", "🌍", "✈️", "🚗", "🛰️", "🌊"] },
  { label: "Things", icons: ["📥", "🗂️", "📁", "📌", "🔖", "📚", "🎧", "🎬"] },
  { label: "Ideas", icons: ["💡", "📝", "🎯", "🔥", "🪞", "🧘", "🔎", "⚡"] },
];

// One shared copy for the whole app. Per-screen state meant editing an icon in
// Settings left the Record screen and the library showing the old one until
// they happened to remount.
let cache: Record<string, string> | null = null;
const subscribers = new Set<(v: Record<string, string>) => void>();

function publish(next: Record<string, string>) {
  cache = next;
  for (const fn of subscribers) fn(next);
}

/** Folder → icon, kept in sync across every screen that shows one. */
export function useFolderIcons(): Record<string, string> {
  const [icons, setIcons] = useState<Record<string, string>>(cache ?? {});
  useEffect(() => {
    subscribers.add(setIcons);
    if (cache === null) getFolderIcons().then(publish);
    else setIcons(cache);
    return () => {
      subscribers.delete(setIcons);
    };
  }, []);
  return icons;
}

/** Sets (or with "" clears) a folder's icon everywhere at once. */
export async function saveFolderIcon(folder: string, icon: string) {
  const next = { ...(cache ?? (await getFolderIcons())) };
  if (icon) next[folder] = icon;
  else delete next[folder];
  publish(next);
  await setFolderIcon(folder, icon);
}

export function iconOf(folder: string, icons: Record<string, string>): string {
  return icons[folder] || DEFAULT_ICONS[folder] || "📁";
}

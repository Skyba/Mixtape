import AsyncStorage from "@react-native-async-storage/async-storage";
import { DEFAULT_SETTINGS, Settings } from "./types";

const K = {
  settings: "settings",
  speakers: "speakerHistory",
  folders: "folderList",
  tags: "folderTags",
};

async function getJSON<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

async function setJSON(key: string, value: unknown): Promise<void> {
  await AsyncStorage.setItem(key, JSON.stringify(value));
}

export async function getSettings(): Promise<Settings> {
  const s = await getJSON<Partial<Settings>>(K.settings, {});
  return { ...DEFAULT_SETTINGS, ...s };
}

export async function saveSettings(s: Settings): Promise<void> {
  await setJSON(K.settings, s);
}

export async function getSpeakerHistory(): Promise<string[]> {
  return getJSON<string[]>(K.speakers, []);
}

export async function getFolders(): Promise<string[]> {
  return getJSON<string[]>(K.folders, []);
}

async function mergeHistory(key: string, items: string[]): Promise<void> {
  const cur = await getJSON<string[]>(key, []);
  const next = Array.from(new Set([...items.map((s) => s.trim()).filter(Boolean), ...cur]));
  await setJSON(key, next);
}

export async function rememberSpeakers(items: string[]): Promise<void> {
  await mergeHistory(K.speakers, items);
}

export async function rememberFolder(folder: string): Promise<void> {
  await mergeHistory(K.folders, [folder]);
}

/** Tags added by hand, per folder, on top of the routes.json vocabulary. */
export async function getCustomTags(): Promise<Record<string, string[]>> {
  return getJSON<Record<string, string[]>>(K.tags, {});
}

export async function rememberTag(folder: string, tag: string): Promise<void> {
  const all = await getCustomTags();
  const cur = all[folder] ?? [];
  if (!cur.includes(tag)) all[folder] = [...cur, tag];
  await setJSON(K.tags, all);
}

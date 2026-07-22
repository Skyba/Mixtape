import AsyncStorage from "@react-native-async-storage/async-storage";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";

const KEY = "debugLog";
const MAX_LINES = 800;
let buffer: string[] = [];
let loaded = false;

async function ensureLoaded() {
  if (loaded) return;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw) buffer = JSON.parse(raw);
  } catch {}
  loaded = true;
}

/** Appends a timestamped line to the rolling debug log (persisted). */
export async function logEvent(msg: string): Promise<void> {
  await ensureLoaded();
  buffer.push(`${new Date().toISOString()} ${msg}`);
  if (buffer.length > MAX_LINES) buffer = buffer.slice(-MAX_LINES);
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(buffer));
  } catch {}
}

export async function getLogText(): Promise<string> {
  await ensureLoaded();
  return buffer.join("\n");
}

/** Opens the share sheet with the log as a .txt file. */
export async function exportLog(): Promise<void> {
  const text = (await getLogText()) || "(log empty)";
  const path = `${FileSystem.cacheDirectory}mixtape-debug-log.txt`;
  await FileSystem.writeAsStringAsync(path, text);
  if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(path);
}

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as FileSystem from "expo-file-system/legacy";
import { logEvent } from "./log";
import type { StopArgs } from "./recordingFlow";

/**
 * A take in progress, written when recording starts and removed when its
 * save completes. If the app process dies mid-take (the OS reclaiming it,
 * a crash, a swipe), the next launch finds this and saves the audio that
 * is already on disk — with the real start time — instead of leaving it
 * to be found under "Unsaved audio in cache".
 */
const KEY = "pendingTake.v1";

export type PendingTake = Omit<StopArgs, "settings" | "durationSeconds"> & { startedAt: string };

export async function markPending(p: PendingTake): Promise<void> {
  try { await AsyncStorage.setItem(KEY, JSON.stringify(p)); } catch {}
}
export async function clearPending(cacheUri?: string): Promise<void> {
  try {
    if (cacheUri) {
      const raw = await AsyncStorage.getItem(KEY);
      if (!raw || JSON.parse(raw).cacheUri !== cacheUri) return;
    }
    await AsyncStorage.removeItem(KEY);
  } catch {}
}
export async function readPending(): Promise<PendingTake | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as PendingTake;
    const info = await FileSystem.getInfoAsync(p.cacheUri);
    if (!info.exists || !(info.size ?? 0)) {
      logEvent(`pending take ${p.startedAt}: no audio on disk; dropping marker`);
      await AsyncStorage.removeItem(KEY);
      return null;
    }
    return p;
  } catch {
    return null;
  }
}

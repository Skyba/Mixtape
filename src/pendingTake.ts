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

export type PendingTake = Omit<StopArgs, "settings" | "durationSeconds"> & {
  startedAt: string;
  // A chunked or live take: the segments finished so far, in order. Rewritten
  // at every boundary. cacheUri is not used for these.
  segments?: string[];
  live?: boolean;
};

export async function markPending(p: PendingTake): Promise<void> {
  try { await AsyncStorage.setItem(KEY, JSON.stringify(p)); } catch {}
}
/** Clears the marker; with a key, only if it belongs to that take (its cacheUri or startedAt). */
export async function clearPending(key?: string): Promise<void> {
  try {
    if (key) {
      const raw = await AsyncStorage.getItem(KEY);
      if (!raw) return;
      const p = JSON.parse(raw) as PendingTake;
      if (p.cacheUri !== key && p.startedAt !== key) return;
    }
    await AsyncStorage.removeItem(KEY);
  } catch {}
}
/** The marker as stored, without checking the disk. */
export async function peekPending(): Promise<PendingTake | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as PendingTake) : null;
  } catch {
    return null;
  }
}
export async function readPending(): Promise<PendingTake | null> {
  try {
    const p = await peekPending();
    if (!p) return null;
    if (p.segments) {
      const kept: string[] = [];
      for (const u of p.segments) {
        const i = await FileSystem.getInfoAsync(u);
        if (i.exists && (i.size ?? 0)) kept.push(u);
      }
      if (kept.length < p.segments.length) {
        logEvent(`pending take ${p.startedAt}: ${p.segments.length - kept.length} of ${p.segments.length} segments missing on disk`);
      }
      if (!kept.length) {
        logEvent(`pending take ${p.startedAt}: no segments on disk; dropping marker`);
        await AsyncStorage.removeItem(KEY);
        return null;
      }
      return { ...p, segments: kept };
    }
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

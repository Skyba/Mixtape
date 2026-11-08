import { NativeModule, requireNativeModule } from "expo";

/** One audio input as the system sees it, USB dongles included. */
export type AudioInput = {
  id: number;
  name: string;
  type: string;
  external: boolean;
  channels: number[];
};

type MixtapeWakelockEvents = {
  onRecordingSilenced: (event: { silenced: boolean }) => void;
  onSegmentDue: (event: { token: number }) => void;
  onStopRequested: (event: {}) => void;
};

declare class MixtapeWakelockModule extends NativeModule<MixtapeWakelockEvents> {
  acquire(): void;
  release(): void;
  listInputs(): AudioInput[];
  startSilenceWatch(): void;
  stopSilenceWatch(): void;
  scheduleSegment(delayMs: number, token: number): void;
  cancelSegment(): void;
  startTakeService(text: string): Promise<boolean>;
  updateTakeService(text: string): void;
  stopTakeService(): void;
  isTakeServiceRunning(): boolean;
  hasActivity(): boolean;
  consumeStopRequest(): boolean;
}

const mod = (() => {
  try {
    return requireNativeModule<MixtapeWakelockModule>("MixtapeWakelock");
  } catch {
    return null;
  }
})();

export function acquireWakelock(): void {
  try {
    mod?.acquire();
  } catch {}
}

export function releaseWakelock(): void {
  try {
    mod?.release();
  } catch {}
}

/** Empty on an older build that predates the native listInputs function. */
export function listAudioInputs(): AudioInput[] {
  try {
    return mod?.listInputs() ?? [];
  } catch {
    return [];
  }
}

/** Types that exist to be a microphone. A USB receiver or dongle is here. */
const MIC_TYPES = ["usb", "usb-headset", "usb-accessory"];

/**
 * The input to prefer automatically, or null to stay on the phone's own mic.
 *
 * Only devices whose purpose is a microphone count. Bluetooth earbuds and
 * speakers report themselves as external inputs and were being selected over
 * the built-in mic — a Bluetooth speaker is not a microphone worth recording a
 * conversation on, and SCO quality is far below the phone's own. Anything else
 * is a deliberate choice, so it is offered rather than taken automatically.
 */
export function externalInput(): AudioInput | null {
  return listAudioInputs().find((i) => MIC_TYPES.includes(i.type)) ?? null;
}

/** Everything the recorder could be pointed at, for manual selection. */
export function selectableInputs(): AudioInput[] {
  return listAudioInputs();
}

/**
 * Calls back when Android starts or stops feeding this app silence instead of
 * microphone audio — which is what happens when a VoIP call takes the mic, and
 * which is otherwise invisible: the take keeps running and writes an empty
 * file. No-ops on Android below 10 and on a build predating the native
 * function. Returns an unsubscribe.
 */
export function watchSilence(
  onChange: (silenced: boolean) => void
): () => void {
  if (!mod) return () => {};
  let sub: { remove(): void } | undefined;
  try {
    sub = mod.addListener("onRecordingSilenced", (e) => onChange(e.silenced));
    mod.startSilenceWatch();
  } catch {
    sub?.remove();
    return () => {};
  }
  return () => {
    try {
      mod.stopSilenceWatch();
    } catch {}
    sub?.remove();
  };
}

/** True when the installed build has the native segment timer. */
export function hasNativeSegmentTimer(): boolean {
  return typeof (mod as any)?.scheduleSegment === "function";
}

/**
 * Asks for one onSegmentDue event in `delayMs`. Runs on a native thread, so
 * unlike setTimeout it still fires with the app backgrounded. One-shot: re-arm
 * it when the next segment is actually recording, so a late tick cannot queue
 * a burst of rolls behind it. Returns false when the build predates it.
 */
export function scheduleSegment(delayMs: number, token: number): boolean {
  try {
    if (!hasNativeSegmentTimer()) return false;
    mod!.scheduleSegment(Math.max(0, Math.round(delayMs)), token);
    return true;
  } catch {
    return false;
  }
}

export function cancelSegment(): void {
  try {
    mod?.cancelSegment();
  } catch {}
}

/** Subscribes to the native segment tick. Returns an unsubscribe. */
export function onSegmentDue(cb: (token: number) => void): () => void {
  if (!mod) return () => {};
  try {
    const sub = mod.addListener("onSegmentDue", (e) => cb(e.token));
    return () => sub.remove();
  } catch {
    return () => {};
  }
}

/**
 * Starts the app's own microphone foreground service, held for the whole take
 * so that restarting the recorder at a segment boundary in the background is
 * not silenced. Call it with the app on screen. Resolves false on a build that
 * predates it or when Android refused it; expo-audio's own service is then
 * the only one, as before.
 */
export async function startTakeService(text: string): Promise<boolean> {
  try {
    if (typeof (mod as any)?.startTakeService !== "function") return false;
    return await Promise.race([
      mod!.startTakeService(text),
      new Promise<boolean>((r) => setTimeout(() => r(false), 5000)),
    ]);
  } catch {
    return false;
  }
}

export function updateTakeService(text: string): void {
  try {
    (mod as any)?.updateTakeService?.(text);
  } catch {}
}

export function stopTakeService(): void {
  try {
    (mod as any)?.stopTakeService?.();
  } catch {}
}

/** True on a build without the function: the old behaviour assumed one. */
export function hasActivity(): boolean {
  try {
    const f = (mod as any)?.hasActivity;
    return typeof f === "function" ? !!f.call(mod) : true;
  } catch {
    return true;
  }
}

/** Whether the notification's Stop was tapped since the last call. */
export function consumeStopRequest(): boolean {
  try {
    return !!(mod as any)?.consumeStopRequest?.();
  } catch {
    return false;
  }
}

/** The notification's Stop & save. Returns an unsubscribe. */
export function onStopRequested(cb: () => void): () => void {
  if (!mod) return () => {};
  try {
    const sub = mod.addListener("onStopRequested", () => cb());
    return () => sub.remove();
  } catch {
    return () => {};
  }
}

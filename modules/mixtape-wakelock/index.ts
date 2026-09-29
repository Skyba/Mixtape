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
};

declare class MixtapeWakelockModule extends NativeModule<MixtapeWakelockEvents> {
  acquire(): void;
  release(): void;
  listInputs(): AudioInput[];
  startSilenceWatch(): void;
  stopSilenceWatch(): void;
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

/** The plugged-in mic, if there is one. Built-in mic is not "external". */
export function externalInput(): AudioInput | null {
  return listAudioInputs().find((i) => i.external) ?? null;
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

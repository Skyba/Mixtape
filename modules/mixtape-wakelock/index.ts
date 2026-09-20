import { NativeModule, requireNativeModule } from "expo";

/** One audio input as the system sees it, USB dongles included. */
export type AudioInput = {
  id: number;
  name: string;
  type: string;
  external: boolean;
  channels: number[];
};

declare class MixtapeWakelockModule extends NativeModule<{}> {
  acquire(): void;
  release(): void;
  listInputs(): AudioInput[];
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

import { NativeModule, requireNativeModule } from "expo";

declare class MixtapeWakelockModule extends NativeModule<{}> {
  acquire(): void;
  release(): void;
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

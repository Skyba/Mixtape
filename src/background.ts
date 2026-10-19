import { flushPendingUploads, retryPendingMerges } from "./recordingFlow";
import { authReady } from "./firebase";
import { getSettings } from "./storage";
import { logEvent } from "./log";

export const UPLOAD_TASK = "mixtape-finish-uploads";

/**
 * Required at module scope, never statically imported: both packages call
 * requireNativeModule in their module bodies, so a static import would throw
 * on any build without them — and updates reach the installed APK before a
 * new one is sideloaded.
 */
function load(): { BackgroundTask: any; TaskManager: any } | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const BackgroundTask = require("expo-background-task");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const TaskManager = require("expo-task-manager");
    if (!BackgroundTask || !TaskManager) return null;
    return { BackgroundTask, TaskManager };
  } catch {
    return null;
  }
}

const mods = load();

// The task body has to be defined as the bundle loads, because the system
// starts the app headlessly to run it and nothing else will have registered it.
if (mods) {
  try {
    mods.TaskManager.defineTask(UPLOAD_TASK, async () => {
      try {
        const settings = await getSettings();
        // Auth restores from storage asynchronously. A headless start reaches
        // here before that finishes, so without this both jobs read "signed
        // out" and the task is a silent no-op — which is the whole feature.
        await authReady();
        // A recording is only transcribable once its sidecar is in Storage,
        // and the upload is skipped when the phone is on cellular and the
        // Wi-Fi-only setting is on. Without this the recording waits for the
        // next time the app is opened, which has been days.
        const merged = await retryPendingMerges(settings);
        const uploaded = await flushPendingUploads(settings);
        if (merged || uploaded) {
          await logEvent(
            `background task: merged=${merged} uploaded=${uploaded}`
          );
        }
        return mods.BackgroundTask.BackgroundTaskResult.Success;
      } catch (e: any) {
        await logEvent(`background task failed: ${String(e?.message ?? e)}`);
        return mods.BackgroundTask.BackgroundTaskResult.Failed;
      }
    });
  } catch {
    /* already defined, or no native module */
  }
}

/**
 * Asks Android to run the task periodically. WorkManager's floor is 15
 * minutes and the system decides the moment, so this is "soon after there is
 * a network", not a schedule. Safe to call on every launch.
 */
export async function registerUploadTask(): Promise<void> {
  if (!mods) return;
  try {
    const already = await mods.TaskManager.isTaskRegisteredAsync(UPLOAD_TASK);
    if (already) return;
    await mods.BackgroundTask.registerTaskAsync(UPLOAD_TASK, {
      minimumInterval: 15,
    });
    await logEvent("background upload task registered");
  } catch {
    /* unsupported build or OS refusal — the app still uploads in foreground */
  }
}

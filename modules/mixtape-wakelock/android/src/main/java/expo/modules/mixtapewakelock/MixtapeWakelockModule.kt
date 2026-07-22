package expo.modules.mixtapewakelock

import android.content.Context
import android.os.PowerManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class MixtapeWakelockModule : Module() {
  private var wakeLock: PowerManager.WakeLock? = null

  override fun definition() = ModuleDefinition {
    Name("MixtapeWakelock")

    // Hold a partial wakelock so the CPU keeps running (screen can be off) and
    // the audio recording thread isn't starved during Doze.
    Function("acquire") {
      val context = appContext.reactContext
      if (context != null) {
        val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        if (wakeLock == null) {
          wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Mixtape:recording")
          wakeLock?.setReferenceCounted(false)
        }
        if (wakeLock?.isHeld != true) {
          wakeLock?.acquire(4 * 60 * 60 * 1000L) // 4h safety cap
        }
      }
    }

    Function("release") {
      if (wakeLock?.isHeld == true) {
        wakeLock?.release()
      }
    }
  }
}

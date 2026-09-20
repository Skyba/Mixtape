package expo.modules.mixtapewakelock

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
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

    // Every audio input the system can see, unfiltered. expo-audio's own
    // getAvailableInputs() keeps only the built-in mic, a wired headset and
    // Bluetooth SCO, so a USB-C mic dongle is invisible through it. This is
    // the same AudioManager query a plain Android recorder app makes, and it
    // needs no recorder instance, so it works before a take starts.
    Function("listInputs") {
      val context = appContext.reactContext
        ?: return@Function emptyList<Map<String, Any>>()
      val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
      am.getDevices(AudioManager.GET_DEVICES_INPUTS).map { device ->
        mapOf(
          // id is what expo-audio's setInput() resolves against.
          "id" to device.id,
          "name" to device.productName.toString(),
          "type" to typeName(device.type),
          "external" to EXTERNAL_TYPES.contains(device.type),
          // How many channels the hardware can actually deliver. A dongle
          // reporting 2 is the prerequisite for per-mic separation.
          "channels" to device.channelCounts.toList()
        )
      }
    }
  }

  private fun typeName(type: Int) = when (type) {
    AudioDeviceInfo.TYPE_BUILTIN_MIC -> "builtin"
    AudioDeviceInfo.TYPE_USB_DEVICE -> "usb"
    AudioDeviceInfo.TYPE_USB_HEADSET -> "usb-headset"
    AudioDeviceInfo.TYPE_USB_ACCESSORY -> "usb-accessory"
    AudioDeviceInfo.TYPE_WIRED_HEADSET -> "wired"
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "bluetooth"
    AudioDeviceInfo.TYPE_TELEPHONY -> "telephony"
    else -> "other-$type"
  }

  companion object {
    private val EXTERNAL_TYPES = setOf(
      AudioDeviceInfo.TYPE_USB_DEVICE,
      AudioDeviceInfo.TYPE_USB_HEADSET,
      AudioDeviceInfo.TYPE_USB_ACCESSORY,
      AudioDeviceInfo.TYPE_WIRED_HEADSET,
      AudioDeviceInfo.TYPE_BLUETOOTH_SCO
    )
  }
}

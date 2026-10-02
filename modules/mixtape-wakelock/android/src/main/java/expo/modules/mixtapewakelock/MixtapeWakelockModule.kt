package expo.modules.mixtapewakelock

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.AudioRecordingConfiguration
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class MixtapeWakelockModule : Module() {
  private var wakeLock: PowerManager.WakeLock? = null
  private var recordingCallback: AudioManager.AudioRecordingCallback? = null
  private var lastSilenced = false

  override fun definition() = ModuleDefinition {
    Name("MixtapeWakelock")

    Events("onRecordingSilenced")

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

    // Android hands an ordinary app SILENCE, not an error, when something with
    // a higher-priority use case holds the mic — a VoIP call is the case that
    // matters here. The take then runs to completion and the file is a
    // well-formed, entirely empty recording. isClientSilenced() is the only
    // way to know it happened, so watch it and let the screen say so while
    // there is still time to do something about it.
    // Guarded with a single condition rather than early returns: this builder
    // types its body as Any?, and a bare return@Function is Unit.
    Function("startSilenceWatch") {
      val context = appContext.reactContext
      if (
        context != null &&
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
        recordingCallback == null
      ) {
        val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        lastSilenced = false
        val cb = object : AudioManager.AudioRecordingCallback() {
          override fun onRecordingConfigChanged(
            configs: MutableList<AudioRecordingConfiguration>?
          ) {
            val silenced =
              if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
                configs?.any { it.isClientSilenced } ?: false
              else false
            if (silenced != lastSilenced) {
              lastSilenced = silenced
              this@MixtapeWakelockModule.sendEvent(
                "onRecordingSilenced",
                mapOf("silenced" to silenced)
              )
            }
          }
        }
        am.registerAudioRecordingCallback(cb, Handler(Looper.getMainLooper()))
        recordingCallback = cb
      }
      null
    }

    Function("stopSilenceWatch") {
      val context = appContext.reactContext
      val cb = recordingCallback
      if (context != null && cb != null) {
        val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        am.unregisterAudioRecordingCallback(cb)
      }
      recordingCallback = null
      lastSilenced = false
      null
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

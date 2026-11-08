package expo.modules.mixtapewakelock

import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.AudioRecordingConfiguration
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.SystemClock
import android.os.PowerManager
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class MixtapeWakelockModule : Module() {
  private var wakeLock: PowerManager.WakeLock? = null
  private var recordingCallback: AudioManager.AudioRecordingCallback? = null
  private var lastSilenced = false
  // Own thread, so the segment tick does not sit behind whatever else is
  // queued on the main looper.
  private var segThread: HandlerThread? = null
  private var segHandler: Handler? = null
  private var segRunnable: Runnable? = null
  private var segSeq = 0
  // Set when the notification's Stop opened the app; read once by JS, which
  // may not be listening yet when the activity is recreated.
  private var stopRequested = false

  override fun definition() = ModuleDefinition {
    Name("MixtapeWakelock")

    Events("onRecordingSilenced", "onSegmentDue", "onStopRequested")

    // Must be called with the app on screen: that is the only moment Android
    // lets a microphone foreground service start. Resolves false when it was
    // refused, so the caller can fall back to expo-audio's own service.
    AsyncFunction("startTakeService") { text: String, promise: Promise ->
      val context = appContext.reactContext
      if (context == null) {
        promise.resolve(false)
      } else if (MixtapeRecordingService.running) {
        updateNotification(context, text)
        promise.resolve(true)
      } else {
        MixtapeRecordingService.onStarted = { ok -> promise.resolve(ok) }
        try {
          // startService, not startForegroundService: the app is in the
          // foreground, and this way a refused startForeground() just stops
          // the service instead of tripping the five-second crash contract.
          context.startService(
            Intent(context, MixtapeRecordingService::class.java)
              .putExtra(MixtapeRecordingService.EXTRA_TEXT, text)
          )
        } catch (e: Exception) {
          MixtapeRecordingService.onStarted = null
          promise.resolve(false)
        }
      }
    }

    Function("updateTakeService") { text: String ->
      val context = appContext.reactContext
      if (context != null && MixtapeRecordingService.running) updateNotification(context, text)
      null
    }

    Function("stopTakeService") {
      val context = appContext.reactContext
      if (context != null) {
        context.stopService(Intent(context, MixtapeRecordingService::class.java))
      }
      null
    }

    Function("isTakeServiceRunning") {
      MixtapeRecordingService.running
    }

    // expo-audio's recorder calls need an activity. After a swipe from recents
    // the JS runtime and the recorder survive without one, and a stop then
    // throws halfway, so the caller waits for the app to be reopened instead.
    Function("hasActivity") {
      appContext.currentActivity != null
    }

    Function("consumeStopRequest") {
      val was = stopRequested
      stopRequested = false
      was
    }

    OnNewIntent { intent -> checkStopIntent(intent) }

    OnActivityEntersForeground {
      appContext.currentActivity?.intent?.let { checkStopIntent(it) }
    }

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

    // The segment roll used to be a JS setTimeout. React Native suspends those
    // when the activity is backgrounded, so the native duration cap stopped the
    // recorder on time and nothing ever restarted it: a screen-off take kept
    // its first segment and recorded nothing for the rest of the session. This
    // timer runs on its own thread and fires regardless of what RN is doing.
    //
    // One-shot on purpose. The caller re-arms once the next segment is
    // actually recording, so a tick that arrives late cannot queue a burst of
    // rolls behind it.
    Function("scheduleSegment") { delayMs: Int, token: Int ->
      val h = ensureSegHandler()
      segRunnable?.let { h.removeCallbacks(it) }
      segSeq += 1
      val seq = segSeq
      val r = Runnable {
        // A cancelled or superseded tick must not fire.
        if (seq == segSeq) {
          this@MixtapeWakelockModule.sendEvent("onSegmentDue", mapOf("token" to token))
        }
      }
      segRunnable = r
      h.postAtTime(r, SystemClock.uptimeMillis() + delayMs.toLong().coerceAtLeast(0L))
      null
    }

    Function("cancelSegment") {
      segRunnable?.let { segHandler?.removeCallbacks(it) }
      segRunnable = null
      segSeq += 1 // invalidate anything already in flight
      null
    }

    OnDestroy {
      segRunnable?.let { segHandler?.removeCallbacks(it) }
      segThread?.quitSafely()
      segThread = null
      segHandler = null
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

  private fun checkStopIntent(intent: Intent) {
    if (!intent.getBooleanExtra(MixtapeRecordingService.EXTRA_STOP, false)) return
    // Consumed here, or every later return to the app would stop again.
    intent.removeExtra(MixtapeRecordingService.EXTRA_STOP)
    stopRequested = true
    sendEvent("onStopRequested", mapOf<String, Any>())
  }

  private fun updateNotification(context: Context, text: String) {
    val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    nm.notify(
      MixtapeRecordingService.NOTIFICATION_ID,
      MixtapeRecordingService.buildNotification(context, text)
    )
  }

  private fun ensureSegHandler(): Handler {
    var h = segHandler
    if (h == null) {
      val t = HandlerThread("mixtape-segments").also { it.start() }
      h = Handler(t.looper)
      segThread = t
      segHandler = h
    }
    return h
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

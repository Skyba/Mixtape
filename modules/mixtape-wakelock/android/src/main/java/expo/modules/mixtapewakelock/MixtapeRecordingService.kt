package expo.modules.mixtapewakelock

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat

/**
 * Holds a microphone foreground service for the whole take.
 *
 * expo-audio runs its own service per recorder: every segment stop
 * unregisters the recorder, the service calls stopSelf() when none is left,
 * and the next segment has to start it again. With the app in the background
 * that restart is refused (Android 12+ forbids starting a foreground service
 * from the background, Android 14 a microphone one in particular), the process
 * loses its microphone capability, and Android feeds every later segment
 * silence. Started while the app is on screen and kept until the take is
 * saved, this one keeps the capability across every segment boundary.
 */
class MixtapeRecordingService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val text = intent?.getStringExtra(EXTRA_TEXT) ?: "Recording"
    val ok = try {
      val n = buildNotification(this, text)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
      } else {
        startForeground(NOTIFICATION_ID, n)
      }
      true
    } catch (e: Exception) {
      Log.w(TAG, "startForeground refused", e)
      false
    }
    if (ok) {
      running = true
      // Tied to the service rather than to a timer, so a 10-hour take keeps
      // the CPU awake to the end. The cap only guards against a leak.
      if (wakeLock == null) {
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Mixtape:take").also {
          it.setReferenceCounted(false)
          it.acquire(12 * 60 * 60 * 1000L)
        }
      }
    } else {
      stopSelf()
    }
    val cb = onStarted
    onStarted = null
    cb?.invoke(ok)
    // Not sticky: restarted without the JS take behind it, it would only show
    // a notification for a recording that no longer exists.
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    running = false
    if (wakeLock?.isHeld == true) wakeLock?.release()
    wakeLock = null
    super.onDestroy()
  }

  companion object {
    private const val TAG = "MixtapeRecordingService"
    private const val CHANNEL_ID = "mixtape_take"
    const val NOTIFICATION_ID = 2101
    const val EXTRA_TEXT = "text"
    const val EXTRA_STOP = "mixtape.stopTake"

    @Volatile
    var running = false
    var onStarted: ((Boolean) -> Unit)? = null

    fun buildNotification(context: Context, text: String): Notification {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(CHANNEL_ID) == null) {
          nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Recording", NotificationManager.IMPORTANCE_LOW)
          )
        }
      }
      val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
      val open = launch?.let {
        PendingIntent.getActivity(
          context, 0, Intent(it),
          PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
      }
      // Stop opens the app rather than stopping anything natively: saving
      // the take is JS work, and stopping the recorder through expo-audio
      // needs an activity — which there is none of after a swipe from recents.
      val stop = launch?.let {
        PendingIntent.getActivity(
          context, 1, Intent(it).putExtra(EXTRA_STOP, true),
          PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
      }
      val b = NotificationCompat.Builder(context, CHANNEL_ID)
        .setContentTitle("Mixtape")
        .setContentText(text)
        .setSmallIcon(android.R.drawable.ic_btn_speak_now)
        .setOngoing(true)
        .setCategory(NotificationCompat.CATEGORY_SERVICE)
        .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      if (open != null) b.setContentIntent(open)
      if (stop != null) b.addAction(android.R.drawable.ic_media_pause, "Stop & save", stop)
      return b.build()
    }
  }
}

package com.tauri_app.native_tts

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat

class MediaPlaybackService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null

  companion object {
    const val CHANNEL_ID = "goread_tts_background"
    const val NOTIFICATION_ID = 1002
    const val EXTRA_TITLE = "title"
    const val EXTRA_TEXT = "text"
    const val DEFAULT_TITLE = "GoRead TTS"
    const val DEFAULT_TEXT = "Reading in background"
  }

  override fun onCreate() {
    super.onCreate()
    println("[TTS][Service] onCreate channelId=$CHANNEL_ID")
    createNotificationChannel()
    acquireWakeLock()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val title = intent?.getStringExtra(EXTRA_TITLE) ?: DEFAULT_TITLE
    val text = intent?.getStringExtra(EXTRA_TEXT) ?: DEFAULT_TEXT
    println("[TTS][Service] onStartCommand startId=$startId flags=$flags title=$title text=$text")
    println("[TTS][Service] startForeground notificationId=$NOTIFICATION_ID channelId=$CHANNEL_ID")
    startForeground(NOTIFICATION_ID, buildNotification(title, text))
    return START_STICKY
  }

  override fun onDestroy() {
    println("[TTS][Service] onDestroy notificationId=$NOTIFICATION_ID")
    releaseWakeLock()
    stopForeground(STOP_FOREGROUND_REMOVE)
    super.onDestroy()
  }

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val channel = NotificationChannel(
      CHANNEL_ID,
      "GoRead TTS",
      NotificationManager.IMPORTANCE_DEFAULT
    )
    println("[TTS][Service] createNotificationChannel channelId=$CHANNEL_ID importance=${channel.importance}")
    val manager = getSystemService(NotificationManager::class.java)
    manager?.createNotificationChannel(channel)
  }

  private fun acquireWakeLock() {
    if (wakeLock?.isHeld == true) return
    val powerManager = getSystemService(PowerManager::class.java) ?: return
    wakeLock = powerManager.newWakeLock(
      PowerManager.PARTIAL_WAKE_LOCK,
      "GoRead:TTSBackground"
    ).apply {
      setReferenceCounted(false)
      acquire()
    }
    println("[TTS][Service] wakeLock acquired")
  }

  private fun releaseWakeLock() {
    val lock = wakeLock ?: return
    if (lock.isHeld) {
      lock.release()
      println("[TTS][Service] wakeLock released")
    }
    wakeLock = null
  }

  private fun buildNotification(title: String, text: String): Notification {
    val openIntent = packageManager.getLaunchIntentForPackage(packageName)
    val contentIntent = openIntent?.let {
      PendingIntent.getActivity(
        this,
        0,
        it,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )
    }
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle(title)
      .setContentText(text)
      .setSmallIcon(android.R.drawable.ic_media_play)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setPriority(NotificationCompat.PRIORITY_DEFAULT)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setContentIntent(contentIntent)
      .build()
  }
}


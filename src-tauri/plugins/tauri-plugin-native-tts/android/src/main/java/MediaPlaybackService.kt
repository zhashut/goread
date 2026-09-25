package com.tauri_app.native_tts

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

class MediaPlaybackService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null

  companion object {
    const val CHANNEL_ID = "goread_tts_background"
    const val NOTIFICATION_ID = 1002
    const val EXTRA_TITLE = "title"
    const val EXTRA_TEXT = "text"
    const val DEFAULT_TITLE = "GoRead TTS"
    const val DEFAULT_TEXT = "Reading in background"

    /** 是否已提交前台服务启动请求（前台提升完成前，停止请求需要延后处理） */
    @Volatile
    private var startRequested = false

    /**
     * 最近一次启动请求的通知标题缓存。
     *
     * 设计意图：Service.getIntent() 属于 @hide 的非公开 SDK 方法（android.jar 中不存在，
     * 编译期报 Unresolved reference: intent），onCreate 内读不到启动 Intent。
     * 因此由 requestStart 在启动服务前写入文案缓存，使 onCreate 能用真实文案完成前台提升，
     * 避免「先用默认文案提升、再在 onStartCommand 刷新」造成通知文案跳变。
     */
    @Volatile
    private var lastTitle = DEFAULT_TITLE

    /** 最近一次启动请求的通知正文缓存，与 [lastTitle] 同源写入、同时生效 */
    @Volatile
    private var lastText = DEFAULT_TEXT

    /** 是否已完成前台提升（onCreate 中 startForeground 成功后置位） */
    @Volatile
    private var foregroundPromoted = false

    /** 前台提升完成前收到的停止请求，由服务在提升完成后自行停止 */
    @Volatile
    private var pendingStop = false

    /**
     * 启动后台保活前台服务（幂等，统一入口）。
     *
     * 统一收口启动逻辑，避免调用方各自调用 startForegroundService 造成重复启动；
     * 重复调用会重置系统的 5s 前台提升计时，增加超时崩溃风险。
     */
    fun requestStart(context: Context, title: String, text: String): Boolean {
      if (startRequested && foregroundPromoted) {
        // 服务已在前台运行，无需重复启动（仅通知文案可能略旧，可接受）
        println("[TTS][Service] requestStart skipped: already foreground")
        return true
      }

      startRequested = true
      pendingStop = false
      // 先写缓存再启动：服务 onCreate 在主线程排队执行，@Volatile 保证此处写入对其可见
      lastTitle = title.ifEmpty { DEFAULT_TITLE }
      lastText = text.ifEmpty { DEFAULT_TEXT }
      val intent = Intent(context, MediaPlaybackService::class.java).apply {
        putExtra(EXTRA_TITLE, title)
        putExtra(EXTRA_TEXT, text)
      }
      return try {
        ContextCompat.startForegroundService(context, intent)
        println("[TTS][Service] requestStart channelId=$CHANNEL_ID title=$title text=$text")
        true
      } catch (e: Exception) {
        // 系统可能拒绝后台启动前台服务（ForegroundServiceStartNotAllowedException 等）
        startRequested = false
        println("[TTS][Service] requestStart failed: ${e.javaClass.simpleName} ${e.message ?: ""}")
        false
      }
    }

    /**
     * 停止后台保活前台服务。
     *
     * 关键点：若服务尚未完成前台提升，则只记录待停止标记，等 onCreate 调用完
     * startForeground 后再由服务自行停止。
     * 直接 stopService 会让系统认为「startForegroundService 之后没有调用
     * startForeground」，进而抛出 ForegroundServiceDidNotStartInTimeException 杀掉进程。
     */
    fun requestStop(context: Context) {
      val waitingPromotion = startRequested && !foregroundPromoted
      startRequested = false
      if (waitingPromotion) {
        pendingStop = true
        println("[TTS][Service] requestStop deferred until foreground promoted")
        return
      }

      pendingStop = false
      context.stopService(Intent(context, MediaPlaybackService::class.java))
      println("[TTS][Service] requestStop channelId=$CHANNEL_ID")
    }
  }

  override fun onCreate() {
    super.onCreate()
    println("[TTS][Service] onCreate channelId=$CHANNEL_ID")
    createNotificationChannel()
    // 尽早完成前台提升：只要服务被 startForegroundService 拉起，就必须尽快调用 startForeground，
    // 否则 5s 超时（或服务被提前销毁）都会触发 ForegroundServiceDidNotStartInTimeException。
    // 通知渠道先于 startForeground 创建；文案取自 requestStart 写入的缓存（onCreate 读不到启动 Intent），
    // 避免先用默认文案提升、再在 onStartCommand 中刷新导致的通知跳变。
    promoteToForeground(lastTitle, lastText)
    // 提升完成后再获取 WakeLock，避免其阻塞前台提升
    acquireWakeLock()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val title = intent?.getStringExtra(EXTRA_TITLE) ?: DEFAULT_TITLE
    val text = intent?.getStringExtra(EXTRA_TEXT) ?: DEFAULT_TEXT
    println("[TTS][Service] onStartCommand startId=$startId flags=$flags title=$title text=$text")
    // 用本次启动的文案刷新通知（覆盖 null intent 等场景，startForeground 幂等）
    promoteToForeground(title, text)

    // 提升完成前收到过停止请求：此处安全地自行停止，不会触发系统超时崩溃
    if (pendingStop) {
      pendingStop = false
      startRequested = false
      println("[TTS][Service] pendingStop consumed, stopSelf")
      stopSelf()
    }
    // 不使用 START_STICKY：前台保活只服务于当前进程的朗读会话，进程被杀后重启没有意义
    // （否则会残留幽灵通知与 WakeLock）
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    println("[TTS][Service] onDestroy notificationId=$NOTIFICATION_ID")
    foregroundPromoted = false
    startRequested = false
    pendingStop = false
    releaseWakeLock()
    stopForeground(STOP_FOREGROUND_REMOVE)
    super.onDestroy()
  }

  private fun promoteToForeground(title: String, text: String) {
    try {
      startForeground(NOTIFICATION_ID, buildNotification(title, text))
      foregroundPromoted = true
      println("[TTS][Service] startForeground ok notificationId=$NOTIFICATION_ID channelId=$CHANNEL_ID")
    } catch (e: Exception) {
      // 提升失败（如缺少前台服务类型权限）时记录原因并主动停止，避免异常抛出导致进程崩溃
      println("[TTS][Service] startForeground failed: ${e.javaClass.simpleName} ${e.message ?: ""}")
      stopSelf()
    }
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

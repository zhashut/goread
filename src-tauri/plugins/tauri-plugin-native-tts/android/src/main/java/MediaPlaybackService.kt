package com.tauri_app.native_tts

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import android.util.Base64
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.media.app.NotificationCompat.MediaStyle

/**
 * 朗读后台保活服务。
 *
 * 职责：
 * 1. 前台服务 + WakeLock，保证锁屏/后台朗读不被系统回收；
 * 2. MediaSession + MediaStyle 通知，提供媒体通知与锁屏媒体控件（播放/暂停/停止）；
 * 3. 把媒体控件动作转发给前端 JS，由前端 TTSSession 执行并回写播放状态（单一数据源）。
 */
class MediaPlaybackService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null
  private var mediaSession: MediaSessionCompat? = null
  private val mainHandler = Handler(Looper.getMainLooper())
  /**
   * AudioFocusRequest 是 API 26+ 类型。
   * 字段声明为 Any? 以避免低版本（minSdk 24/25）加载类时解析不到新 API 类型，
   * 真正的创建/使用都在 SDK_INT 判断内完成。
   */
  private var audioFocusRequest: Any? = null
  private var audioFocusHeld = false

  /** 媒体通知大图标（封面）缓存：仅当封面路径变化时重新解码 */
  private var largeIconBitmap: Bitmap? = null
  private var largeIconSource: String? = null

  /**
   * 音频焦点丢失（来电/其他应用播放）时通知前端暂停。
   * 不在 Service 内直接改状态：播放控制权始终在前端，避免双份状态。
   */
  private val audioFocusListener = AudioManager.OnAudioFocusChangeListener { change ->
    when (change) {
      AudioManager.AUDIOFOCUS_LOSS,
      AudioManager.AUDIOFOCUS_LOSS_TRANSIENT,
      AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> dispatchAction(MEDIA_ACTION_PAUSE)
      else -> Unit
    }
  }

  companion object {
    /** 新渠道：低优先级、无声，专用于朗读媒体通知（旧渠道属性不可改，故换新 id） */
    const val CHANNEL_ID = "goread_tts_background_v2"
    /** 旧渠道 id：创建后属性不可修改，升级时清理 */
    private const val LEGACY_CHANNEL_ID = "goread_tts_background"
    const val NOTIFICATION_ID = 1002
    const val EXTRA_TITLE = "title"
    const val EXTRA_TEXT = "text"
    const val DEFAULT_TITLE = "GoRead TTS"
    const val DEFAULT_TEXT = "Reading in background"

    /** 通知按钮 Intent action：点击后回到 Service，再转发给前端 */
    const val ACTION_PLAY = "com.tauri_app.native_tts.action.PLAY"
    const val ACTION_PAUSE = "com.tauri_app.native_tts.action.PAUSE"
    const val ACTION_STOP = "com.tauri_app.native_tts.action.STOP"

    /** 前后端约定的播放状态 */
    const val PLAYBACK_PLAYING = "playing"
    const val PLAYBACK_PAUSED = "paused"
    const val PLAYBACK_STOPPED = "stopped"

    /** 前后端约定的媒体动作（play/pause/stop 按钮 + seek 进度条拖动） */
    const val MEDIA_ACTION_PLAY = "play"
    const val MEDIA_ACTION_PAUSE = "pause"
    const val MEDIA_ACTION_STOP = "stop"
    const val MEDIA_ACTION_SEEK = "seek"

    private const val MEDIA_SESSION_TAG = "GoReadTTS"

    /** 通知强调色（与 App 主题色一致），用于 Android 7+ 的通知着色 */
    private const val NOTIFICATION_COLOR = 0xFFD15158.toInt()

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

    /** 最近一次播放状态：Service 未创建时也先缓存，创建后直接以该状态渲染媒体通知 */
    @Volatile
    private var lastPlaybackState = PLAYBACK_PLAYING

    /** 最近一次封面路径（本地文件路径或 data URL），用于媒体通知大图标 */
    @Volatile
    private var lastLargeIconPath: String? = null

    /** 当前章节内播放位置（ms），用于媒体通知进度条 */
    @Volatile
    private var lastPositionMs = 0L

    /** 当前章节预计时长（ms），用于媒体通知进度条 */
    @Volatile
    private var lastDurationMs = 0L

    /** 最近一次位置更新的系统时间（elapsedRealtime），用于通知重建时插值，避免进度条回跳 */
    @Volatile
    private var lastPositionUpdatedAt = 0L

    /** 是否已完成前台提升（onCreate 中 startForeground 成功后置位） */
    @Volatile
    private var foregroundPromoted = false

    /** 前台提升完成前收到的停止请求，由服务在提升完成后自行停止 */
    @Volatile
    private var pendingStop = false

    /** 当前服务实例（插件通过它把播放状态/文案刷新到通知） */
    @Volatile
    private var instance: MediaPlaybackService? = null

    /** 媒体动作分发器：由插件注入，把通知/锁屏动作转发到前端 JS */
    @Volatile
    private var actionDispatcher: ((String, Long?) -> Unit)? = null

    /**
     * 注册/清除媒体动作分发器（插件创建时注册，销毁时清除）。
     * 传 null 表示当前没有 JS 侧接收者，动作直接丢弃。
     */
    fun setActionDispatcher(dispatcher: ((String, Long?) -> Unit)?) {
      actionDispatcher = dispatcher
    }

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
      lastPlaybackState = PLAYBACK_PLAYING
      lastPositionMs = 0L
      lastDurationMs = 0L
      lastPositionUpdatedAt = SystemClock.elapsedRealtime()
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
      lastPlaybackState = PLAYBACK_STOPPED
      lastPositionMs = 0L
      lastPositionUpdatedAt = SystemClock.elapsedRealtime()
      if (waitingPromotion) {
        pendingStop = true
        println("[TTS][Service] requestStop deferred until foreground promoted")
        return
      }

      pendingStop = false
      context.stopService(Intent(context, MediaPlaybackService::class.java))
      println("[TTS][Service] requestStop channelId=$CHANNEL_ID")
    }

    /**
     * 同步播放状态/文案/封面（由插件命令调用）。
     *
     * 状态由前端会话回写：Service 只负责渲染与转发，不主动改变播放状态。
     * 服务尚未创建时仅更新缓存，待 onCreate 时一次性生效。
     */
    fun updatePlaybackState(
      state: String?,
      title: String?,
      text: String?,
      largeIconPath: String?,
      positionMs: Long?,
      durationMs: Long?,
    ) {
      if (state != null) lastPlaybackState = normalizePlaybackState(state)
      if (!title.isNullOrBlank()) lastTitle = title
      if (!text.isNullOrBlank()) lastText = text
      if (largeIconPath != null) lastLargeIconPath = largeIconPath
      if (positionMs != null) {
        lastPositionMs = positionMs.coerceAtLeast(0L)
        lastPositionUpdatedAt = SystemClock.elapsedRealtime()
      }
      if (durationMs != null) lastDurationMs = durationMs.coerceAtLeast(0L)
      instance?.postPlaybackUpdate()
    }

    /** 归一化前端传入的状态，未知值按 playing 处理（服务只在前台提升时被拉起） */
    private fun normalizePlaybackState(raw: String?): String =
      when (raw?.trim()?.lowercase()) {
        PLAYBACK_PAUSED -> PLAYBACK_PAUSED
        PLAYBACK_STOPPED -> PLAYBACK_STOPPED
        PLAYBACK_PLAYING -> PLAYBACK_PLAYING
        else -> PLAYBACK_PLAYING
      }
  }

  override fun onCreate() {
    super.onCreate()
    instance = this
    println("[TTS][Service] onCreate channelId=$CHANNEL_ID")
    createNotificationChannel()
    // 媒体会话先于通知建立，保证首个通知就带 MediaStyle 与 token
    setupMediaSession()
    // 若缓存里已有封面，先解好大图标，避免首个通知缺图
    resolveLargeIcon(lastLargeIconPath)
    // 尽早完成前台提升：只要服务被 startForegroundService 拉起，就必须尽快调用 startForeground，
    // 否则 5s 超时（或服务被提前销毁）都会触发 ForegroundServiceDidNotStartInTimeException。
    promoteToForeground(lastTitle, lastText)
    // 提升完成后再获取 WakeLock，避免其阻塞前台提升
    acquireWakeLock()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val action = intent?.action
    // 通知按钮/媒体按键动作：只转发给前端，状态由前端回写，避免双份状态
    if (action == ACTION_PLAY || action == ACTION_PAUSE || action == ACTION_STOP) {
      if (!foregroundPromoted) {
        // 极端场景（服务曾被回收后由 PendingIntent 拉起）：仍要先完成前台提升
        promoteToForeground(lastTitle, lastText)
      }
      dispatchAction(
        when (action) {
          ACTION_PLAY -> MEDIA_ACTION_PLAY
          ACTION_PAUSE -> MEDIA_ACTION_PAUSE
          else -> MEDIA_ACTION_STOP
        }
      )
      return START_NOT_STICKY
    }

    val title = intent?.getStringExtra(EXTRA_TITLE) ?: DEFAULT_TITLE
    val text = intent?.getStringExtra(EXTRA_TEXT) ?: DEFAULT_TEXT
    println("[TTS][Service] onStartCommand startId=$startId flags=$flags title=$title text=$text")
    lastTitle = title
    lastText = text
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
    instance = null
    releaseWakeLock()
    abandonAudioFocus()
    try {
      mediaSession?.isActive = false
      mediaSession?.release()
    } catch (e: Exception) {
      println("[TTS][Service] mediaSession release failed: ${e.javaClass.simpleName} ${e.message ?: ""}")
    }
    mediaSession = null
    // 释放封面缓存，避免 Service 反复创建时累积内存
    try {
      largeIconBitmap?.recycle()
    } catch (_: Exception) {
    }
    largeIconBitmap = null
    largeIconSource = null
    stopForeground(STOP_FOREGROUND_REMOVE)
    super.onDestroy()
  }

  // ---------------------------------------------------------------------------
  // 媒体会话与播放状态
  // ---------------------------------------------------------------------------

  /** 建立 MediaSession：系统媒体按键/锁屏媒体控件/Android 13 媒体卡片都依赖它 */
  private fun setupMediaSession() {
    if (mediaSession != null) return
    try {
      val session = MediaSessionCompat(this, MEDIA_SESSION_TAG)
      session.setFlags(
        MediaSessionCompat.FLAG_HANDLES_MEDIA_BUTTONS or
          MediaSessionCompat.FLAG_HANDLES_TRANSPORT_CONTROLS
      )
      session.setCallback(object : MediaSessionCompat.Callback() {
        override fun onPlay() = dispatchAction(MEDIA_ACTION_PLAY)
        override fun onPause() = dispatchAction(MEDIA_ACTION_PAUSE)
        override fun onStop() = dispatchAction(MEDIA_ACTION_STOP)
        override fun onSeekTo(pos: Long) {
          // 先更新缓存并立即刷新 PlaybackState，避免进度条在重启会话前跳回旧位置
          lastPositionMs = pos.coerceAtLeast(0L)
          lastPositionUpdatedAt = SystemClock.elapsedRealtime()
          postPlaybackUpdate()
          dispatchAction(MEDIA_ACTION_SEEK, pos)
        }
      })
      session.setMetadata(buildMetadata(lastTitle, lastText))
      session.setPlaybackState(buildPlaybackState(lastPlaybackState))
      session.isActive = true
      mediaSession = session
      println("[TTS][Service] MediaSession ready state=$lastPlaybackState")
    } catch (e: Exception) {
      // 媒体会话不可用时退化为普通常驻通知，不影响前台保活与朗读
      println("[TTS][Service] MediaSession setup failed: ${e.javaClass.simpleName} ${e.message ?: ""}")
      mediaSession = null
    }
  }

  /** 把最新状态/文案应用到媒体会话与通知（主线程调用） */
  @SuppressLint("MissingPermission")
  private fun applyPlaybackState(title: String, text: String, state: String) {
    lastTitle = title
    lastText = text
    lastPlaybackState = state
    resolveLargeIcon(lastLargeIconPath)
    println("[TTS][Service] applyPlaybackState state=$state position=$lastPositionMs duration=$lastDurationMs title=$title text=$text")
    mediaSession?.let { session ->
      try {
        session.setMetadata(buildMetadata(title, text))
        session.setPlaybackState(buildPlaybackState(state))
        // 停止后让媒体会话失活，避免锁屏残留“可播放”的媒体卡片
        session.isActive = state != PLAYBACK_STOPPED
      } catch (e: Exception) {
        println("[TTS][Service] applyPlaybackState failed: ${e.javaClass.simpleName} ${e.message ?: ""}")
      }
    }
    updateAudioFocus(state)
    if (!foregroundPromoted) return
    try {
      // 已在前台时只能通过 notify 更新通知（startForeground 幂等但不会刷新内容）
      NotificationManagerCompat.from(this)
        .notify(NOTIFICATION_ID, buildNotification(title, text, state))
    } catch (e: Exception) {
      println("[TTS][Service] update notification failed: ${e.javaClass.simpleName} ${e.message ?: ""}")
    }
  }

  /** 服务实例侧的状态刷新入口（静态缓存 → 主线程渲染） */
  private fun postPlaybackUpdate() {
    mainHandler.post { applyPlaybackState(lastTitle, lastText, lastPlaybackState) }
  }

  /**
   * 解码媒体通知大图标（封面）。
   *
   * - 支持本地文件路径与 `data:` base64（get_cover_url 的两种返回形式）；
   * - 以源路径为 key 缓存，避免每次句子更新都重复解码；
   * - 解码失败静默降级（通知不带大图标）。
   */
  private fun resolveLargeIcon(path: String?) {
    if (path == largeIconSource) return
    largeIconSource = path
    // 旧位图已由系统复制到通知进程，可安全回收
    try {
      largeIconBitmap?.recycle()
    } catch (_: Exception) {
    }
    largeIconBitmap = null
    if (path.isNullOrBlank()) return
    try {
      val rawPath = if (path.startsWith("file://")) path.removePrefix("file://") else path
      val decoded = when {
        rawPath.startsWith("data:") -> {
          val base64 = rawPath.substringAfter("base64,", "")
          decodeBase64(base64)
        }
        // 先按文件路径处理（封面缓存目录），失败后再尝试裸 base64（兼容历史数据）
        java.io.File(rawPath).isFile -> BitmapFactory.decodeFile(rawPath)
        else -> decodeBase64(rawPath)
      } ?: return
      largeIconBitmap = scaleLargeIcon(decoded)
      println("[TTS][Service] large icon loaded path=${rawPath.take(64)}")
    } catch (e: Exception) {
      println("[TTS][Service] large icon decode failed: ${e.javaClass.simpleName} ${e.message ?: ""}")
    }
  }

  /** base64 解码为位图（空串/非法数据返回 null） */
  private fun decodeBase64(base64: String): Bitmap? {
    if (base64.isBlank()) return null
    return try {
      val bytes = Base64.decode(base64, Base64.DEFAULT)
      if (bytes.isEmpty()) null else BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
    } catch (_: Exception) {
      null
    }
  }

  /** 限制大图标尺寸，避免把超大封面直接交给 SystemUI 造成内存压力 */
  private fun scaleLargeIcon(source: Bitmap): Bitmap {
    val maxSide = maxOf(source.width, source.height)
    if (maxSide <= 512) return source
    val ratio = 512f / maxSide
    val scaled = Bitmap.createScaledBitmap(
      source,
      (source.width * ratio).toInt().coerceAtLeast(1),
      (source.height * ratio).toInt().coerceAtLeast(1),
      true
    )
    if (scaled !== source) source.recycle()
    return scaled
  }

  private fun buildMetadata(title: String, text: String): MediaMetadataCompat =
    MediaMetadataCompat.Builder()
      .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
      .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, text)
      .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_TITLE, title)
      .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_SUBTITLE, text)
      // 系统媒体卡片的“总时长”来自这里（章节级估算）
      .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, lastDurationMs)
      .build()

  /** 播放状态与可用动作：进度条可拖动（ACTION_SEEK_TO），按钮仍为播放/暂停/停止 */
  private fun buildPlaybackState(state: String): PlaybackStateCompat {
    val actions = PlaybackStateCompat.ACTION_PLAY or
      PlaybackStateCompat.ACTION_PAUSE or
      PlaybackStateCompat.ACTION_PLAY_PAUSE or
      PlaybackStateCompat.ACTION_STOP or
      PlaybackStateCompat.ACTION_SEEK_TO
    val playbackState = when (state) {
      PLAYBACK_PAUSED -> PlaybackStateCompat.STATE_PAUSED
      PLAYBACK_STOPPED -> PlaybackStateCompat.STATE_STOPPED
      else -> PlaybackStateCompat.STATE_PLAYING
    }
    val now = SystemClock.elapsedRealtime()
    val basePosition = if (playbackState == PlaybackStateCompat.STATE_STOPPED) 0L else lastPositionMs
    // 通知重建（如仅文案更新）时按真实时间插值，避免进度条回跳
    val position = if (playbackState == PlaybackStateCompat.STATE_PLAYING) {
      val elapsed = if (lastPositionUpdatedAt > 0L) {
        (now - lastPositionUpdatedAt).coerceAtLeast(0L)
      } else {
        0L
      }
      val upper = if (lastDurationMs > 0L) lastDurationMs else Long.MAX_VALUE
      (basePosition + elapsed).coerceAtMost(upper)
    } else {
      basePosition
    }
    val speed = if (playbackState == PlaybackStateCompat.STATE_PLAYING) 1f else 0f
    return PlaybackStateCompat.Builder()
      .setActions(actions)
      // 位置按“真实播放时间”推进（章节时长已按语速折算），因此 speed 固定 1x
      .setState(playbackState, position, speed)
      .build()
  }

  /** 把媒体动作转发给前端（主线程，且未注册接收者时仅记录日志） */
  private fun dispatchAction(action: String, positionMs: Long? = null) {
    val dispatcher = actionDispatcher
    println("[TTS][Service] dispatch media action=$action positionMs=${positionMs ?: ""} hasDispatcher=${dispatcher != null}")
    if (dispatcher == null) return
    mainHandler.post { dispatcher.invoke(action, positionMs) }
  }

  // ---------------------------------------------------------------------------
  // 音频焦点
  // ---------------------------------------------------------------------------

  /** 播放时持有音频焦点，暂停/停止时释放；失去焦点通知前端暂停 */
  private fun updateAudioFocus(state: String) {
    val audioManager = getSystemService(AudioManager::class.java) ?: return
    if (state == PLAYBACK_PLAYING) {
      requestAudioFocus(audioManager)
    } else {
      abandonAudioFocus(audioManager)
    }
  }

  private fun requestAudioFocus(audioManager: AudioManager) {
    if (audioFocusHeld) return
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val attributes = AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_MEDIA)
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
          .build()
        val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
          .setAudioAttributes(attributes)
          .setOnAudioFocusChangeListener(audioFocusListener, mainHandler)
          .setWillPauseWhenDucked(true)
          .build()
        audioFocusRequest = request
        audioFocusHeld = audioManager.requestAudioFocus(request) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
      } else {
        @Suppress("DEPRECATION")
        audioFocusHeld = audioManager.requestAudioFocus(
          audioFocusListener,
          AudioManager.STREAM_MUSIC,
          AudioManager.AUDIOFOCUS_GAIN
        ) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
      }
      println("[TTS][Service] audioFocus request held=$audioFocusHeld")
    } catch (e: Exception) {
      audioFocusHeld = false
      println("[TTS][Service] audioFocus request failed: ${e.javaClass.simpleName} ${e.message ?: ""}")
    }
  }

  private fun abandonAudioFocus(audioManager: AudioManager? = null) {
    if (!audioFocusHeld) return
    try {
      val manager = audioManager ?: getSystemService(AudioManager::class.java)
      if (manager != null) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          (audioFocusRequest as? AudioFocusRequest)?.let { manager.abandonAudioFocusRequest(it) }
        } else {
          @Suppress("DEPRECATION")
          manager.abandonAudioFocus(audioFocusListener)
        }
      }
    } catch (_: Exception) {
    } finally {
      audioFocusHeld = false
      audioFocusRequest = null
      println("[TTS][Service] audioFocus abandoned")
    }
  }

  // ---------------------------------------------------------------------------
  // 通知
  // ---------------------------------------------------------------------------

  private fun promoteToForeground(title: String, text: String) {
    try {
      startForeground(NOTIFICATION_ID, buildNotification(title, text, lastPlaybackState))
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
    val manager = getSystemService(NotificationManager::class.java)
    val channel = NotificationChannel(
      CHANNEL_ID,
      getString(R.string.tts_notification_channel_name),
      NotificationManager.IMPORTANCE_LOW
    ).apply {
      description = getString(R.string.tts_notification_channel_description)
      setShowBadge(false)
      // 媒体通知不应该发声/震动：列表不断更新，默认提示音会频繁打扰
      setSound(null, null)
      enableVibration(false)
      // 锁屏可见：媒体通知需要在锁屏上显示当前朗读内容与控件
      lockscreenVisibility = Notification.VISIBILITY_PUBLIC
    }
    manager?.createNotificationChannel(channel)
    // 旧渠道属性（IMPORTANCE_DEFAULT、可能有提示音）无法修改，直接删除避免残留
    try {
      manager?.deleteNotificationChannel(LEGACY_CHANNEL_ID)
    } catch (_: Exception) {
    }
    println("[TTS][Service] createNotificationChannel channelId=$CHANNEL_ID importance=${channel.importance} legacyDeleted=true")
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

  /**
   * 构建媒体通知。
   *
   * 按钮顺序固定为「播放/暂停 + 停止」，且与 MediaStyle 紧凑视图索引一致；
   * Android 13+ 的按钮由 PlaybackState 的 actions 推导，两套入口最终都走 dispatchAction。
   */
  private fun buildNotification(title: String, text: String, state: String): Notification {
    val openIntent = packageManager.getLaunchIntentForPackage(packageName)
    val contentIntent = openIntent?.let {
      PendingIntent.getActivity(
        this,
        0,
        it,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )
    }
    val builder = NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle(title)
      .setContentText(text)
      .setSmallIcon(R.drawable.ic_tts_notification)
      .setColor(NOTIFICATION_COLOR)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setContentIntent(contentIntent)

    largeIconBitmap?.let { builder.setLargeIcon(it) }

    var actionIndex = 0
    fun addAction(icon: Int, titleRes: Int, intentAction: String): Int {
      builder.addAction(icon, getString(titleRes), buildActionPendingIntent(intentAction))
      return actionIndex++
    }

    val compactIndices = mutableListOf<Int>()
    if (state == PLAYBACK_PLAYING) {
      compactIndices.add(
        addAction(
          android.R.drawable.ic_media_pause,
          R.string.tts_action_pause,
          ACTION_PAUSE
        )
      )
    } else {
      compactIndices.add(
        addAction(
          android.R.drawable.ic_media_play,
          R.string.tts_action_play,
          ACTION_PLAY
        )
      )
    }
    compactIndices.add(
      addAction(
        android.R.drawable.ic_menu_close_clear_cancel,
        R.string.tts_action_stop,
        ACTION_STOP
      )
    )

    mediaSession?.let { session ->
      val style = MediaStyle()
        .setMediaSession(session.sessionToken)
        .setShowActionsInCompactView(*compactIndices.toIntArray())
      builder.setStyle(style)
    }

    return builder.build()
  }

  /** 通知按钮 → Service 的 PendingIntent（FLAG_IMMUTABLE 为 targetSdk 31+ 必需） */
  private fun buildActionPendingIntent(action: String): PendingIntent {
    val intent = Intent(this, MediaPlaybackService::class.java).apply {
      this.action = action
    }
    return PendingIntent.getService(
      this,
      action.hashCode(),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
  }
}

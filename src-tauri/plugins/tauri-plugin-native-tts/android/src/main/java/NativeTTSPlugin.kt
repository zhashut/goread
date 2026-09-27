package com.tauri_app.native_tts

import android.app.Activity
import android.content.Intent
import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

@InvokeArg
class InitArgs {
  var lang: String? = null
}

@InvokeArg
class SetRateArgs {
  var rate: Float? = 1.0f
}

@InvokeArg
class SetVoiceArgs {
  var voice: String? = ""
}

@InvokeArg
class SetMediaSessionActiveArgs {
  var active: Boolean? = null
  var keepAppInForeground: Boolean? = null
  var notificationTitle: String? = null
  var notificationText: String? = null
  var foregroundServiceTitle: String? = null
  var foregroundServiceText: String? = null
}

@InvokeArg
class TTSSessionAnchorArgs {
  var quote: String? = null
  var prefix: String? = null
  var suffix: String? = null
}

@InvokeArg
class TTSSessionSegmentArgs {
  var id: String? = null
  var text: String? = null
  var lang: String? = null
  var sectionIndex: Int? = null
  var chunkIndex: Int? = null
  var cursor: String? = null
  var anchor: TTSSessionAnchorArgs? = null
}

@InvokeArg
class TTSSessionStartArgs {
  var segments: Array<TTSSessionSegmentArgs>? = null
  var lang: String? = null
  var rate: Float? = 1.0f
  var voiceId: String? = null
  var endOfBook: Boolean? = null
}

@InvokeArg
class TTSSessionPushArgs {
  var segments: Array<TTSSessionSegmentArgs>? = null
}

@InvokeArg
class TTSSessionSetEndOfBookArgs {
  var endOfBook: Boolean? = null
}

@InvokeArg
class TTSSessionStopArgs {
  var emitStoppedEvent: Boolean? = true
}

@TauriPlugin
class NativeTTSPlugin(private val activity: Activity) : Plugin(activity) {
  companion object {
    private const val CHANNEL_NAME = "tts_events"
  }

  private val isInitialized = AtomicBoolean(false)
  private val currentRate = AtomicReference(1.0f)
  private val currentVoiceId = AtomicReference("")
  private var textToSpeech: TextToSpeech? = null

  /**
   * TTS 实例代次：每次创建/销毁 textToSpeech 时递增。
   * 语音列表等与引擎实例强绑定的缓存以代次为 key，实例重建后自动失效。
   */
  private val ttsGeneration = AtomicInteger(0)

  /** 已实际应用到 TTS 引擎的音频配置标识（voice:xxx / lang:xxx），null 表示尚未应用 */
  @Volatile
  private var appliedVoiceKey: String? = null

  /** 当前会话语言（session_start 下发），句段自身不带 lang 时用它兜底应用语言 */
  @Volatile
  private var sessionLang: String? = null

  /** 语音原始对象缓存（代次一致时复用），避免每句都调用 tts.voices 枚举 */
  @Volatile
  private var cachedVoiceGeneration = -1

  @Volatile
  private var cachedVoiceObjects: List<android.speech.tts.Voice>? = null

  @Volatile
  private var cachedVoiceResults: List<VoiceResult>? = null
  private val defaultEngineObserverRegistered = AtomicBoolean(false)
  private val lastKnownDefaultEngine = AtomicReference<String?>(null)
  private val sessionRunner = TTSEngineRunner(
    getTextToSpeech = { textToSpeech },
    getRate = { currentRate.get() },
    setRate = { rate -> currentRate.set(rate) },
    getVoiceId = { currentVoiceId.get() },
    setVoiceId = { voiceId -> currentVoiceId.set(voiceId) },
    applyVoiceAndLang = { lang -> applyVoiceAndLang(lang) },
    keepServiceActive = { keepBackgroundServiceActive() },
    stopService = { stopBackgroundService() },
    emitEvent = { data -> trigger(CHANNEL_NAME, data) },
  )

  private val defaultEngineObserver = object : ContentObserver(Handler(Looper.getMainLooper())) {
    override fun onChange(selfChange: Boolean) {
      val next = resolveDefaultEngine()
      val prev = lastKnownDefaultEngine.get()
      if (next == prev) return
      lastKnownDefaultEngine.set(next)

      if (textToSpeech != null) {
        try {
          println("[TTS][Plugin] defaultEngine changed: $prev -> $next，重置 TTS 实例")
          sessionRunner.stop()
          isInitialized.set(false)
          currentVoiceId.set("")
          resetTtsInstance()
        } catch (_: Exception) {
        }
      } else {
        println("[TTS][Plugin] defaultEngine changed: $prev -> $next")
      }

      val data = JSObject().apply {
        put("code", "engine_changed")
        prev?.let { put("prevEngine", it) }
        next?.let { put("engine", it) }
      }
      trigger(CHANNEL_NAME, data)
    }
  }

  init {
    ensureDefaultEngineObserver()
  }

  private fun ensureDefaultEngineObserver() {
    if (defaultEngineObserverRegistered.get()) return
    try {
      lastKnownDefaultEngine.set(resolveDefaultEngine())
      activity.contentResolver.registerContentObserver(
        Settings.Secure.getUriFor(Settings.Secure.TTS_DEFAULT_SYNTH),
        false,
        defaultEngineObserver
      )
      defaultEngineObserverRegistered.set(true)
      println("[TTS][Plugin] defaultEngine observer registered: ${lastKnownDefaultEngine.get() ?: ""}")
    } catch (e: Exception) {
      println("[TTS][Plugin] defaultEngine observer register failed: ${e.message ?: ""}")
    }
  }

  private fun toLocale(lang: String?): Locale? {
    val v = lang?.trim()
    if (v.isNullOrEmpty()) return null
    return Locale.forLanguageTag(v)
  }

  private fun resolveDefaultEngine(): String? {
    return Settings.Secure.getString(
      activity.contentResolver,
      Settings.Secure.TTS_DEFAULT_SYNTH
    )
  }

  private fun setBackgroundPlaybackActive(args: SetMediaSessionActiveArgs) {
    val title = args.foregroundServiceTitle ?: args.notificationTitle ?: MediaPlaybackService.DEFAULT_TITLE
    val text = args.foregroundServiceText ?: args.notificationText ?: MediaPlaybackService.DEFAULT_TEXT

    if (args.active == true && args.keepAppInForeground == true) {
      println("[TTS][Plugin] background playback enable request channelId=${MediaPlaybackService.CHANNEL_ID} title=$title text=$text")
      // 启动/停止统一走 Service 的状态机，避免「启动后立刻停止」导致前台服务超时崩溃
      val started = MediaPlaybackService.requestStart(activity, title, text)
      println("[TTS][Plugin] background playback enabled=$started")
      return
    }

    println("[TTS][Plugin] background playback disable request channelId=${MediaPlaybackService.CHANNEL_ID}")
    MediaPlaybackService.requestStop(activity)
    println("[TTS][Plugin] background playback disabled")
  }

  private fun keepBackgroundServiceActive() {
    val args = SetMediaSessionActiveArgs().apply {
      active = true
      keepAppInForeground = true
      foregroundServiceTitle = MediaPlaybackService.DEFAULT_TITLE
      foregroundServiceText = MediaPlaybackService.DEFAULT_TEXT
    }
    setBackgroundPlaybackActive(args)
  }

  private fun stopBackgroundService() {
    MediaPlaybackService.requestStop(activity)
  }

  private fun ensureInitialized(requestedLang: String?, onDone: (InitResult) -> Unit) {
    if (isInitialized.get() && textToSpeech != null) {
      val result = buildInitResult(success = true, status = "success", requestedLang = requestedLang)
      println("[TTS][Plugin] ensureInitialized: 已初始化 requestedLang=${requestedLang ?: ""} defaultEngine=${result.defaultEngine ?: ""} voices=${result.voices?.size ?: 0}")
      onDone(result)
      return
    }

    val engine = resolveDefaultEngine()
    println("[TTS][Plugin] ensureInitialized: 开始初始化 requestedLang=${requestedLang ?: ""} defaultEngine=${engine ?: ""}")
    try {
      invalidateVoiceCache()
      textToSpeech = TextToSpeech(activity, { status ->
        if (status == TextToSpeech.SUCCESS) {
          isInitialized.set(true)
          setupListener()
          val result = buildInitResult(success = true, status = "success", requestedLang = requestedLang)
          println("[TTS][Plugin] ensureInitialized: 初始化成功 requestedLang=${requestedLang ?: ""} defaultEngine=${result.defaultEngine ?: ""} status=${result.status} voices=${result.voices?.size ?: 0}")
          onDone(result)
        } else {
          isInitialized.set(false)
          val result = buildInitResult(success = false, status = "init_error", requestedLang = requestedLang)
          println("[TTS][Plugin] ensureInitialized: 初始化失败 requestedLang=${requestedLang ?: ""} defaultEngine=${result.defaultEngine ?: ""} status=${result.status}")
          onDone(result)
        }
      }, engine)
    } catch (_: Exception) {
      isInitialized.set(false)
      val result = buildInitResult(success = false, status = "init_error", requestedLang = requestedLang)
      println("[TTS][Plugin] ensureInitialized: 初始化异常 requestedLang=${requestedLang ?: ""} defaultEngine=${result.defaultEngine ?: ""} status=${result.status}")
      onDone(result)
    }
  }

  private fun buildInitResult(
    success: Boolean,
    status: String,
    requestedLang: String?,
  ): InitResult {
    val engine = resolveDefaultEngine()
    val langCheck = checkLang(requestedLang)
    val voices = readVoices()
    val finalStatus = if (!success) status else when (langCheck?.result) {
      "missing_data" -> "missing_data"
      "not_supported" -> "lang_not_supported"
      else -> "success"
    }
    val out = InitResult(
      success = success,
      status = finalStatus,
      defaultEngine = engine,
      langCheck = langCheck,
      voices = voices,
    )
    println("[TTS][Plugin] buildInitResult: success=$success status=$finalStatus requestedLang=${requestedLang ?: ""} defaultEngine=${engine ?: ""} langCheck=${langCheck?.requested ?: ""}/${langCheck?.result ?: ""} voices=${voices?.size ?: 0} currentVoiceId=${currentVoiceId.get()}")
    return out
  }

  private data class LangCheckResult(
    val requested: String,
    val result: String,
  )

  private data class VoiceResult(
    val id: String,
    val name: String,
    val lang: String,
    val displayZh: String?,
    val displayEn: String?,
    val disabled: Boolean = false,
  )

  private data class InitResult(
    val success: Boolean,
    val status: String,
    val defaultEngine: String?,
    val langCheck: LangCheckResult?,
    val voices: List<VoiceResult>?,
  )

  private fun checkLang(requestedLang: String?): LangCheckResult? {
    val tts = textToSpeech ?: return null
    val locale = toLocale(requestedLang) ?: return null
    val r = tts.isLanguageAvailable(locale)
    val result = when (r) {
      TextToSpeech.LANG_MISSING_DATA -> "missing_data"
      TextToSpeech.LANG_NOT_SUPPORTED -> "not_supported"
      else -> "ok"
    }
    return LangCheckResult(locale.toLanguageTag(), result)
  }

  /** 销毁 TTS 实例并失效所有依赖实例的缓存 */
  private fun resetTtsInstance() {
    try {
      textToSpeech?.shutdown()
    } catch (_: Exception) {
    }
    textToSpeech = null
    invalidateVoiceCache()
  }

  /** 失效语音列表缓存与已应用的音频配置（引擎实例变化或用户切换语音时调用） */
  private fun invalidateVoiceCache() {
    ttsGeneration.incrementAndGet()
    cachedVoiceGeneration = -1
    cachedVoiceObjects = null
    cachedVoiceResults = null
    appliedVoiceKey = null
  }

  /**
   * 读取语音列表（带缓存）。
   * tts.voices 是同步的引擎调用，在长句合成期间可能阻塞主线程数百毫秒到数秒，
   * 因此同一个 TTS 实例只枚举一次，避免每条句段都触发。
   */
  private fun readVoices(): List<VoiceResult>? {
    val tts = textToSpeech ?: return null
    val generation = ttsGeneration.get()
    if (cachedVoiceGeneration == generation && cachedVoiceResults != null) {
      return cachedVoiceResults
    }
    return try {
      val voices = tts.voices ?: return emptyList()
      fun isNetworkVoice(v: android.speech.tts.Voice): Boolean {
        val requiresNetwork = try { v.isNetworkConnectionRequired } catch (_: Exception) { false }
        val hasNetworkFeature = try {
          v.features?.contains(TextToSpeech.Engine.KEY_FEATURE_NETWORK_SYNTHESIS) == true
        } catch (_: Exception) {
          false
        }
        val nameLower = try { v.name.lowercase(Locale.US) } catch (_: Exception) { "" }
        return requiresNetwork || hasNetworkFeature || nameLower.contains("network")
      }

      fun toResult(v: android.speech.tts.Voice): VoiceResult {
        val locale = v.locale
        return VoiceResult(
          id = v.name,
          name = v.name,
          lang = v.locale.toLanguageTag(),
          displayZh = try { locale.getDisplayName(Locale.SIMPLIFIED_CHINESE) } catch (_: Exception) { null },
          displayEn = try { locale.getDisplayName(Locale.ENGLISH) } catch (_: Exception) { null },
          disabled = false,
        )
      }

      // 优先本地语音；全部为网络语音时退回完整列表（与原行为一致）
      val localOnly = voices.filterNot { isNetworkVoice(it) }
      val picked: List<android.speech.tts.Voice> =
        if (localOnly.isNotEmpty()) localOnly.toList() else voices.toList()
      val results = picked.map { toResult(it) }
      cachedVoiceGeneration = generation
      cachedVoiceObjects = picked
      cachedVoiceResults = results
      results
    } catch (_: Exception) {
      null
    }
  }

  /** 按 voiceId 查语音对象，命中缓存时不再枚举引擎语音列表 */
  private fun findCachedVoice(tts: TextToSpeech, voiceId: String): android.speech.tts.Voice? {
    readVoices()
    return cachedVoiceObjects?.firstOrNull { it.name == voiceId }
      ?: try {
        tts.voices?.firstOrNull { it.name == voiceId }
      } catch (_: Exception) {
        null
      }
  }

  private fun setupListener() {
    textToSpeech?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
      override fun onStart(utteranceId: String?) {
        val id = utteranceId ?: return
        sessionRunner.onStart(id)
      }

      override fun onDone(utteranceId: String?) {
        val id = utteranceId ?: return
        sessionRunner.onDone(id)
      }

      @Deprecated("Deprecated in Java")
      override fun onError(utteranceId: String?) {
        val id = utteranceId ?: return
        sessionRunner.onError(id, "tts_error")
      }

      override fun onError(utteranceId: String?, errorCode: Int) {
        val id = utteranceId ?: return
        sessionRunner.onError(id, "tts_error_$errorCode")
      }
    })
  }

  /**
   * 应用语音/语言到 TTS 引擎。
   *
   * 该函数在每次朗读句段前被调用（运行在主线程），而 tts.voices / tts.language
   * 都是同步的引擎调用：长文合成期间可能阻塞主线程。
   * 因此这里以「期望配置标识」做幂等判断，配置未变化时直接返回，不再触碰引擎。
   */
  private fun applyVoiceAndLang(lang: String?) {
    val tts = textToSpeech ?: return
    val voiceId = currentVoiceId.get()
    val effectiveLang = normalizeLang(lang) ?: normalizeLang(sessionLang)
    val desiredKey = if (voiceId.isNotBlank()) "voice:$voiceId" else "lang:${effectiveLang ?: ""}"
    if (appliedVoiceKey == desiredKey) return

    try {
      if (voiceId.isNotBlank()) {
        val voice = findCachedVoice(tts, voiceId)
        if (voice != null) {
          tts.voice = voice
          appliedVoiceKey = desiredKey
          println("[TTS][Plugin] applyVoice: hit voiceId=$voiceId voiceLocale=${voice.locale?.toLanguageTag() ?: ""}")
        } else {
          // 未命中时保留旧配置，下次句段仍会重试
          println("[TTS][Plugin] applyVoice: miss voiceId=$voiceId")
        }
        return
      }

      // 未选择自定义语音：通过设置语言让引擎回到该语言的默认语音
      // （setLanguage 会重置当前 voice，这也是从自定义语音切回「默认」时恢复默认音色的手段）
      val locale = toLocale(effectiveLang)
      if (locale != null) {
        tts.language = locale
        appliedVoiceKey = desiredKey
        println("[TTS][Plugin] applyLang: lang=${effectiveLang ?: ""} locale=${locale.toLanguageTag()}")
      }
    } catch (_: Exception) {
    }
  }

  /** 归一化语言标签：空白视为未提供 */
  private fun normalizeLang(lang: String?): String? = lang?.trim()?.takeIf { it.isNotEmpty() }

  @Command
  fun init(invoke: Invoke) {
    val args = invoke.parseArgs(InitArgs::class.java)
    ensureInitialized(args.lang) { result ->
      val out = JSObject().apply {
        put("success", result.success)
        put("status", result.status)
        result.defaultEngine?.let { put("defaultEngine", it) }
        result.langCheck?.let { lc ->
          put("langCheck", JSObject().apply {
            put("requested", lc.requested)
            put("result", lc.result)
          })
        }
        result.voices?.let { vs ->
          val arr = org.json.JSONArray()
          for (v in vs) {
            val o = JSObject().apply {
              put("id", v.id)
              put("name", v.name)
              put("lang", v.lang)
              v.displayZh?.let { put("displayZh", it) }
              v.displayEn?.let { put("displayEn", it) }
              put("disabled", v.disabled)
            }
            arr.put(o)
          }
          put("voices", arr)
        }
      }
      invoke.resolve(out)
    }
  }

  @Command
  fun set_rate(invoke: Invoke) {
    val args = invoke.parseArgs(SetRateArgs::class.java)
    val rate = args.rate ?: 1.0f
    currentRate.set(rate)
    println("[TTS][Plugin] set_rate: $rate")
    invoke.resolve()
  }

  @Command
  fun set_voice(invoke: Invoke) {
    val args = invoke.parseArgs(SetVoiceArgs::class.java)
    val v = (args.voice ?: "").trim()
    if (v.isBlank() || v == "default") {
      currentVoiceId.set("")
      // 不再销毁 TTS 实例：销毁会让下次朗读触发完整的引擎重建 + 语音枚举（主线程重活），
      // 只需让已应用的配置失效，下一句会通过设置语言恢复引擎默认语音。
      appliedVoiceKey = null
      println("[TTS][Plugin] set_voice: 清空语音选择（保留 TTS 实例）defaultEngine=${resolveDefaultEngine() ?: ""}")
      invoke.resolve()
      return
    }

    currentVoiceId.set(v)
    appliedVoiceKey = null
    val tts = textToSpeech
    val hit = tts != null && findCachedVoice(tts, v) != null
    println("[TTS][Plugin] set_voice: voiceId=$v hit=$hit defaultEngine=${resolveDefaultEngine() ?: ""}")
    invoke.resolve()
  }

  @Command
  fun get_all_voices(invoke: Invoke) {
    val voices = readVoices() ?: emptyList()
    val arr = org.json.JSONArray()
    for (v in voices) {
      val o = JSObject().apply {
        put("id", v.id)
        put("name", v.name)
        put("lang", v.lang)
        v.displayZh?.let { put("displayZh", it) }
        v.displayEn?.let { put("displayEn", it) }
        put("disabled", v.disabled)
      }
      arr.put(o)
    }
    val out = JSObject().apply {
      put("voices", arr)
    }
    invoke.resolve(out)
  }

  @Command
  fun set_media_session_active(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(SetMediaSessionActiveArgs::class.java)
      setBackgroundPlaybackActive(args)
      invoke.resolve()
    } catch (e: Exception) {
      invoke.reject("Failed to set media session active: ${e.message}")
    }
  }

  @Command
  fun open_tts_settings(invoke: Invoke) {
    try {
      val intent = Intent("com.android.settings.TTS_SETTINGS").apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      activity.startActivity(intent)
      invoke.resolve()
    } catch (e: Exception) {
      invoke.reject("Failed to open TTS settings: ${e.message}")
    }
  }

  @Command
  fun install_tts_data(invoke: Invoke) {
    try {
      val intent = Intent(TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA).apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      activity.startActivity(intent)
      invoke.resolve()
    } catch (e: Exception) {
      invoke.reject("Failed to install TTS data: ${e.message}")
    }
  }

  @Command
  fun shutdown(invoke: Invoke) {
    try {
      println("[TTS][Plugin] shutdown")
      sessionRunner.stop()
      stopBackgroundService()
      isInitialized.set(false)
      sessionLang = null
      resetTtsInstance()
      invoke.resolve()
    } catch (e: Exception) {
      invoke.reject("Failed to shutdown: ${e.message}")
    }
  }

  @Command
  fun tts_session_start(invoke: Invoke) {
    val args = invoke.parseArgs(TTSSessionStartArgs::class.java)
    val segments = sessionRunner.toSegmentList(args.segments)
    if (segments.isEmpty()) {
      invoke.reject("Session segments cannot be empty")
      return
    }

    ensureInitialized(args.lang) { initResult ->
      if (!initResult.success) {
        invoke.reject("TTS init failed")
        return@ensureInitialized
      }

      try {
        // 记住会话语言：句段自身不带 lang，用它在「默认语音」时恢复引擎默认音色
        sessionLang = normalizeLang(args.lang)
        sessionRunner.start(
          segments = segments,
          rate = args.rate ?: 1.0f,
          voiceId = args.voiceId,
          endOfBookFlag = args.endOfBook ?: false,
        )
        invoke.resolve()
      } catch (e: Exception) {
        invoke.reject("Failed to start session: ${e.message}")
      }
    }
  }

  @Command
  fun tts_session_push(invoke: Invoke) {
    val args = invoke.parseArgs(TTSSessionPushArgs::class.java)
    val segments = sessionRunner.toSegmentList(args.segments)
    if (segments.isEmpty()) {
      invoke.resolve()
      return
    }
    try {
      sessionRunner.push(segments)
      invoke.resolve()
    } catch (e: Exception) {
      invoke.reject("Failed to push session segments: ${e.message}")
    }
  }

  @Command
  fun tts_session_stop(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(TTSSessionStopArgs::class.java)
      sessionRunner.stop(args.emitStoppedEvent ?: true)
      try {
        textToSpeech?.stop()
      } catch (_: Exception) {
      }
      invoke.resolve()
    } catch (e: Exception) {
      invoke.reject("Failed to stop session: ${e.message}")
    }
  }

  @Command
  fun tts_session_pause(invoke: Invoke) {
    try {
      sessionRunner.pause()
      invoke.resolve()
    } catch (e: Exception) {
      invoke.reject("Failed to pause session: ${e.message}")
    }
  }

  @Command
  fun tts_session_resume(invoke: Invoke) {
    try {
      sessionRunner.resume()
      invoke.resolve()
    } catch (e: Exception) {
      invoke.reject("Failed to resume session: ${e.message}")
    }
  }

  @Command
  fun tts_session_set_rate(invoke: Invoke) {
    val args = invoke.parseArgs(SetRateArgs::class.java)
    val rate = args.rate ?: 1.0f
    sessionRunner.setSessionRate(rate)
    invoke.resolve()
  }

  @Command
  fun tts_session_set_voice(invoke: Invoke) {
    val args = invoke.parseArgs(SetVoiceArgs::class.java)
    sessionRunner.setSessionVoice(args.voice)
    invoke.resolve()
  }

  @Command
  fun tts_session_set_end_of_book(invoke: Invoke) {
    val args = invoke.parseArgs(TTSSessionSetEndOfBookArgs::class.java)
    sessionRunner.setEndOfBook(args.endOfBook ?: false)
    invoke.resolve()
  }
}

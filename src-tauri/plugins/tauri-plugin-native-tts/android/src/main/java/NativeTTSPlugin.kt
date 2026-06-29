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
import androidx.core.content.ContextCompat
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean
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
          textToSpeech?.shutdown()
          textToSpeech = null
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
    val intent = Intent(activity, MediaPlaybackService::class.java).apply {
      putExtra(MediaPlaybackService.EXTRA_TITLE, title)
      putExtra(MediaPlaybackService.EXTRA_TEXT, text)
    }

    if (args.active == true && args.keepAppInForeground == true) {
      println("[TTS][Plugin] background playback enable request channelId=${MediaPlaybackService.CHANNEL_ID} title=$title text=$text")
      ContextCompat.startForegroundService(activity, intent)
      println("[TTS][Plugin] background playback enabled")
      return
    }

    println("[TTS][Plugin] background playback disable request channelId=${MediaPlaybackService.CHANNEL_ID}")
    activity.stopService(intent)
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
    activity.stopService(Intent(activity, MediaPlaybackService::class.java))
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

  private fun readVoices(): List<VoiceResult>? {
    val tts = textToSpeech ?: return null
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

      val localOnly = voices.filterNot { isNetworkVoice(it) }.map { toResult(it) }
      if (localOnly.isNotEmpty()) return localOnly
      voices.map { toResult(it) }
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

  private fun applyVoiceAndLang(lang: String?) {
    val tts = textToSpeech ?: return
    val voiceId = currentVoiceId.get()
    try {
      if (voiceId.isNotBlank()) {
        val voice = tts.voices?.firstOrNull { it.name == voiceId }
        if (voice != null) {
          tts.voice = voice
          println("[TTS][Plugin] applyVoice: hit voiceId=$voiceId voiceLocale=${voice.locale?.toLanguageTag() ?: ""}")
        } else {
          println("[TTS][Plugin] applyVoice: miss voiceId=$voiceId")
        }
      }
    } catch (_: Exception) {
    }
    if (voiceId.isNotBlank()) return
    try {
      val locale = toLocale(lang)
      if (locale != null) {
        tts.language = locale
        println("[TTS][Plugin] applyLang: lang=${lang ?: ""} locale=${locale.toLanguageTag()}")
      }
    } catch (_: Exception) {
    }
  }

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
      if (textToSpeech != null) {
        try {
          println("[TTS][Plugin] set_voice: 清空语音选择并重置 TTS 实例 defaultEngine=${resolveDefaultEngine() ?: ""}")
          isInitialized.set(false)
          textToSpeech?.shutdown()
          textToSpeech = null
        } catch (_: Exception) {
        }
      } else {
        println("[TTS][Plugin] set_voice: 清空语音选择 defaultEngine=${resolveDefaultEngine() ?: ""}")
      }
      invoke.resolve()
      return
    }

    currentVoiceId.set(v)
    val hit = try { textToSpeech?.voices?.any { it.name == v } ?: false } catch (_: Exception) { false }
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
      textToSpeech?.shutdown()
      textToSpeech = null
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

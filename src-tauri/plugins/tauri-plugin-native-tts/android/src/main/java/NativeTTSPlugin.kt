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
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

@InvokeArg
class InitArgs {
  var lang: String? = null
}

@InvokeArg
class SpeakArgs {
  var text: String? = ""
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

  private val defaultEngineObserver = object : ContentObserver(Handler(Looper.getMainLooper())) {
    override fun onChange(selfChange: Boolean) {
      val next = resolveDefaultEngine()
      val prev = lastKnownDefaultEngine.get()
      if (next == prev) return
      lastKnownDefaultEngine.set(next)

      if (textToSpeech != null) {
        try {
          println("[TTS][Plugin] defaultEngine changed: $prev -> $next，重置 TTS 实例")
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

  private fun ensureInitialized(requestedLang: String?, onDone: (InitResult) -> Unit) {
    if (isInitialized.get() && textToSpeech != null) {
      val result = buildInitResult(
        success = true,
        status = "success",
        requestedLang = requestedLang
      )
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
          val result = buildInitResult(
            success = true,
            status = "success",
            requestedLang = requestedLang
          )
          println("[TTS][Plugin] ensureInitialized: 初始化成功 requestedLang=${requestedLang ?: ""} defaultEngine=${result.defaultEngine ?: ""} status=${result.status} voices=${result.voices?.size ?: 0}")
          onDone(result)
        } else {
          isInitialized.set(false)
          val result = buildInitResult(
            success = false,
            status = "init_error",
            requestedLang = requestedLang
          )
          println("[TTS][Plugin] ensureInitialized: 初始化失败 requestedLang=${requestedLang ?: ""} defaultEngine=${result.defaultEngine ?: ""} status=${result.status}")
          onDone(result)
        }
      }, engine)
    } catch (_: Exception) {
      isInitialized.set(false)
      val result = buildInitResult(
        success = false,
        status = "init_error",
        requestedLang = requestedLang
      )
      println("[TTS][Plugin] ensureInitialized: 初始化异常 requestedLang=${requestedLang ?: ""} defaultEngine=${result.defaultEngine ?: ""} status=${result.status}")
      onDone(result)
    }
  }

  private fun buildInitResult(
    success: Boolean,
    status: String,
    requestedLang: String?
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
      voices = voices
    )
    println("[TTS][Plugin] buildInitResult: success=$success status=$finalStatus requestedLang=${requestedLang ?: ""} defaultEngine=${engine ?: ""} langCheck=${langCheck?.requested ?: ""}/${langCheck?.result ?: ""} voices=${voices?.size ?: 0} currentVoiceId=${currentVoiceId.get()}")
    return out
  }

  private data class LangCheckResult(
    val requested: String,
    val result: String
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
    val voices: List<VoiceResult>?
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
          disabled = false
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
        println("[TTS][Plugin] event: onStart utteranceId=$id")
        val data = JSObject().apply {
          put("utteranceId", id)
          put("code", "boundary")
          put("message", "start")
        }
        trigger(CHANNEL_NAME, data)
      }

      override fun onDone(utteranceId: String?) {
        val id = utteranceId ?: return
        println("[TTS][Plugin] event: onDone utteranceId=$id")
        val data = JSObject().apply {
          put("utteranceId", id)
          put("code", "end")
        }
        trigger(CHANNEL_NAME, data)
      }

      @Deprecated("Deprecated in Java")
      override fun onError(utteranceId: String?) {
        val id = utteranceId ?: return
        println("[TTS][Plugin] event: onError utteranceId=$id error=tts_error")
        val data = JSObject().apply {
          put("utteranceId", id)
          put("code", "error")
          put("message", "tts_error")
        }
        trigger(CHANNEL_NAME, data)
      }

      override fun onError(utteranceId: String?, errorCode: Int) {
        val id = utteranceId ?: return
        println("[TTS][Plugin] event: onError utteranceId=$id error=tts_error_$errorCode")
        val data = JSObject().apply {
          put("utteranceId", id)
          put("code", "error")
          put("message", "tts_error_$errorCode")
        }
        trigger(CHANNEL_NAME, data)
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
  fun speak(invoke: Invoke) {
    val args = invoke.parseArgs(SpeakArgs::class.java)
    val text = args.text ?: ""
    if (text.isBlank()) {
      invoke.reject("Text cannot be empty")
      return
    }

    ensureInitialized(args.lang) { initResult ->
      if (!initResult.success) {
        invoke.reject("TTS init failed")
        return@ensureInitialized
      }

      val utteranceId = UUID.randomUUID().toString()
      val tts = textToSpeech
      if (tts == null) {
        invoke.reject("TTS not ready")
        return@ensureInitialized
      }

      try {
        println("[TTS][Plugin] speak: utteranceId=$utteranceId defaultEngine=${initResult.defaultEngine ?: ""} lang=${args.lang ?: ""} rate=${currentRate.get()} voiceId=${currentVoiceId.get()} textLen=${text.length}")
        applyVoiceAndLang(args.lang)
        tts.setSpeechRate(currentRate.get())
        val params = android.os.Bundle().apply {
          putString(TextToSpeech.Engine.KEY_PARAM_UTTERANCE_ID, utteranceId)
        }
        val r = tts.speak(text, TextToSpeech.QUEUE_FLUSH, params, utteranceId)
        if (r != TextToSpeech.SUCCESS) {
          println("[TTS][Plugin] speak: 调用失败 utteranceId=$utteranceId result=$r")
          val data = JSObject().apply {
            put("utteranceId", utteranceId)
            put("code", "error")
            put("message", "speak_failed")
          }
          trigger(CHANNEL_NAME, data)
        }
        val finalVoice = try { tts.voice?.name ?: "" } catch (_: Exception) { "" }
        val finalLocale = try { tts.voice?.locale?.toLanguageTag() ?: "" } catch (_: Exception) { "" }
        println("[TTS][Plugin] speak: 已下发 utteranceId=$utteranceId finalVoice=$finalVoice finalLocale=$finalLocale")
        val out = JSObject().apply {
          put("utteranceId", utteranceId)
        }
        invoke.resolve(out)
      } catch (e: Exception) {
        println("[TTS][Plugin] speak: 异常 utteranceId=$utteranceId error=${e.message ?: ""}")
        invoke.reject("Failed to speak: ${e.message}")
      }
    }
  }

  @Command
  fun stop(invoke: Invoke) {
    try {
      println("[TTS][Plugin] stop")
      textToSpeech?.stop()
      invoke.resolve()
    } catch (e: Exception) {
      invoke.reject("Failed to stop: ${e.message}")
    }
  }

  @Command
  fun pause(invoke: Invoke) {
    try {
      println("[TTS][Plugin] pause")
      textToSpeech?.stop()
      invoke.resolve()
    } catch (e: Exception) {
      invoke.reject("Failed to pause: ${e.message}")
    }
  }

  @Command
  fun resume(invoke: Invoke) {
    invoke.resolve()
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
      isInitialized.set(false)
      textToSpeech?.shutdown()
      textToSpeech = null
      invoke.resolve()
    } catch (e: Exception) {
      invoke.reject("Failed to shutdown: ${e.message}")
    }
  }
}


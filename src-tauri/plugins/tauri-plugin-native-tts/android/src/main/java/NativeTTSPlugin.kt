package com.tauri_app.native_tts

import android.app.Activity
import android.content.Intent
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
      onDone(result)
      return
    }

    val engine = resolveDefaultEngine()
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
          onDone(result)
        } else {
          isInitialized.set(false)
          val result = buildInitResult(
            success = false,
            status = "init_error",
            requestedLang = requestedLang
          )
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
    return InitResult(
      success = success,
      status = finalStatus,
      defaultEngine = engine,
      langCheck = langCheck,
      voices = voices
    )
  }

  private data class LangCheckResult(
    val requested: String,
    val result: String
  )

  private data class VoiceResult(
    val id: String,
    val name: String,
    val lang: String,
    val disabled: Boolean = false
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
      voices.map { v ->
        VoiceResult(
          id = v.name,
          name = v.name,
          lang = v.locale.toLanguageTag(),
          disabled = false
        )
      }
    } catch (_: Exception) {
      null
    }
  }

  private fun setupListener() {
    textToSpeech?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
      override fun onStart(utteranceId: String?) {
        val id = utteranceId ?: return
        val data = JSObject().apply {
          put("utteranceId", id)
          put("code", "boundary")
          put("message", "start")
        }
        trigger(CHANNEL_NAME, data)
      }

      override fun onDone(utteranceId: String?) {
        val id = utteranceId ?: return
        val data = JSObject().apply {
          put("utteranceId", id)
          put("code", "end")
        }
        trigger(CHANNEL_NAME, data)
      }

      @Deprecated("Deprecated in Java")
      override fun onError(utteranceId: String?) {
        val id = utteranceId ?: return
        val data = JSObject().apply {
          put("utteranceId", id)
          put("code", "error")
          put("message", "tts_error")
        }
        trigger(CHANNEL_NAME, data)
      }

      override fun onError(utteranceId: String?, errorCode: Int) {
        val id = utteranceId ?: return
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
        }
      }
    } catch (_: Exception) {
    }
    try {
      val locale = toLocale(lang)
      if (locale != null) {
        tts.language = locale
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
        applyVoiceAndLang(args.lang)
        tts.setSpeechRate(currentRate.get())
        val params = android.os.Bundle().apply {
          putString(TextToSpeech.Engine.KEY_PARAM_UTTERANCE_ID, utteranceId)
        }
        val r = tts.speak(text, TextToSpeech.QUEUE_FLUSH, params, utteranceId)
        if (r != TextToSpeech.SUCCESS) {
          val data = JSObject().apply {
            put("utteranceId", utteranceId)
            put("code", "error")
            put("message", "speak_failed")
          }
          trigger(CHANNEL_NAME, data)
        }
        val out = JSObject().apply {
          put("utteranceId", utteranceId)
        }
        invoke.resolve(out)
      } catch (e: Exception) {
        invoke.reject("Failed to speak: ${e.message}")
      }
    }
  }

  @Command
  fun stop(invoke: Invoke) {
    try {
      textToSpeech?.stop()
      invoke.resolve()
    } catch (e: Exception) {
      invoke.reject("Failed to stop: ${e.message}")
    }
  }

  @Command
  fun pause(invoke: Invoke) {
    try {
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
    invoke.resolve()
  }

  @Command
  fun set_voice(invoke: Invoke) {
    val args = invoke.parseArgs(SetVoiceArgs::class.java)
    val v = args.voice ?: ""
    currentVoiceId.set(v)
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
      isInitialized.set(false)
      textToSpeech?.shutdown()
      textToSpeech = null
      invoke.resolve()
    } catch (e: Exception) {
      invoke.reject("Failed to shutdown: ${e.message}")
    }
  }
}


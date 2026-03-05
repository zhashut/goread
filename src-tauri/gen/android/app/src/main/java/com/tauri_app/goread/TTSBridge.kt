package com.tauri_app.goread

import android.content.Context
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale

/**
 * Android 原生 TTS 桥接
 * 通过 JavascriptInterface 暴露给前端 JS 调用，
 * 当 Web Speech API 不可用时作为兜底引擎
 */
class TTSBridge(
    private val context: Context,
    private val webViewProvider: () -> WebView?
) {
    private var tts: TextToSpeech? = null
    private var isReady = false
    private var currentRate = 1.0f
    private val mainHandler = Handler(Looper.getMainLooper())

    // 初始化 TTS 引擎（JavascriptInterface 方法在后台线程调用，需要切到主线程创建 TTS）
    @JavascriptInterface
    fun init() {
        mainHandler.post {
            tts = TextToSpeech(context) { status ->
                isReady = status == TextToSpeech.SUCCESS
                if (isReady) {
                    tts?.language = Locale.CHINESE
                    tts?.setOnUtteranceProgressListener(createProgressListener())
                }
                val voices = if (isReady) getVoicesJson() else "[]"
                // 用 JSON.parse 包裹语音列表，避免特殊字符导致 JS 语法错误
                val escapedVoices = voices.replace("\\", "\\\\").replace("'", "\\'")
                notifyJS("window.__onTTSInit__($isReady, JSON.parse('$escapedVoices'))")
            }
        }
    }

    // 朗读文本
    @JavascriptInterface
    fun speak(text: String, lang: String, rate: Float, utteranceId: String) {
        mainHandler.post {
            if (!isReady || tts == null) {
                val id = escapeForJS(utteranceId)
                notifyJS("window.__onTTSEvent__('error', '$id', 'TTS not ready')")
                return@post
            }

            val locale = when {
                lang.startsWith("zh") -> Locale.CHINESE
                lang.startsWith("en") -> Locale.ENGLISH
                else -> Locale.CHINESE
            }
            tts?.language = locale
            currentRate = rate
            tts?.setSpeechRate(rate)

            val params = Bundle()
            tts?.speak(text, TextToSpeech.QUEUE_FLUSH, params, utteranceId)
        }
    }

    // 停止朗读
    @JavascriptInterface
    fun stop() {
        mainHandler.post {
            tts?.stop()
        }
    }

    // 暂停（Android TTS 不原生支持 pause，直接 stop 由前端控制恢复）
    @JavascriptInterface
    fun pause(): Boolean {
        mainHandler.post {
            tts?.stop()
        }
        return true
    }

    // 引擎是否可用
    @JavascriptInterface
    fun isAvailable(): Boolean {
        return isReady
    }

    // 获取可用语音列表（JSON 字符串）
    @JavascriptInterface
    fun getVoices(): String {
        return getVoicesJson()
    }

    // 设置语速
    @JavascriptInterface
    fun setRate(rate: Float) {
        currentRate = rate
        mainHandler.post {
            tts?.setSpeechRate(rate)
        }
    }

    // 释放资源
    @JavascriptInterface
    fun shutdown() {
        mainHandler.post {
            tts?.stop()
            tts?.shutdown()
            tts = null
            isReady = false
        }
    }

    // --- 内部方法 ---

    /** 转义字符串使其可安全嵌入 JS 单引号字符串 */
    private fun escapeForJS(s: String): String =
        s.replace("\\", "\\\\").replace("'", "\\'").replace("\n", "\\n").replace("\r", "")

    private fun createProgressListener() = object : UtteranceProgressListener() {
        override fun onStart(utteranceId: String) {
            val id = escapeForJS(utteranceId)
            notifyJS("window.__onTTSEvent__('boundary', '$id', '')")
        }

        override fun onDone(utteranceId: String) {
            val id = escapeForJS(utteranceId)
            notifyJS("window.__onTTSEvent__('end', '$id', '')")
        }

        @Deprecated("Deprecated in Java")
        override fun onError(utteranceId: String) {
            val id = escapeForJS(utteranceId)
            notifyJS("window.__onTTSEvent__('error', '$id', 'TTS error')")
        }

        override fun onError(utteranceId: String, errorCode: Int) {
            val id = escapeForJS(utteranceId)
            notifyJS("window.__onTTSEvent__('error', '$id', 'TTS error code: $errorCode')")
        }
    }

    private fun getVoicesJson(): String {
        if (!isReady || tts == null) return "[]"
        val arr = JSONArray()
        try {
            val voices = tts?.voices ?: return "[]"
            for (voice in voices) {
                val lang = voice.locale.language
                // 仅保留中文和英文
                if (lang != "zh" && lang != "en") continue
                val obj = JSONObject()
                obj.put("id", voice.name)
                obj.put("name", voice.name)
                obj.put("lang", voice.locale.toLanguageTag())
                arr.put(obj)
            }
        } catch (_: Exception) {}
        return arr.toString()
    }

    private fun notifyJS(js: String) {
        val webView = webViewProvider()
        webView?.post {
            webView.evaluateJavascript(
                "(function(){ try { $js } catch(e) { console.error('[TTSBridge]', e); } })();",
                null
            )
        }
    }
}

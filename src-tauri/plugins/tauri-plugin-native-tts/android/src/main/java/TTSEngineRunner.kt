package com.tauri_app.native_tts

import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import app.tauri.plugin.JSObject
import java.util.ArrayDeque
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

/** 优先补给阈值：队列预估剩余期间 ≤ 该值时触发 requestMore */
private const val SESSION_LOW_WATERMARK_SECONDS = 6.0
/** WaitingForMore 超时，给前端和后端补给链路预留足够时间 */
private const val SESSION_WAITING_TIMEOUT_MS = 60_000L
/** 中文语音在 rate=1.0 时的参考语速（8字/秒左右，取保守值） */
private const val CHARS_PER_SECOND_AT_RATE_ONE = 5.5

internal data class TTSSessionAnchor(
  val quote: String,
  val prefix: String?,
  val suffix: String?,
)

internal data class TTSSessionSegment(
  val id: String,
  val text: String,
  val lang: String?,
  val sectionIndex: Int,
  val chunkIndex: Int,
  val cursor: String?,
  val anchor: TTSSessionAnchor?,
)

internal enum class TTSSessionState {
  Idle,
  Playing,
  RequestingMore,
  WaitingForMore,
  Paused,
  Completed,
  Stopped,
  Error,
}

internal class TTSEngineRunner(
  private val getTextToSpeech: () -> TextToSpeech?,
  private val getRate: () -> Float,
  private val setRate: (Float) -> Unit,
  private val getVoiceId: () -> String,
  private val setVoiceId: (String) -> Unit,
  private val applyVoiceAndLang: (String?) -> Unit,
  private val keepServiceActive: () -> Unit,
  private val stopService: () -> Unit,
  private val emitEvent: (JSObject) -> Unit,
) {
  private val queue = ArrayDeque<TTSSessionSegment>()
  private val utteranceSegments = mutableMapOf<String, TTSSessionSegment>()
  private val active = AtomicBoolean(false)
  private val endOfBook = AtomicBoolean(false)
  private val needMorePending = AtomicBoolean(false)
  private val lock = Any()
  private var state: TTSSessionState = TTSSessionState.Idle
  private var pausedSegment: TTSSessionSegment? = null
  private var lastCursor: String? = null
  private val mainHandler = Handler(Looper.getMainLooper())
  private val waitingTimeoutRunnable = Runnable { onWaitingTimeout() }

  fun start(
    segments: List<TTSSessionSegment>,
    rate: Float,
    voiceId: String?,
    endOfBookFlag: Boolean,
  ) {
    setRate(rate)
    val voice = voiceId?.trim().orEmpty()
    if (voice.isNotBlank() && voice != "default") {
      setVoiceId(voice)
    }

    keepServiceActive()
    resetInternal(stopForeground = false)
    synchronized(lock) {
      queue.addAll(segments)
      pausedSegment = null
    }
    endOfBook.set(endOfBookFlag)
    active.set(true)
    state = TTSSessionState.Playing
    println("[TTS][Engine] session_start: segments=${segments.size} rate=${getRate()} voiceId=${getVoiceId()} endOfBook=$endOfBookFlag")
    getTextToSpeech()?.stop()
    playNext()
  }

  fun push(segments: List<TTSSessionSegment>) {
    synchronized(lock) {
      queue.addAll(segments)
    }
    needMorePending.set(false)
    cancelWaitingTimeout()
    if (!active.get()) {
      keepServiceActive()
      active.set(true)
    }
    println("[TTS][Engine] session_push: segments=${segments.size} queued=${queuedCount()} state=$state")
    if (state == TTSSessionState.WaitingForMore || state == TTSSessionState.RequestingMore) {
      state = TTSSessionState.Playing
      playNext()
      return
    }
    if (state == TTSSessionState.Playing && getTextToSpeech()?.isSpeaking != true) {
      playNext()
    }
  }

  fun stop(emitStoppedEvent: Boolean = true) {
    println("[TTS][Engine] session_stop emitStoppedEvent=$emitStoppedEvent")
    val prev = state
    resetInternal(stopForeground = true)
    state = TTSSessionState.Stopped
    // 启动前清理旧会话时不再向前端补发 stopped，避免误伤新会话。
    if (emitStoppedEvent && prev != TTSSessionState.Idle && prev != TTSSessionState.Completed) {
      emitEnd("stopped")
    }
  }

  fun pause() {
    if (state != TTSSessionState.Playing && state != TTSSessionState.RequestingMore && state != TTSSessionState.WaitingForMore) {
      println("[TTS][Engine] session_pause ignored: state=$state")
      return
    }
    val current = synchronized(lock) {
      utteranceSegments.values.firstOrNull()
    }
    pausedSegment = current
    println("[TTS][Engine] session_pause: state=$state segmentId=${current?.id ?: ""}")
    cancelWaitingTimeout()
    state = TTSSessionState.Paused
    try {
      getTextToSpeech()?.stop()
    } catch (_: Exception) {
    }
    synchronized(lock) {
      utteranceSegments.clear()
    }
    emitPaused(current)
  }

  fun resume() {
    if (state != TTSSessionState.Paused) {
      println("[TTS][Engine] session_resume ignored: state=$state")
      return
    }
    val resumeSegment = pausedSegment
    pausedSegment = null
    state = TTSSessionState.Playing
    if (!active.get()) {
      keepServiceActive()
      active.set(true)
    }
    if (resumeSegment != null) {
      synchronized(lock) {
        queue.addFirst(resumeSegment)
      }
    }
    println("[TTS][Engine] session_resume: state=$state queued=${queuedCount()} resumeSegmentId=${resumeSegment?.id ?: ""}")
    emitResumed(resumeSegment)
    playNext()
  }

  fun setSessionRate(rate: Float) {
    setRate(rate)
    println("[TTS][Engine] session_set_rate: $rate")
  }

  fun setSessionVoice(voiceId: String?) {
    val v = voiceId?.trim().orEmpty()
    if (v.isBlank() || v == "default") {
      setVoiceId("")
    } else {
      setVoiceId(v)
    }
    println("[TTS][Engine] session_set_voice: voiceId=${getVoiceId()}")
  }

  fun setEndOfBook(flag: Boolean) {
    endOfBook.set(flag)
    println("[TTS][Engine] session_set_end_of_book: $flag queued=${queuedCount()} state=$state")
    if (flag && state == TTSSessionState.WaitingForMore) {
      cancelWaitingTimeout()
      finishCompleted()
    }
  }

  fun onStart(utteranceId: String): Boolean {
    val segment = synchronized(lock) {
      utteranceSegments[utteranceId]
    } ?: return false
    println("[TTS][Engine] event onStart: utteranceId=$utteranceId segmentId=${segment.id}")
    lastCursor = segment.cursor
    emitProgress(segment)
    return true
  }

  fun onDone(utteranceId: String): Boolean {
    val segment = synchronized(lock) {
      utteranceSegments.remove(utteranceId)
    } ?: return false
    println("[TTS][Engine] event onDone: utteranceId=$utteranceId segmentId=${segment.id}")
    emitSegmentDone(segment)
    if (state == TTSSessionState.Paused || state == TTSSessionState.Stopped) {
      return true
    }
    playNext()
    return true
  }

  fun onError(utteranceId: String, message: String): Boolean {
    val segment = synchronized(lock) {
      utteranceSegments.remove(utteranceId)
    } ?: return false
    println("[TTS][Engine] event onError: utteranceId=$utteranceId segmentId=${segment.id} error=$message")
    if (state == TTSSessionState.Paused || state == TTSSessionState.Stopped) {
      return true
    }
    playNext()
    return true
  }

  fun toSegments(args: TTSSessionSegmentArgs?): TTSSessionSegment? {
    if (args == null) return null
    val id = args.id?.trim().orEmpty()
    val text = args.text?.trim().orEmpty()
    if (id.isBlank() || text.isBlank()) return null
    val anchor = args.anchor?.let { a ->
      val quote = a.quote ?: return@let null
      TTSSessionAnchor(quote, a.prefix, a.suffix)
    }
    return TTSSessionSegment(
      id = id,
      text = text,
      lang = args.lang,
      sectionIndex = args.sectionIndex ?: 0,
      chunkIndex = args.chunkIndex ?: 0,
      cursor = args.cursor,
      anchor = anchor,
    )
  }

  fun toSegmentList(arr: Array<TTSSessionSegmentArgs>?): List<TTSSessionSegment> {
    if (arr == null) return emptyList()
    val out = ArrayList<TTSSessionSegment>(arr.size)
    for (item in arr) {
      val seg = toSegments(item) ?: continue
      out.add(seg)
    }
    return out
  }

  private fun queuedCount(): Int {
    synchronized(lock) {
      return queue.size
    }
  }

  private fun nextSegment(): TTSSessionSegment? {
    synchronized(lock) {
      return queue.pollFirst()
    }
  }

  private fun playNext() {
    if (!active.get()) return
    if (state == TTSSessionState.Paused || state == TTSSessionState.Stopped) return

    val segment = nextSegment()
    if (segment == null) {
      if (endOfBook.get()) {
        finishCompleted()
        return
      }
      state = TTSSessionState.WaitingForMore
      println("[TTS][Engine] queue empty, enter WaitingForMore")
      requestMoreIfNeeded(force = true)
      emitWaitingMore()
      scheduleWaitingTimeout()
      return
    }

    val tts = getTextToSpeech()
    if (tts == null) {
      println("[TTS][Engine] play stopped: TTS not ready")
      state = TTSSessionState.Error
      active.set(false)
      stopService()
      emitEnd("error")
      return
    }

    state = TTSSessionState.Playing
    requestMoreIfNeeded(force = false)

    val utteranceId = "session_${UUID.randomUUID()}"
    synchronized(lock) {
      utteranceSegments[utteranceId] = segment
    }

    try {
      applyVoiceAndLang(segment.lang)
      tts.setSpeechRate(getRate())
      val params = android.os.Bundle().apply {
        putString(TextToSpeech.Engine.KEY_PARAM_UTTERANCE_ID, utteranceId)
      }
      println("[TTS][Engine] speak: utteranceId=$utteranceId segmentId=${segment.id} sectionIndex=${segment.sectionIndex} chunkIndex=${segment.chunkIndex} textLen=${segment.text.length}")
      val result = tts.speak(segment.text, TextToSpeech.QUEUE_FLUSH, params, utteranceId)
      if (result != TextToSpeech.SUCCESS) {
        synchronized(lock) {
          utteranceSegments.remove(utteranceId)
        }
        println("[TTS][Engine] speak failed: utteranceId=$utteranceId result=$result")
        playNext()
      }
    } catch (e: Exception) {
      synchronized(lock) {
        utteranceSegments.remove(utteranceId)
      }
      println("[TTS][Engine] speak error: utteranceId=$utteranceId error=${e.message ?: ""}")
      playNext()
    }
  }

  private fun requestMoreIfNeeded(force: Boolean) {
    if (endOfBook.get()) return
    val should = synchronized(lock) {
      if (needMorePending.get()) return@synchronized false
      val remainingSec = estimateRemainingSecondsLocked()
      val low = remainingSec <= SESSION_LOW_WATERMARK_SECONDS
      if (force || low) {
        needMorePending.set(true)
        true
      } else {
        false
      }
    }
    if (should) {
      if (state == TTSSessionState.Playing) {
        state = TTSSessionState.RequestingMore
      }
      emitRequestMore()
    }
  }

  /** 计算当前队列预估剩余期间（秒），调用方需持有 lock */
  private fun estimateRemainingSecondsLocked(): Double {
    if (queue.isEmpty()) return 0.0
    var totalChars = 0
    for (s in queue) totalChars += s.text.length
    return estimateSeconds(totalChars, getRate())
  }

  /** 文本长度 + rate 转换为预估期间（秒） */
  private fun estimateSeconds(charCount: Int, rate: Float): Double {
    val safeRate = if (rate < 0.1f) 0.1 else rate.toDouble()
    return charCount / CHARS_PER_SECOND_AT_RATE_ONE / safeRate
  }

  private fun finishCompleted() {
    println("[TTS][Engine] session completed")
    val prev = state
    resetInternal(stopForeground = true)
    state = TTSSessionState.Completed
    if (prev != TTSSessionState.Idle && prev != TTSSessionState.Stopped) {
      emitEnd("completed")
    }
  }

  private fun resetInternal(stopForeground: Boolean) {
    cancelWaitingTimeout()
    active.set(false)
    needMorePending.set(false)
    endOfBook.set(false)
    synchronized(lock) {
      queue.clear()
      utteranceSegments.clear()
      pausedSegment = null
    }
    if (stopForeground) {
      stopService()
    }
  }

  private fun scheduleWaitingTimeout() {
    cancelWaitingTimeout()
    mainHandler.postDelayed(waitingTimeoutRunnable, SESSION_WAITING_TIMEOUT_MS)
  }

  private fun cancelWaitingTimeout() {
    mainHandler.removeCallbacks(waitingTimeoutRunnable)
  }

  private fun onWaitingTimeout() {
    if (state != TTSSessionState.WaitingForMore) return
    println("[TTS][Engine] waiting timeout, keep waiting")
    emitWaitingMore()
    scheduleWaitingTimeout()
  }

  private fun emitProgress(segment: TTSSessionSegment) {
    val data = JSObject().apply {
      put("code", "session_progress")
      put("segmentId", segment.id)
      put("sectionIndex", segment.sectionIndex)
      put("chunkIndex", segment.chunkIndex)
      segment.cursor?.let { put("cursor", it) }
      putAnchor(this, segment.anchor)
    }
    emitEvent(data)
  }

  private fun emitSegmentDone(segment: TTSSessionSegment) {
    val data = JSObject().apply {
      put("code", "session_segment_done")
      put("segmentId", segment.id)
      segment.cursor?.let { put("cursor", it) }
    }
    emitEvent(data)
  }

  private fun emitRequestMore() {
    val remaining = queuedCount()
    val estSec = synchronized(lock) { estimateRemainingSecondsLocked() }
    val data = JSObject().apply {
      put("code", "session_request_more")
      put("remaining", remaining)
      put("estimatedSeconds", estSec)
      lastCursor?.let { put("cursor", it) }
    }
    emitEvent(data)
  }

  private fun emitWaitingMore() {
    val data = JSObject().apply {
      put("code", "session_waiting_more")
      lastCursor?.let { put("cursor", it) }
    }
    emitEvent(data)
  }

  private fun emitPaused(segment: TTSSessionSegment?) {
    val data = JSObject().apply {
      put("code", "session_paused")
      segment?.let {
        put("segmentId", it.id)
        it.cursor?.let { c -> put("cursor", c) }
      }
    }
    emitEvent(data)
  }

  private fun emitResumed(segment: TTSSessionSegment?) {
    val data = JSObject().apply {
      put("code", "session_resumed")
      segment?.let {
        put("segmentId", it.id)
        it.cursor?.let { c -> put("cursor", c) }
      }
    }
    emitEvent(data)
  }

  private fun emitEnd(reason: String) {
    val data = JSObject().apply {
      put("code", "session_end")
      put("reason", reason)
    }
    emitEvent(data)
  }

  private fun putAnchor(data: JSObject, anchor: TTSSessionAnchor?) {
    if (anchor == null) return
    val out = JSObject().apply {
      put("quote", anchor.quote)
      anchor.prefix?.let { put("prefix", it) }
      anchor.suffix?.let { put("suffix", it) }
    }
    data.put("anchor", out)
  }
}

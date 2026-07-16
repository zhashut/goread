import AVFoundation
import Foundation
import Tauri
import UIKit

class NativeTTSPlugin: Plugin, AVSpeechSynthesizerDelegate, NativeTTSSessionHost {
  private let ttsChannelName = "tts_events"
  private let speechSynthesizer = AVSpeechSynthesizer()
  private lazy var sessionRunner = TTSSessionRunner(host: self)

  private var isInitialized = false
  private var currentRate: Float = 1.0
  private var currentVoiceId = ""
  private var mediaSessionRequested = false
  private var primaryLang = "zh-CN"

  override init() {
    super.init()
    speechSynthesizer.delegate = self
  }

  var synthesizer: AVSpeechSynthesizer {
    speechSynthesizer
  }

  var sessionRate: Float {
    currentRate
  }

  @objc(init:) public func initialize(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(InitArgs.self)
    let requestedLang = normalizedLanguage(args.lang) ?? primaryLang
    primaryLang = requestedLang
    isInitialized = true
    invoke.resolve(buildInitResponse(requestedLang: requestedLang))
  }

  @objc public func set_rate(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(SetRateArgs.self)
    currentRate = sanitizedRate(args.rate)
    invoke.resolve()
  }

  @objc public func set_voice(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(SetVoiceArgs.self)
    currentVoiceId = sanitizedVoiceId(args.voice)
    invoke.resolve()
  }

  @objc public func get_all_voices(_ invoke: Invoke) {
    invoke.resolve(GetVoicesResponse(voices: readVoices()))
  }

  @objc public func set_media_session_active(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(SetMediaSessionActiveArgs.self)
    mediaSessionRequested = args.active ?? false
    if mediaSessionRequested {
      keepAudioSessionActive()
    } else {
      releaseAudioSessionIfNeeded()
    }
    invoke.resolve()
  }

  @objc public func open_tts_settings(_ invoke: Invoke) {
    // 中文注释: iOS 没有公开的系统 TTS 设置页，这里退化为应用设置页。
    guard let url = URL(string: UIApplication.openSettingsURLString) else {
      invoke.reject("Failed to build settings URL")
      return
    }
    DispatchQueue.main.async {
      UIApplication.shared.open(url, options: [:]) { success in
        if success {
          invoke.resolve()
        } else {
          invoke.reject("Failed to open app settings")
        }
      }
    }
  }

  @objc public func install_tts_data(_ invoke: Invoke) {
    invoke.unavailable("install_tts_data is not supported on iOS")
  }

  @objc public func shutdown(_ invoke: Invoke) {
    sessionRunner.stop(emitStoppedEvent: false)
    speechSynthesizer.stopSpeaking(at: .immediate)
    isInitialized = false
    currentVoiceId = ""
    mediaSessionRequested = false
    releaseAudioSessionIfNeeded(force: true)
    invoke.resolve()
  }

  @objc public func tts_session_start(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(TTSSessionStartArgs.self)
    let segments = TTSSessionSegment.fromArgsList(args.segments)
    guard !segments.isEmpty else {
      invoke.reject("Session segments cannot be empty")
      return
    }

    let requestedLang = normalizedLanguage(args.lang) ?? primaryLang
    primaryLang = requestedLang
    currentRate = sanitizedRate(args.rate)
    currentVoiceId = sanitizedVoiceId(args.voiceId)
    isInitialized = true

    runOnMain {
      self.sessionRunner.start(segments: segments, endOfBook: args.endOfBook ?? false)
    }
    invoke.resolve()
  }

  @objc public func tts_session_push(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(TTSSessionPushArgs.self)
    let segments = TTSSessionSegment.fromArgsList(args.segments)
    runOnMain {
      self.sessionRunner.push(segments)
    }
    invoke.resolve()
  }

  @objc public func tts_session_stop(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(TTSSessionStopArgs.self)
    runOnMain {
      self.sessionRunner.stop(emitStoppedEvent: args.emitStoppedEvent ?? true)
    }
    invoke.resolve()
  }

  @objc public func tts_session_pause(_ invoke: Invoke) {
    runOnMain {
      self.sessionRunner.pause()
    }
    invoke.resolve()
  }

  @objc public func tts_session_resume(_ invoke: Invoke) {
    runOnMain {
      self.sessionRunner.resume()
    }
    invoke.resolve()
  }

  @objc public func tts_session_set_rate(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(SetRateArgs.self)
    currentRate = sanitizedRate(args.rate)
    invoke.resolve()
  }

  @objc public func tts_session_set_voice(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(SetVoiceArgs.self)
    currentVoiceId = sanitizedVoiceId(args.voice)
    invoke.resolve()
  }

  @objc public func tts_session_set_end_of_book(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(TTSSessionSetEndOfBookArgs.self)
    runOnMain {
      self.sessionRunner.setEndOfBook(args.endOfBook ?? false)
    }
    invoke.resolve()
  }

  func prepare(_ utterance: AVSpeechUtterance, lang: String?) {
    utterance.rate = resolvedSpeechRate()
    utterance.voice = resolveVoice(for: lang)
  }

  func keepAudioSessionActive() {
    try? activateAudioSession()
  }

  func releaseAudioSessionIfNeeded() {
    releaseAudioSessionIfNeeded(force: false)
  }

  func emitEvent(_ data: JSObject) {
    trigger(ttsChannelName, data: data)
  }

  private func buildInitResponse(requestedLang: String) -> InitResponse {
    InitResponse(
      success: true,
      status: resolveStatus(for: requestedLang),
      defaultEngine: "ios-avspeech",
      langCheck: buildLangCheck(requestedLang: requestedLang),
      voices: readVoices()
    )
  }

  private func buildLangCheck(requestedLang: String) -> LangCheckResult {
    let supported = AVSpeechSynthesisVoice(language: requestedLang) != nil
    return LangCheckResult(
      requested: requestedLang,
      result: supported ? "ok" : "not_supported"
    )
  }

  private func resolveStatus(for requestedLang: String) -> String {
    buildLangCheck(requestedLang: requestedLang).result == "ok" ? "success" : "lang_not_supported"
  }

  private func readVoices() -> [TTSVoiceResult] {
    AVSpeechSynthesisVoice.speechVoices()
      .map { voice in
        TTSVoiceResult(
          id: voice.identifier,
          name: voice.name,
          lang: voice.language,
          disabled: false
        )
      }
      .sorted { lhs, rhs in
        if lhs.lang == rhs.lang {
          return lhs.name < rhs.name
        }
        return lhs.lang < rhs.lang
      }
  }

  private func resolveVoice(for lang: String?) -> AVSpeechSynthesisVoice? {
    if !currentVoiceId.isEmpty,
       let matchedVoice = AVSpeechSynthesisVoice(identifier: currentVoiceId) {
      return matchedVoice
    }
    let targetLang = normalizedLanguage(lang) ?? primaryLang
    return AVSpeechSynthesisVoice(language: targetLang)
  }

  private func resolvedSpeechRate() -> Float {
    // 中文注释: 前端沿用 Android 的语速语义，这里按系统默认语速映射到 iOS 范围。
    let base = AVSpeechUtteranceDefaultSpeechRate * sanitizedRate(currentRate)
    return min(AVSpeechUtteranceMaximumSpeechRate, max(AVSpeechUtteranceMinimumSpeechRate, base))
  }

  private func sanitizedRate(_ value: Float?) -> Float {
    let rate = value ?? currentRate
    return min(2.0, max(0.2, rate))
  }

  private func sanitizedVoiceId(_ value: String?) -> String {
    let voiceId = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if voiceId.isEmpty || voiceId == "default" {
      return ""
    }
    return voiceId
  }

  private func normalizedLanguage(_ lang: String?) -> String? {
    guard let lang else { return nil }
    let trimmed = lang.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    return trimmed
  }

  private func activateAudioSession() throws {
    try runOnMain {
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(.playback, options: [.mixWithOthers])
      try session.setActive(true)
    }
  }

  private func releaseAudioSessionIfNeeded(force: Bool) {
    guard force || !mediaSessionRequested else { return }
    guard !speechSynthesizer.isSpeaking && !speechSynthesizer.isPaused else { return }
    try? runOnMain {
      try AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }
  }

  private func runOnMain<T>(_ work: () throws -> T) rethrows -> T {
    if Thread.isMainThread {
      return try work()
    }

    var output: Result<T, Error>?
    DispatchQueue.main.sync {
      output = Result { try work() }
    }
    return try output!.get()
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
    sessionRunner.onDidStart(utterance)
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    sessionRunner.onDidFinish(utterance)
    releaseAudioSessionIfNeeded()
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
    sessionRunner.onDidCancel(utterance)
    releaseAudioSessionIfNeeded()
  }
}

@_cdecl("init_plugin_native_tts")
func initPluginNativeTTS() -> Plugin {
  NativeTTSPlugin()
}

import AVFoundation
import Foundation
import MediaPlayer
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

  // 中文注释: 播放状态缓存，用于回填 Now Playing 卡片存根与锁屏进度。
  private var nowPlaying = NowPlayingState()
  private var remoteCommandsRegistered = false
  private var interruptionObserver: NSObjectProtocol?

  override init() {
    super.init()
    speechSynthesizer.delegate = self
    observeAudioInterruption()
  }

  deinit {
    if let observer = interruptionObserver {
      NotificationCenter.default.removeObserver(observer)
    }
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

  /// 与 Android `set_playback_state` 对齐：把播放状态同步到系统 Now Playing 卡片，
  /// 并确保远程控制命令已注册。iOS 没有前台服务，锁屏/控制中心的卡片与按键即对等承载。
  @objc public func set_playback_state(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(SetPlaybackStateArgs.self)
    runOnMain { [self] in
      nowPlaying.state = args.state
      nowPlaying.title = args.title
      nowPlaying.text = args.text
      if let position = args.positionMs, position >= 0 {
        nowPlaying.positionMs = Double(position)
      }
      if let duration = args.durationMs, duration >= 0 {
        nowPlaying.durationMs = Double(duration)
      }
      if let canPrev = args.canSkipPrevious {
        nowPlaying.canSkipPrevious = canPrev
      }
      if let canNext = args.canSkipNext {
        nowPlaying.canSkipNext = canNext
      }

      // 只要前端下发过播放/暂停态，就认为需要对外暴露锁屏控制（含这里的激活音频会话）。
      if args.state == "playing" || args.state == "paused" {
        mediaSessionRequested = true
        try? activateAudioSession()
        ensureNowPlaying()
      } else {
        clearNowPlayingIfIdle()
      }
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
    nowPlaying = NowPlayingState()
    MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
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

  // ---------------------------------------------------------------------------
  // 系统 Now Playing 卡片 + 控制中心/锁屏媒体控制（对等 Android 媒体通知）
  // ---------------------------------------------------------------------------

  private func ensureNowPlaying() {
    registerRemoteCommandsIfNeeded()
    updateNowPlayingInfo()
  }

  private func clearNowPlayingIfIdle() {
    // 只有 stopped 且确实没在朗读时才清空卡片；暂停/播放中保留卡片以便继续控制。
    if nowPlaying.state == "stopped" && !speechSynthesizer.isSpeaking && !speechSynthesizer.isPaused {
      MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }
  }

  private func updateNowPlayingInfo() {
    var info: [String: Any] = [:]
    if let title = nowPlaying.title, !title.isEmpty {
      info[MPMediaItemPropertyTitle] = title
    }
    if let text = nowPlaying.text, !text.isEmpty {
      info[MPMediaItemPropertyArtist] = text
    }
    if nowPlaying.durationMs > 0 {
      info[MPMediaItemPropertyPlaybackDuration] = NSNumber(value: nowPlaying.durationMs / 1000.0)
    }

    let isPlaying = nowPlaying.state == "playing"
    info[MPNowPlayingInfoPropertyPlaybackRate] = NSNumber(value: isPlaying ? 1.0 : 0.0)

    info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = NSNumber(value: nowPlaying.positionMs / 1000.0)
    MPNowPlayingInfoCenter.default().nowPlayingInfo = info
  }

  private func registerRemoteCommandsIfNeeded() {
    guard !remoteCommandsRegistered else { return }
    remoteCommandsRegistered = true
    let center = MPRemoteCommandCenter.shared()

    center.playCommand.isEnabled = true
    center.playCommand.addTarget { [weak self] _ in
      self?.dispatchMediaAction("play")
      return .success
    }

    center.pauseCommand.isEnabled = true
    center.pauseCommand.addTarget { [weak self] _ in
      self?.dispatchMediaAction("pause")
      return .success
    }

    center.togglePlayPauseCommand.isEnabled = true
    center.togglePlayPauseCommand.addTarget { [weak self] _ in
      // 前端只消费明确的 play/pause，这里按当前朗读状态决定发哪个。
      let action: String
      if let self, self.speechSynthesizer.isSpeaking {
        action = "pause"
      } else {
        action = "play"
      }
      self?.dispatchMediaAction(action)
      return .success
    }

    center.previousTrackCommand.isEnabled = true
    center.previousTrackCommand.addTarget { [weak self] _ in
      self?.dispatchMediaAction("prev-chapter")
      return .success
    }

    center.nextTrackCommand.isEnabled = true
    center.nextTrackCommand.addTarget { [weak self] _ in
      self?.dispatchMediaAction("next-chapter")
      return .success
    }

    center.changePlaybackPositionCommand.isEnabled = true
    center.changePlaybackPositionCommand.addTarget { [weak self] event in
      guard let positionEvent = event as? MPChangePlaybackPositionCommandEvent else {
        return .commandFailed
      }
      let positionMs = Int64(positionEvent.positionTime * 1000)
      self?.dispatchMediaAction("seek", positionMs: positionMs)
      return .success
    }
  }

  /// 把控制中心/锁屏的媒体按键统一转发给前端会话层（code=media_action，与 Android 对齐）。
  private func dispatchMediaAction(_ action: String, positionMs: Int64? = nil) {
    runOnMain { [self] in
      var data = JSObject()
      data["code"] = "media_action"
      data["action"] = action
      if let positionMs {
        data["positionMs"] = positionMs
      }
      emitEvent(data)
    }
  }

  // ---------------------------------------------------------------------------
  // 音频中断（对前端循环）：对应 Android 的音频焦点丢失/抢回
  // ---------------------------------------------------------------------------

  private func observeAudioInterruption() {
    interruptionObserver = NotificationCenter.default.addObserver(
      forName: AVAudioSession.interruptionNotification,
      object: AVAudioSession.sharedInstance(),
      queue: .main
    ) { [weak self] notification in
      self?.handleAudioInterruption(notification)
    }
  }

  private func handleAudioInterruption(_ notification: Notification) {
    guard let userInfo = notification.userInfo,
          let rawType = userInfo[AVAudioSessionInterruptionTypeKey] as? UInt,
          let type = AVAudioSession.InterruptionType(rawValue: rawType)
    else {
      return
    }

    switch type {
    case .began:
      // 被打断：发给前端会话层去真正暂停（对等 Android dispatchAction(PAUSE, fromAudioFocus)）。
      // 前端收到 media_action(pause) 后会同步 UI 并回调 tts_session_pause 停掉引擎。
      guard speechSynthesizer.isSpeaking || speechSynthesizer.isPaused else { return }
      dispatchMediaAction("pause")

    case .ended:
      // 前台通知结束：如有 shouldResume，打包给前端按用户策略恢复（对 Android 焦点恢复自动续播）。
      if let opts = userInfo[AVAudioSessionInterruptionOptionKey] as? UInt,
         AVAudioSession.InterruptionOptions(rawValue: opts).contains(.shouldResume) {
        runOnMain { [self] in
          var data = JSObject()
          data["code"] = "media_action"
          data["action"] = "play"
          emitEvent(data)
        }
      }
    @unknown default:
      break
    }
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


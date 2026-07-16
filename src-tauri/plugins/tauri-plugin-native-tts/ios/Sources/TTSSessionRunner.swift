import AVFoundation
import Foundation
import Tauri

private let sessionLowWatermarkSeconds = 6.0
private let sessionWaitingTimeoutMs = 60_000
private let charsPerSecondAtRateOne = 5.5

enum TTSSessionState {
  case idle
  case playing
  case requestingMore
  case waitingForMore
  case paused
  case completed
  case stopped
  case error
}

protocol NativeTTSSessionHost: AnyObject {
  var synthesizer: AVSpeechSynthesizer { get }
  var sessionRate: Float { get }
  func prepare(_ utterance: AVSpeechUtterance, lang: String?)
  func keepAudioSessionActive()
  func releaseAudioSessionIfNeeded()
  func emitEvent(_ data: JSObject)
}

final class TTSSessionRunner {
  private weak var host: NativeTTSSessionHost?
  private var queue: [TTSSessionSegment] = []
  private var state: TTSSessionState = .idle
  private var currentSegment: TTSSessionSegment?
  private var currentUtterance: AVSpeechUtterance?
  private var endOfBook = false
  private var needMorePending = false
  private var lastCursor: String?
  private var waitingWorkItem: DispatchWorkItem?

  init(host: NativeTTSSessionHost) {
    self.host = host
  }

  func start(segments: [TTSSessionSegment], endOfBook: Bool) {
    // 中文注释: 先清空旧会话状态，再挂载新队列，避免旧回调串到新会话。
    stop(emitStoppedEvent: false)
    queue = segments
    self.endOfBook = endOfBook
    needMorePending = false
    state = .playing
    playNext()
  }

  func push(_ segments: [TTSSessionSegment]) {
    guard !segments.isEmpty else { return }
    queue.append(contentsOf: segments)
    needMorePending = false
    cancelWaitingTimeout()
    if state == .waitingForMore || state == .requestingMore {
      state = .playing
      playNext()
      return
    }
    if currentSegment == nil && state != .paused && state != .stopped {
      playNext()
    }
  }

  func stop(emitStoppedEvent: Bool = true) {
    let previousState = state
    cancelWaitingTimeout()
    queue.removeAll()
    endOfBook = false
    needMorePending = false
    currentSegment = nil
    currentUtterance = nil
    if previousState != .idle {
      host?.synthesizer.stopSpeaking(at: .immediate)
    }
    host?.releaseAudioSessionIfNeeded()
    state = .stopped
    if emitStoppedEvent, previousState != .idle, previousState != .completed {
      emitEnd(reason: "stopped")
    }
  }

  func pause() {
    guard state == .playing || state == .requestingMore || state == .waitingForMore else { return }
    cancelWaitingTimeout()
    if currentSegment != nil {
      _ = host?.synthesizer.pauseSpeaking(at: .immediate)
    }
    state = .paused
    emitPaused()
  }

  func resume() {
    guard state == .paused else { return }
    state = .playing
    emitResumed()
    if host?.synthesizer.isPaused == true {
      _ = host?.synthesizer.continueSpeaking()
      return
    }
    playNext()
  }

  func setEndOfBook(_ flag: Bool) {
    endOfBook = flag
    if flag, state == .waitingForMore, currentSegment == nil, queue.isEmpty {
      finishCompleted()
    }
  }

  func onDidStart(_ utterance: AVSpeechUtterance) {
    guard matchesCurrentUtterance(utterance), let segment = currentSegment else { return }
    lastCursor = segment.cursor
    emitProgress(for: segment)
  }

  func onDidFinish(_ utterance: AVSpeechUtterance) {
    guard matchesCurrentUtterance(utterance), let segment = currentSegment else { return }
    currentSegment = nil
    currentUtterance = nil
    emitSegmentDone(for: segment)
    guard state != .paused && state != .stopped else { return }
    playNext()
  }

  func onDidCancel(_ utterance: AVSpeechUtterance) {
    guard matchesCurrentUtterance(utterance) else { return }
    currentSegment = nil
    currentUtterance = nil
    guard state != .paused && state != .stopped && state != .idle else { return }
    playNext()
  }

  private func matchesCurrentUtterance(_ utterance: AVSpeechUtterance) -> Bool {
    currentUtterance === utterance
  }

  private func playNext() {
    guard let host else { return }
    guard state != .paused && state != .stopped else { return }

    if queue.isEmpty {
      if endOfBook {
        finishCompleted()
      } else {
        state = .waitingForMore
        requestMoreIfNeeded(force: true)
        emitWaitingMore()
        scheduleWaitingTimeout()
      }
      return
    }

    let segment = queue.removeFirst()
    let utterance = AVSpeechUtterance(string: segment.text)
    host.prepare(utterance, lang: segment.lang)
    host.keepAudioSessionActive()

    currentSegment = segment
    currentUtterance = utterance
    state = .playing
    requestMoreIfNeeded(force: false)
    host.synthesizer.speak(utterance)
  }

  private func requestMoreIfNeeded(force: Bool) {
    guard !endOfBook else { return }
    guard !needMorePending else { return }
    let shouldRequest = force || estimateRemainingSeconds() <= sessionLowWatermarkSeconds
    guard shouldRequest else { return }
    needMorePending = true
    if state == .playing {
      state = .requestingMore
    }
    emitRequestMore()
  }

  private func estimateRemainingSeconds() -> Double {
    let totalChars = queue.reduce(0) { partial, segment in
      partial + segment.text.count
    }
    return estimateSeconds(charCount: totalChars)
  }

  private func estimateSeconds(charCount: Int) -> Double {
    guard let host else { return 0 }
    let rate = max(0.1, Double(host.sessionRate))
    return Double(charCount) / charsPerSecondAtRateOne / rate
  }

  private func finishCompleted() {
    let previousState = state
    cancelWaitingTimeout()
    queue.removeAll()
    endOfBook = false
    needMorePending = false
    currentSegment = nil
    currentUtterance = nil
    state = .completed
    host?.releaseAudioSessionIfNeeded()
    if previousState != .idle && previousState != .stopped {
      emitEnd(reason: "completed")
    }
  }

  private func scheduleWaitingTimeout() {
    cancelWaitingTimeout()
    let workItem = DispatchWorkItem { [weak self] in
      self?.handleWaitingTimeout()
    }
    waitingWorkItem = workItem
    DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(sessionWaitingTimeoutMs), execute: workItem)
  }

  private func cancelWaitingTimeout() {
    waitingWorkItem?.cancel()
    waitingWorkItem = nil
  }

  private func handleWaitingTimeout() {
    guard state == .waitingForMore else { return }
    emitWaitingMore()
    scheduleWaitingTimeout()
  }

  private func emitProgress(for segment: TTSSessionSegment) {
    var data: JSObject = [
      "code": "session_progress",
      "segmentId": segment.id,
      "sectionIndex": segment.sectionIndex,
      "chunkIndex": segment.chunkIndex,
    ]
    if let cursor = segment.cursor {
      data["cursor"] = cursor
    }
    if let anchor = segment.anchor {
      var anchorData: JSObject = ["quote": anchor.quote]
      if let prefix = anchor.prefix {
        anchorData["prefix"] = prefix
      }
      if let suffix = anchor.suffix {
        anchorData["suffix"] = suffix
      }
      data["anchor"] = anchorData
    }
    host?.emitEvent(data)
  }

  private func emitSegmentDone(for segment: TTSSessionSegment) {
    var data: JSObject = [
      "code": "session_segment_done",
      "segmentId": segment.id,
    ]
    if let cursor = segment.cursor {
      data["cursor"] = cursor
    }
    host?.emitEvent(data)
  }

  private func emitRequestMore() {
    var data: JSObject = [
      "code": "session_request_more",
      "remaining": queue.count,
      "estimatedSeconds": estimateRemainingSeconds(),
    ]
    if let cursor = lastCursor {
      data["cursor"] = cursor
    }
    host?.emitEvent(data)
  }

  private func emitWaitingMore() {
    var data: JSObject = [
      "code": "session_waiting_more",
    ]
    if let cursor = lastCursor {
      data["cursor"] = cursor
    }
    host?.emitEvent(data)
  }

  private func emitPaused() {
    var data: JSObject = [
      "code": "session_paused",
    ]
    if let segment = currentSegment {
      data["segmentId"] = segment.id
      if let cursor = segment.cursor {
        data["cursor"] = cursor
      }
    }
    host?.emitEvent(data)
  }

  private func emitResumed() {
    var data: JSObject = [
      "code": "session_resumed",
    ]
    if let segment = currentSegment {
      data["segmentId"] = segment.id
      if let cursor = segment.cursor {
        data["cursor"] = cursor
      }
    }
    host?.emitEvent(data)
  }

  private func emitEnd(reason: String) {
    host?.emitEvent([
      "code": "session_end",
      "reason": reason,
    ])
  }
}

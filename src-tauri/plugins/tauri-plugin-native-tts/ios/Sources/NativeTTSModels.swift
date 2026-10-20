import Foundation

struct InitArgs: Decodable {
  let lang: String?
}

struct SetRateArgs: Decodable {
  let rate: Float?
}

struct SetVoiceArgs: Decodable {
  let voice: String?
}

struct SetMediaSessionActiveArgs: Decodable {
  let active: Bool?
  let keepAppInForeground: Bool?
  let notificationTitle: String?
  let notificationText: String?
  let foregroundServiceTitle: String?
  let foregroundServiceText: String?
}

/// 与 Android `set_playback_state` 对齐的播放状态载荷。
/// iOS 没有前台服务语义，这里把同名命令映射为系统 Now Playing 卡片信息
/// （标题 / 进度 / 时长 / 可跳转性）与远程控制能力（播放 / 暂停 / 上下章 / 拖动）。
struct SetPlaybackStateArgs: Decodable {
  let state: String?
  let title: String?
  let text: String?
  let largeIconPath: String?
  let positionMs: Int?
  let durationMs: Int?
  let canSkipPrevious: Bool?
  let canSkipNext: Bool?
}

/// Now Playing 卡片的状态缓存，由 `set_playback_state` 持续回填。
struct NowPlayingState {
  var state: String? = nil
  var title: String? = nil
  var text: String? = nil
  var positionMs: Double = 0
  var durationMs: Double = 0
  var canSkipPrevious: Bool = true
  var canSkipNext: Bool = true
}

struct TTSSessionAnchorArgs: Codable {
  let quote: String?
  let prefix: String?
  let suffix: String?
}

struct TTSSessionSegmentArgs: Codable {
  let id: String?
  let text: String?
  let lang: String?
  let sectionIndex: Int?
  let chunkIndex: Int?
  let cursor: String?
  let anchor: TTSSessionAnchorArgs?
  /// 所属章节整章可朗读字符数（后端切片时算好，前端估算章节总时长用）
  let sectionSpeakableLength: Int?
  /// 所属章节总 chunk 数（前端按 chunkIndex / sectionChunkCount 推进文本进度）
  let sectionChunkCount: Int?
}

struct TTSSessionStartArgs: Decodable {
  let segments: [TTSSessionSegmentArgs]?
  let lang: String?
  let rate: Float?
  let voiceId: String?
  let endOfBook: Bool?
}

struct TTSSessionPushArgs: Decodable {
  let segments: [TTSSessionSegmentArgs]?
}

struct TTSSessionSetEndOfBookArgs: Decodable {
  let endOfBook: Bool?
}

struct TTSSessionStopArgs: Decodable {
  let emitStoppedEvent: Bool?
}

struct TTSVoiceResult: Encodable {
  let id: String
  let name: String
  let lang: String
  let disabled: Bool
}

struct LangCheckResult: Encodable {
  let requested: String
  let result: String
}

struct InitResponse: Encodable {
  let success: Bool
  let status: String
  let defaultEngine: String?
  let langCheck: LangCheckResult?
  let voices: [TTSVoiceResult]?
}

struct GetVoicesResponse: Encodable {
  let voices: [TTSVoiceResult]
}

struct TTSSessionAnchor {
  let quote: String
  let prefix: String?
  let suffix: String?
}

struct TTSSessionSegment {
  let id: String
  let text: String
  let lang: String?
  let sectionIndex: Int
  let chunkIndex: Int
  let cursor: String?
  let anchor: TTSSessionAnchor?
  let sectionSpeakableLength: Int?
  let sectionChunkCount: Int?
}

extension TTSSessionSegment {
  // 中文注释: 统一把 IPC 入参转换成内部会话模型，避免插件主体和引擎重复校验。
  static func fromArgs(_ args: TTSSessionSegmentArgs?) -> TTSSessionSegment? {
    guard let args else { return nil }
    let id = (args.id ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    let text = (args.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    guard !id.isEmpty, !text.isEmpty else { return nil }
    let anchor = args.anchor.flatMap { value -> TTSSessionAnchor? in
      guard let quote = value.quote?.trimmingCharacters(in: .whitespacesAndNewlines), !quote.isEmpty else {
        return nil
      }
      return TTSSessionAnchor(
        quote: quote,
        prefix: value.prefix,
        suffix: value.suffix
      )
    }
    return TTSSessionSegment(
      id: id,
      text: text,
      lang: args.lang,
      sectionIndex: args.sectionIndex ?? 0,
      chunkIndex: args.chunkIndex ?? 0,
      cursor: args.cursor,
      anchor: anchor,
      sectionSpeakableLength: args.sectionSpeakableLength,
      sectionChunkCount: args.sectionChunkCount
    )
  }

  static func fromArgsList(_ args: [TTSSessionSegmentArgs]?) -> [TTSSessionSegment] {
    (args ?? []).compactMap(Self.fromArgs)
  }
}


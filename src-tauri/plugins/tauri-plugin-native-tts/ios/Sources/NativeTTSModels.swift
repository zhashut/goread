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
      anchor: anchor
    )
  }

  static func fromArgsList(_ args: [TTSSessionSegmentArgs]?) -> [TTSSessionSegment] {
    (args ?? []).compactMap(Self.fromArgs)
  }
}

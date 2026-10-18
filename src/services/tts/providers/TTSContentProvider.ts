import type { BookFormat } from '../../formats/types';
import type {
  TTSReadingAnchor,
  TTSSegment,
  TTSSessionListeners,
  TTSSessionProgressEvent,
} from '../types';

export type BackendTTSFormat = 'epub' | 'mobi' | 'txt';

/** 用户阅读位置：朗读起点 / 听书停止时的回写目标 */
export interface TTSReadingPosition {
  sectionIndex: number;
  anchor: TTSReadingAnchor | null;
}

/** 对应 Rust 端 TtsGetSegmentsRequest 字段 */
export interface BackendTTSRequest {
  bookId: string;
  filePath: string;
  format: BackendTTSFormat;
  cursor: string | null;
  maxSegments: number;
  startPosition?: TTSReadingPosition | null;
  fallbackSectionIndex?: number;
  totalSections?: number;
  readingMode?: 'horizontal' | 'vertical';
  /** 不参与阅读顺序的章节下标（EPUB3 导航文档等），TTS 需跳过 */
  hiddenSections?: number[];
}

/** Provider 取片请求 */
export interface TTSContentProviderGetSegmentsRequest {
  /** null 表示从用户当前阅读位置开始；非空表示从指定 cursor 继续 */
  cursor: string | null;
  /** 单次最大 segment 数量 */
  maxSegments: number;
  /** 用户当前阅读位置（仅 cursor=null 时使用） */
  startPosition?: TTSReadingPosition | null;
}

/** Provider 取片响应 */
export interface TTSContentProviderBatch {
  segments: TTSSegment[];
  /** 后续 cursor，hasMore=false 时为 null */
  cursor: string | null;
  hasMore: boolean;
}

/**
 * 内容供给抽象：每种书籍格式实现自己的 Provider
 * TTSSession 仅依赖该接口，不感知具体格式
 */
export interface TTSContentProvider {
  /** 当前格式标识，仅用于日志 */
  readonly format: BookFormat;

  /**
   * 取下一批待朗读片段
   * cursor=null：从用户当前阅读位置开始；cursor 非空：从指定位置继续
   */
  getSegments(req: TTSContentProviderGetSegmentsRequest): Promise<TTSContentProviderBatch>;

  /** 构造 Rust 端 tts_get_segments/托管会话所需的请求字段；不支持则返回 null */
  buildBackendRequest(req: TTSContentProviderGetSegmentsRequest): BackendTTSRequest | null;

  /** 在前端可见 DOM 中根据 anchor 定位 Range，用于高亮 */
  locateAnchor(sectionIndex: number, anchor: TTSReadingAnchor | null | undefined): Range | null;

  /** 用户停止听书时把最后朗读位置写回阅读器视图 */
  restoreReadingPosition(position: TTSReadingPosition): Promise<void>;

  /** progress 推进时按格式执行额外定位，返回 true 表示已执行章节级对齐 */
  followProgressPosition?(
    position: TTSReadingPosition,
    previousSectionIndex: number,
  ): Promise<boolean>;

  /** 文档因翻页/重排/资源切换被销毁时由 TTSSession 调用 */
  notifyDocumentUpdated(): void;

  /**
   * 章节文本长度（字符数）。
   * 用于媒体通知的时长估算（章节级进度条）；不支持时返回 null。
   */
  getSectionTextLength?(sectionIndex: number): number | null;

  /**
   * 按章节内文本比例生成可朗读起点 anchor。
   * 用于媒体通知进度条拖动定位；不支持时返回 null。
   */
  buildAnchorAtRatio?(sectionIndex: number, ratio: number): TTSReadingAnchor | null;

  /** 章节内“可朗读字符数”（去掉空白/换行），用于时长估算 */
  getSectionSpeakableLength?(sectionIndex: number): number | null;

  /** 相邻章节索引（跳过 EPUB 隐藏章节等）；无相邻章节时返回 null */
  getAdjacentSectionIndex?(current: number, direction: 'prev' | 'next'): number | null;

  /** 章节标题（用于媒体通知随朗读章节更新）；未知时返回 null */
  getSectionTitle?(sectionIndex: number): string | null;

  /**
   * 章节内 anchor 的近似字符偏移。
   * 用于起播位置不是章首时，初始化进度条基准；不支持时返回 null。
   */
  getAnchorTextOffset?(sectionIndex: number, anchor: TTSReadingAnchor | null | undefined): number | null;
}

/**
 * 后端会话驱动：抽象后端命令通道与事件订阅
 * NativeSessionDriver / WebSpeechSessionDriver 各自实现
 */
export interface IBackendSessionDriver {
  supportsSession(): boolean;
  supportsManagedSession?: () => boolean;
  managedSessionStart?: (payload: {
    request: BackendTTSRequest;
    rate: number;
    voiceId?: string;
    lang?: string;
    lowWatermarkSeconds?: number;
  }) => Promise<void>;
  managedSessionStop?: () => Promise<void>;
  managedSessionPause?: () => Promise<void>;
  managedSessionResume?: () => Promise<void>;
  managedSessionSetRate?: (rate: number) => Promise<void>;
  managedSessionSetVoice?: (voiceId: string) => Promise<void>;

  sessionStart(payload: {
    segments: TTSSegment[];
    rate: number;
    voiceId?: string;
    lang?: string;
    endOfBook: boolean;
  }): Promise<void>;

  sessionPush(segments: TTSSegment[]): Promise<void>;
  sessionStop(): Promise<void>;
  sessionPause(): Promise<void>;
  sessionResume(): Promise<void>;
  sessionSetRate(rate: number): Promise<void>;
  sessionSetVoice(voiceId: string): Promise<void>;
  sessionSetEndOfBook(flag: boolean): Promise<void>;

  /** 注册会话事件监听器，返回取消函数 */
  subscribeSession(listeners: TTSSessionListeners): () => void;
}

/** 高亮辅助：把 progress 事件中的 anchor 转出 */
export const buildAnchorFromProgress = (
  event: TTSSessionProgressEvent,
): TTSReadingAnchor | null => event.anchor ?? null;


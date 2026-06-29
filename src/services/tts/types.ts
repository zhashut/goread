/** TTS 播放状态 */
export type TTSState = 'stopped' | 'playing' | 'paused';

/** SSML 解析后的朗读标记 */
export interface TTSMark {
  /** 在纯文本中的偏移位置 */
  offset: number;
  /** mark 标识符 */
  name: string;
  /** 该段纯文本内容 */
  text: string;
  /** 该段文本的语言 */
  language: string;
}

/** TTS 引擎返回的事件类型 */
export type TTSEventCode = 'boundary' | 'end' | 'error';

/** TTS 消息事件 */
export interface TTSMessageEvent {
  code: TTSEventCode;
  /** boundary 事件时携带的 mark 名称 */
  mark?: string;
  /** 错误信息 */
  error?: string;
}

/** 语音信息 */
export interface TTSVoice {
  id: string;
  name: string;
  lang: string;
  display?: {
    zh?: string;
    en?: string;
  };
}

/** TTS 朗读起始位置信息 */
export type TTSVisibleStart =
  | { type: 'range'; range: Range }
  | { type: 'offset'; offset: number };

/** 文本锚点：用于在 DOM 中定位高亮位置 */
export interface TTSReadingAnchor {
  quote: string;
  prefix?: string;
  suffix?: string;
}

/** 后端会话朗读片段：发送给原生侧的最小内容单元 */
export interface TTSSegment {
  id: string;
  text: string;
  lang?: string;
  sectionIndex: number;
  chunkIndex: number;
  cursor: string;
  anchor?: TTSReadingAnchor | null;
}

/** 会话进度事件：原生在每段开始播报时上抛 */
export interface TTSSessionProgressEvent {
  segmentId: string;
  sectionIndex: number;
  chunkIndex: number;
  cursor?: string;
  anchor?: TTSReadingAnchor | null;
}

/** 会话补给请求：队列接近低水位时上抛 */
export interface TTSSessionRequestMoreEvent {
  remaining: number;
  estimatedSeconds?: number;
  cursor?: string;
}

/** 会话等待补给：队列已空但未结束 */
export interface TTSSessionWaitingMoreEvent {
  cursor?: string;
}

/** 段落播放完成事件 */
export interface TTSSessionSegmentDoneEvent {
  segmentId: string;
  cursor?: string;
}

/** 暂停 / 恢复事件 */
export interface TTSSessionPauseStateEvent {
  segmentId?: string;
  cursor?: string;
}

/** 会话结束事件原因 */
export type TTSSessionEndReason = 'completed' | 'stopped' | 'error' | 'stalled';

/** 会话结束事件 */
export interface TTSSessionEndEvent {
  reason: TTSSessionEndReason;
  message?: string;
}

/** 系统默认 TTS 引擎变更事件 */
export interface TTSSessionEngineChangedEvent {
  prevEngine?: string;
  engine?: string;
}

/** 会话事件统一回调集合 */
export interface TTSSessionListeners {
  onProgress?: (event: TTSSessionProgressEvent) => void;
  onRequestMore?: (event: TTSSessionRequestMoreEvent) => void;
  onWaitingMore?: (event: TTSSessionWaitingMoreEvent) => void;
  onSegmentDone?: (event: TTSSessionSegmentDoneEvent) => void;
  onPaused?: (event: TTSSessionPauseStateEvent) => void;
  onResumed?: (event: TTSSessionPauseStateEvent) => void;
  onEnd?: (event: TTSSessionEndEvent) => void;
  onEngineChanged?: (event: TTSSessionEngineChangedEvent) => void;
}


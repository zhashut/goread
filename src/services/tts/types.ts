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
}

/** TTS 朗读起始位置信息 */
export type TTSVisibleStart =
  | { type: 'range'; range: Range }
  | { type: 'offset'; offset: number };

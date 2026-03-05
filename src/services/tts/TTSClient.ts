import type { TTSMessageEvent, TTSVoice } from './types';

/**
 * TTS 客户端接口
 * 定义语音合成引擎的统一协议
 */
export interface ITTSClient {
  /** 引擎名称 */
  readonly name: string;

  /** 是否已初始化 */
  initialized: boolean;

  /** 初始化引擎 */
  init(): Promise<boolean>;

  /** 朗读 SSML 内容，返回异步事件迭代器 */
  speak(ssml: string, signal: AbortSignal): AsyncIterable<TTSMessageEvent>;

  /** 停止当前朗读 */
  stop(): Promise<void>;

  /** 暂停朗读 */
  pause(): Promise<boolean>;

  /** 恢复朗读 */
  resume(): Promise<boolean>;

  /** 获取可用语音列表 */
  getVoices(lang?: string): TTSVoice[];

  /** 获取当前语音 ID */
  getVoiceId(): string;

  /** 设置主语言 */
  setPrimaryLang(lang: string): void;

  /** 设置指定语音 */
  setVoice(voiceId: string): void;

  /** 设置语速 */
  setRate(rate: number): void;

  /** 获取当前语速 */
  getRate(): number;

  /** 关闭引擎，释放资源 */
  shutdown(): Promise<void>;
}

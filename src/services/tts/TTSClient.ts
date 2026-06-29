import type { TTSVoice } from './types';

/**
 * TTS 客户端协议
 * 仅负责"引擎初始化、语音/语速配置、关闭"
 * 实际朗读由 IBackendSessionDriver 接管
 */
export interface ITTSClient {
  /** 引擎名称 */
  readonly name: string;

  /** 是否已初始化 */
  initialized: boolean;

  /** 初始化引擎 */
  init(): Promise<boolean>;

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


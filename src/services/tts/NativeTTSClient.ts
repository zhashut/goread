import type { ITTSClient } from './TTSClient';
import type { TTSMessageEvent, TTSVoice } from './types';
import { parseSSMLMarks } from './ssmlParser';
import { TTS_RATE_DEFAULT } from '../../constants/tts';

/** 全局回调类型声明 */
declare global {
  interface Window {
    __TTS_BRIDGE_READY__?: boolean;
    __onTTSInit__?: (success: boolean, voices: TTSVoice[]) => void;
    __onTTSEvent__?: (code: string, utteranceId: string, error: string) => void;
    TTSBridge?: {
      init(): void;
      speak(text: string, lang: string, rate: number, utteranceId: string): void;
      stop(): void;
      pause(): boolean;
      isAvailable(): boolean;
      getVoices(): string;
      setRate(rate: number): void;
      shutdown(): void;
    };
  }
}

/**
 * Android 原生 TTS 客户端
 * 通过 JavascriptInterface 桥接 Android TextToSpeech API，
 * 当 Web Speech API 不可用时作为兜底引擎
 */
export class NativeTTSClient implements ITTSClient {
  readonly name = 'native-tts';
  initialized = false;

  #voices: TTSVoice[] = [];
  #primaryLang = 'zh';
  #currentVoiceId = '';
  #rate = TTS_RATE_DEFAULT;

  /** 检测原生桥接是否可用 */
  static isAvailable(): boolean {
    return typeof window.TTSBridge !== 'undefined';
  }

  async init(): Promise<boolean> {
    if (!NativeTTSClient.isAvailable()) {
      this.initialized = false;
      return false;
    }

    return new Promise<boolean>((resolve) => {
      let resolved = false;

      window.__onTTSInit__ = (success: boolean, voices: TTSVoice[]) => {
        if (resolved) return;
        resolved = true;
        this.initialized = success;
        if (success && Array.isArray(voices)) {
          this.#voices = voices;
        }
        resolve(success);
      };

      // 超时兜底，避免原生初始化不回调
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.initialized = false;
          window.__onTTSInit__ = undefined;
          resolve(false);
        }
      }, 5000);

      window.TTSBridge!.init();
    });
  }

  async *speak(
    ssml: string,
    signal: AbortSignal,
  ): AsyncGenerator<TTSMessageEvent> {
    const { marks } = parseSSMLMarks(ssml, this.#primaryLang);

    for (let i = 0; i < marks.length; i++) {
      if (signal.aborted) return;

      const mark = marks[i]!;
      // utteranceId 需要安全传递到 Kotlin 再拼入 JS，只保留字母数字和下划线
      const safeName = String(mark.name).replace(/[^a-zA-Z0-9_]/g, '');
      const utteranceId = `mark_${safeName}_${Date.now()}`;

      // 先通知高亮当前 mark
      yield { code: 'boundary', mark: mark.name };

      // 调用原生朗读并等待完成
      const result = await this.#speakAndWait(
        mark.text,
        mark.language,
        utteranceId,
        signal,
      );

      if (signal.aborted) return;

      if (result.code === 'error') {
        yield result;
        break;
      }

      yield result;
    }
  }

  /** 调用原生朗读一段文本，等待完成或中断 */
  #speakAndWait(
    text: string,
    lang: string,
    utteranceId: string,
    signal: AbortSignal,
  ): Promise<TTSMessageEvent> {
    return new Promise<TTSMessageEvent>((resolve) => {
      if (signal.aborted) {
        resolve({ code: 'end' });
        return;
      }

      const cleanup = () => {
        window.__onTTSEvent__ = undefined;
        signal.removeEventListener('abort', onAbort);
      };

      const onAbort = () => {
        cleanup();
        window.TTSBridge?.stop();
        resolve({ code: 'end' });
      };

      signal.addEventListener('abort', onAbort, { once: true });

      window.__onTTSEvent__ = (code: string, id: string, error: string) => {
        if (id !== utteranceId) return;

        if (code === 'end') {
          cleanup();
          resolve({ code: 'end' });
        } else if (code === 'error') {
          cleanup();
          resolve({ code: 'error', error: error || 'Native TTS error' });
        }
      };

      window.TTSBridge!.speak(text, lang, this.#rate, utteranceId);
    });
  }

  async pause(): Promise<boolean> {
    window.TTSBridge?.pause();
    return true;
  }

  async resume(): Promise<boolean> {
    // Android TextToSpeech 不支持原生 resume，由 TTSController 重新 speak
    return false;
  }

  async stop(): Promise<void> {
    window.TTSBridge?.stop();
  }

  getVoices(lang?: string): TTSVoice[] {
    if (!lang) return this.#voices;
    const prefix = lang.substring(0, 2).toLowerCase();
    return this.#voices.filter(
      (v) => v.lang.substring(0, 2).toLowerCase() === prefix,
    );
  }

  getVoiceId(): string {
    return this.#currentVoiceId;
  }

  setPrimaryLang(lang: string): void {
    this.#primaryLang = lang;
  }

  setVoice(voiceId: string): void {
    const found = this.#voices.find((v) => v.id === voiceId);
    if (found) this.#currentVoiceId = found.id;
  }

  setRate(rate: number): void {
    this.#rate = rate;
    window.TTSBridge?.setRate(rate);
  }

  getRate(): number {
    return this.#rate;
  }

  async shutdown(): Promise<void> {
    this.initialized = false;
    this.#voices = [];
    window.TTSBridge?.shutdown();
  }
}

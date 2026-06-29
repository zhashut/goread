import type { ITTSClient } from './TTSClient';
import type { TTSVoice } from './types';
import { WebSpeechSessionDriver } from './drivers/WebSpeechSessionDriver';
import {
  WEB_SPEECH_BLACKLISTED_VOICES,
  TTS_RATE_DEFAULT,
  TTS_VOICE_LOAD_TIMEOUT,
  TTS_VOICE_RETRY_DELAY,
  TTS_VOICE_MAX_RETRIES,
} from '../../constants/tts';
import { log } from '../index';

type WebSpeechVoice = SpeechSynthesisVoice & { id: string };

/**
 * Web Speech API 客户端
 * 仅负责语音查询与配置；实际朗读由 createSessionDriver() 返回的 WebSpeechSessionDriver 接管
 */
export class WebSpeechClient implements ITTSClient {
  readonly name = 'web-speech';
  initialized = false;

  #voices: WebSpeechVoice[] = [];
  #primaryLang = 'en';
  #currentVoiceId = '';
  #rate = TTS_RATE_DEFAULT;
  #synth = window.speechSynthesis;
  #allowRemoteVoices = true;
  #voiceByLang = new Map<string, WebSpeechVoice>();

  constructor(options?: { allowRemoteVoices?: boolean }) {
    this.#allowRemoteVoices = options?.allowRemoteVoices ?? true;
  }

  async init(): Promise<boolean> {
    if (!this.#synth) {
      log('[TTS] WebSpeech: speechSynthesis 不可用', 'warn');
      this.initialized = false;
      return false;
    }

    log('[TTS] WebSpeech init 开始加载语音列表', 'info');
    for (let attempt = 0; attempt < TTS_VOICE_MAX_RETRIES; attempt++) {
      await this.#loadVoices();
      if (this.#voices.length > 0) break;
      if (attempt < TTS_VOICE_MAX_RETRIES - 1) {
        log(`[TTS] 第 ${attempt + 1} 次加载语音为空，${TTS_VOICE_RETRY_DELAY}ms 后重试`, 'info');
        await new Promise((r) => setTimeout(r, TTS_VOICE_RETRY_DELAY));
      }
    }

    if (this.#voices.length === 0) {
      log('[TTS] 无可用语音', 'warn');
      this.initialized = false;
      return false;
    }

    this.initialized = true;
    return true;
  }

  /** 创建 WebSpeech 驱动，供 TTSSession 使用 */
  createSessionDriver(): WebSpeechSessionDriver {
    return new WebSpeechSessionDriver({
      getVoices: () => this.#voices,
      getVoiceId: () => this.#currentVoiceId,
      getRate: () => this.#rate,
      getPrimaryLang: () => this.#primaryLang,
    });
  }

  getVoices(lang?: string): TTSVoice[] {
    const voices = lang
      ? this.#voices.filter((v) => v.lang.substring(0, 2).toLowerCase() === lang.substring(0, 2).toLowerCase())
      : this.#voices;
    return voices.map((v) => ({ id: v.id, name: v.name, lang: v.lang }));
  }

  getVoiceId(): string {
    return this.#currentVoiceId;
  }

  setPrimaryLang(lang: string): void {
    this.#primaryLang = lang;
  }

  setVoice(voiceId: string): void {
    if (!voiceId || voiceId === 'default') {
      this.#currentVoiceId = '';
      this.#voiceByLang.clear();
      return;
    }
    const found = this.#voices.find((v) => v.id === voiceId);
    if (!found) return;
    this.#currentVoiceId = found.id;
    this.#voiceByLang.clear();
  }

  setRate(rate: number): void {
    this.#rate = rate;
  }

  getRate(): number {
    return this.#rate;
  }

  async shutdown(): Promise<void> {
    this.initialized = false;
    this.#voices = [];
    this.#voiceByLang.clear();
    try {
      this.#synth.cancel();
    } catch {}
  }

  /** 从 speechSynthesis 加载并过滤语音列表 */
  async #loadVoices(): Promise<void> {
    const rawVoices = await this.#waitForVoices();
    log(`[TTS] WebSpeech: 原始语音数=${rawVoices.length}`, 'info');
    if (rawVoices.length === 0) {
      this.#voices = [];
      return;
    }
    rawVoices.forEach((v, i) => {
      log(`[TTS]   voice[${i}]: name="${v.name}" lang="${v.lang}" local=${v.localService}`, 'info');
    });

    const filtered = rawVoices.filter(
      (v) => !WEB_SPEECH_BLACKLISTED_VOICES.some((name) => v.name.includes(name)),
    );
    let matched = filtered;
    if (!this.#allowRemoteVoices) {
      matched = matched.filter((v) => v.localService);
    }

    this.#voices = matched.map((v) => {
      const wv = v as WebSpeechVoice;
      wv.id = v.voiceURI || v.name;
      return wv;
    });
    log(`[TTS] WebSpeech: 最终可用语音数=${this.#voices.length}`, 'info');
  }

  /** 等待 speechSynthesis 返回语音列表，带超时兜底 */
  async #waitForVoices(): Promise<SpeechSynthesisVoice[]> {
    return new Promise<SpeechSynthesisVoice[]>((resolve) => {
      let resolved = false;
      const done = (voices: SpeechSynthesisVoice[]) => {
        if (resolved) return;
        resolved = true;
        this.#synth.onvoiceschanged = null;
        resolve(voices);
      };

      const voices = this.#synth.getVoices();
      if (voices.length > 0) {
        done(voices);
        return;
      }

      this.#synth.onvoiceschanged = () => {
        const v = this.#synth.getVoices();
        if (v.length > 0) done(v);
      };

      setTimeout(() => {
        const retry = this.#synth.getVoices();
        done(retry);
      }, TTS_VOICE_LOAD_TIMEOUT);
    });
  }
}


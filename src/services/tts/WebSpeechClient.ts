import type { ITTSClient } from './TTSClient';
import type { TTSMessageEvent, TTSMark, TTSVoice } from './types';
import { parseSSMLMarks } from './ssmlParser';
import {
  WEB_SPEECH_BLACKLISTED_VOICES,
  TTS_SUPPORTED_LANG_PREFIXES,
  TTS_RATE_DEFAULT,
  TTS_VOICE_LOAD_TIMEOUT,
  TTS_VOICE_RETRY_DELAY,
  TTS_VOICE_MAX_RETRIES,
} from '../../constants/tts';
import { log } from '../index';

/** 内部 boundary 事件类型 */
interface SpeechBoundaryEvent {
  type: 'boundary' | 'end' | 'error';
  mark?: string;
  error?: string;
}

/**
 * 逐 mark 朗读生成器
 * 将 SSML 解析为 mark 数组，逐个调用 speechSynthesis 朗读
 */
async function* speakWithMarks(
  ssml: string,
  primaryLang: string,
  getRate: () => number,
  getVoice: (lang: string) => SpeechSynthesisVoice | null,
  onSpeakMark: (mark: TTSMark) => void,
): AsyncGenerator<SpeechBoundaryEvent> {
  const { marks } = parseSSMLMarks(ssml, primaryLang);
  const synth = window.speechSynthesis;

  for (const mark of marks) {
    onSpeakMark(mark);
    log(`[TTS] 朗读 mark=${mark.name}, lang=${mark.language}, text="${mark.text.substring(0, 50)}${mark.text.length > 50 ? '...' : ''}"`, 'info');

    const utterance = new SpeechSynthesisUtterance(mark.text);
    utterance.rate = getRate();

    const voice = getVoice(mark.language);
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    } else if (mark.language) {
      utterance.lang = mark.language;
    }

    // 先 yield boundary 事件通知调用方高亮
    yield { type: 'boundary', mark: mark.name };

    // 等待该段朗读完成
    const result = await new Promise<SpeechBoundaryEvent>((resolve) => {
      utterance.onend = () => resolve({ type: 'end' });
      utterance.onerror = (event) => {
        // cancel() 触发的中断不视为错误
        if (event.error === 'interrupted' || event.error === 'canceled') {
          resolve({ type: 'end' });
        } else {
          resolve({ type: 'error', error: event.error });
        }
      };
      synth.speak(utterance);
    });

    yield result;
    if (result.type === 'error') break;
  }
}

type WebSpeechVoice = SpeechSynthesisVoice & { id: string };

/**
 * Web Speech API 客户端
 * 使用浏览器/系统原生 TTS 引擎朗读，仅支持中文和英文
 */
export class WebSpeechClient implements ITTSClient {
  readonly name = 'web-speech';
  initialized = false;

  #voices: WebSpeechVoice[] = [];
  #primaryLang = 'en';
  #currentVoiceId = '';
  #rate = TTS_RATE_DEFAULT;
  #synth = window.speechSynthesis;

  /** 按语言缓存的语音映射 */
  #voiceByLang = new Map<string, WebSpeechVoice>();

  async init(): Promise<boolean> {
    if (!this.#synth) {
      log('[TTS] WebSpeech: speechSynthesis 不可用', 'warn');
      this.initialized = false;
      return false;
    }

    log('[TTS] WebSpeech init 开始加载语音列表', 'info');

    // 多次重试加载语音列表，应对部分 WebView 首次加载慢的问题
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

  /** 从 speechSynthesis 加载并过滤语音列表 */
  async #loadVoices(): Promise<void> {
    const rawVoices = await this.#waitForVoices();
    log(`[TTS] WebSpeech: 原始语音数=${rawVoices.length}`, 'info');
    if (rawVoices.length === 0) {
      this.#voices = [];
      return;
    }

    // 打印所有原始语音，方便排查
    rawVoices.forEach((v, i) => {
      log(`[TTS]   voice[${i}]: name="${v.name}" lang="${v.lang}" local=${v.localService}`, 'info');
    });

    // 排除黑名单语音
    const filtered = rawVoices.filter(
      (v) => !WEB_SPEECH_BLACKLISTED_VOICES.some((name) => v.name.includes(name)),
    );

    // 优先使用中英文语音
    let matched = filtered.filter((v) => {
      const prefix = v.lang.substring(0, 2).toLowerCase();
      return TTS_SUPPORTED_LANG_PREFIXES.includes(prefix);
    });

    // 如果中英文语音为空，放宽到全部可用语音（总比啥都没有强）
    if (matched.length === 0 && filtered.length > 0) {
      log(`[TTS] 无中英文语音，放宽到全部 ${filtered.length} 个可用语音`, 'info');
      matched = filtered;
    }

    this.#voices = matched.map((v) => {
      const wv = v as WebSpeechVoice;
      wv.id = v.voiceURI || v.name;
      return wv;
    });
    log(`[TTS] WebSpeech: 最终可用语音数=${this.#voices.length}`, 'info');
  }

  /** 等待 speechSynthesis 返回语音列表 */
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

      // 监听 voiceschanged 事件，部分平台需要异步加载语音列表
      this.#synth.onvoiceschanged = () => {
        const v = this.#synth.getVoices();
        if (v.length > 0) done(v);
      };

      // 超时兜底：避免 voiceschanged 不触发导致永远挂起
      setTimeout(() => {
        const retry = this.#synth.getVoices();
        done(retry);
      }, TTS_VOICE_LOAD_TIMEOUT);
    });
  }

  /** 根据语言获取最匹配的语音 */
  #getVoiceForLang(lang: string): SpeechSynthesisVoice | null {
    const prefix = lang.substring(0, 2).toLowerCase();
    const cached = this.#voiceByLang.get(prefix);
    if (cached) return cached;

    // 如果有指定语音，优先用
    if (this.#currentVoiceId) {
      const selected = this.#voices.find((v) => v.id === this.#currentVoiceId);
      if (selected && selected.lang.substring(0, 2).toLowerCase() === prefix) {
        return selected;
      }
    }

    // 否则找该语言的第一个可用语音
    const match = this.#voices.find(
      (v) => v.lang.substring(0, 2).toLowerCase() === prefix,
    );
    if (match) {
      this.#voiceByLang.set(prefix, match);
    }
    return match || null;
  }

  async *speak(
    ssml: string,
    signal: AbortSignal,
  ): AsyncGenerator<TTSMessageEvent> {
    for await (const ev of speakWithMarks(
      ssml,
      this.#primaryLang,
      () => this.#rate,
      (lang) => this.#getVoiceForLang(lang),
      () => { /* mark 通知由 TTSController 统一处理 */ },
    )) {
      if (signal.aborted) {
        this.#synth.cancel();
        return;
      }
      if (ev.type === 'boundary') {
        yield { code: 'boundary', mark: ev.mark ?? '' };
      } else if (ev.type === 'error') {
        yield { code: 'error', error: ev.error ?? 'Unknown error' };
      } else if (ev.type === 'end') {
        yield { code: 'end' };
      }
    }
  }

  async pause(): Promise<boolean> {
    this.#synth.pause();
    return true;
  }

  async resume(): Promise<boolean> {
    this.#synth.resume();
    return true;
  }

  async stop(): Promise<void> {
    this.#synth.cancel();
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
    const found = this.#voices.find((v) => v.id === voiceId);
    if (found) {
      this.#currentVoiceId = found.id;
      // 清除缓存，让新语音生效
      this.#voiceByLang.clear();
    }
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
    await this.stop();
  }
}

import type {
  IBackendSessionDriver,
} from '../providers/TTSContentProvider';
import type {
  TTSSegment,
  TTSSessionListeners,
} from '../types';
import { log, logError } from '../../index';

/** WebSpeechSessionDriver 的依赖：从 WebSpeechClient 注入语音、语速等 */
export interface WebSpeechSessionDriverOptions {
  /** 当前可用 voices（含 voiceURI） */
  getVoices: () => SpeechSynthesisVoice[];
  /** 当前 voiceId（空表示系统默认） */
  getVoiceId: () => string;
  /** 当前语速 */
  getRate: () => number;
  /** 主语言（用于挑选 voice 兜底） */
  getPrimaryLang: () => string;
}

/**
 * 桌面 / 浏览器端的"前端 mini 会话"驱动：
 * - 不走任何原生命令
 * - 内部维护朗读队列与 utterance 循环
 * - 通过 IBackendSessionDriver 协议向 TTSSession 上抛 session_* 事件
 * - 不承诺后台连续朗读，仅服务前台
 */
export class WebSpeechSessionDriver implements IBackendSessionDriver {
  #options: WebSpeechSessionDriverOptions;
  #synth: SpeechSynthesis;
  #queue: TTSSegment[] = [];
  #current: TTSSegment | null = null;
  #playing = false;
  #paused = false;
  #endOfBook = false;
  #listeners: TTSSessionListeners | null = null;
  #pendingMore = false;
  #lowWatermark = 4;

  constructor(options: WebSpeechSessionDriverOptions) {
    this.#options = options;
    this.#synth = window.speechSynthesis;
  }

  supportsSession(): boolean {
    return typeof window !== 'undefined' && !!window.speechSynthesis;
  }

  async sessionStart(payload: {
    segments: TTSSegment[];
    rate: number;
    voiceId?: string;
    lang?: string;
    endOfBook: boolean;
  }): Promise<void> {
    this.#stopInternal();
    this.#queue = [...payload.segments];
    this.#endOfBook = payload.endOfBook;
    this.#paused = false;
    this.#playing = true;
    log(`[TTS][WebSpeechSession] start: segments=${payload.segments.length} endOfBook=${payload.endOfBook}`, 'info');
    this.#playNext();
  }

  async sessionPush(segments: TTSSegment[]): Promise<void> {
    if (segments.length === 0) return;
    this.#queue.push(...segments);
    this.#pendingMore = false;
    log(`[TTS][WebSpeechSession] push: segments=${segments.length} queued=${this.#queue.length}`, 'info');
    if (this.#playing && !this.#paused && !this.#current) {
      this.#playNext();
    }
  }

  async sessionStop(): Promise<void> {
    log('[TTS][WebSpeechSession] stop', 'info');
    this.#stopInternal();
    this.#listeners?.onEnd?.({ reason: 'stopped' });
  }

  async sessionPause(): Promise<void> {
    if (!this.#playing || this.#paused) return;
    this.#paused = true;
    try {
      this.#synth.pause();
    } catch {}
    this.#listeners?.onPaused?.({
      segmentId: this.#current?.id,
      cursor: this.#current?.cursor,
    });
  }

  async sessionResume(): Promise<void> {
    if (!this.#paused) return;
    this.#paused = false;
    try {
      this.#synth.resume();
    } catch {}
    this.#listeners?.onResumed?.({
      segmentId: this.#current?.id,
      cursor: this.#current?.cursor,
    });
  }

  async sessionSetRate(_rate: number): Promise<void> {
    // 实际语速由 getRate() 在下一次 utterance 创建时读取
  }

  async sessionSetVoice(_voiceId: string): Promise<void> {
    // 实际语音由 getVoiceId() 在下一次 utterance 创建时读取
  }

  async sessionSetEndOfBook(flag: boolean): Promise<void> {
    this.#endOfBook = flag;
    if (flag && this.#queue.length === 0 && !this.#current) {
      this.#listeners?.onEnd?.({ reason: 'completed' });
      this.#playing = false;
    }
  }

  subscribeSession(listeners: TTSSessionListeners): () => void {
    this.#listeners = listeners;
    return () => {
      if (this.#listeners === listeners) {
        this.#listeners = null;
      }
    };
  }

  #stopInternal(): void {
    this.#playing = false;
    this.#paused = false;
    this.#queue = [];
    this.#current = null;
    this.#pendingMore = false;
    try {
      this.#synth.cancel();
    } catch {}
  }

  #playNext(): void {
    if (!this.#playing || this.#paused) return;

    const segment = this.#queue.shift() ?? null;
    if (!segment) {
      this.#current = null;
      if (this.#endOfBook) {
        this.#playing = false;
        this.#listeners?.onEnd?.({ reason: 'completed' });
        return;
      }
      this.#requestMoreIfNeeded(true);
      this.#listeners?.onWaitingMore?.({});
      return;
    }

    this.#current = segment;
    this.#requestMoreIfNeeded(false);

    let utterance: SpeechSynthesisUtterance;
    try {
      utterance = new SpeechSynthesisUtterance(segment.text);
    } catch (e) {
      logError('[TTS][WebSpeechSession] 创建 utterance 失败', e);
      this.#current = null;
      this.#playNext();
      return;
    }
    utterance.rate = this.#options.getRate();
    const voice = this.#pickVoice(segment.lang);
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    } else if (segment.lang) {
      utterance.lang = segment.lang;
    } else {
      utterance.lang = this.#options.getPrimaryLang();
    }

    utterance.onstart = () => {
      this.#listeners?.onProgress?.({
        segmentId: segment.id,
        sectionIndex: segment.sectionIndex,
        chunkIndex: segment.chunkIndex,
        cursor: segment.cursor,
        anchor: segment.anchor ?? null,
      });
    };
    utterance.onend = () => {
      if (!this.#playing) return;
      this.#listeners?.onSegmentDone?.({
        segmentId: segment.id,
        cursor: segment.cursor,
      });
      this.#current = null;
      this.#playNext();
    };
    utterance.onerror = (event) => {
      if (event.error === 'canceled') {
        // 主动取消（sessionStop），不做任何处理
        return;
      }
      if (event.error === 'interrupted') {
        // 窗口失焦等外部中断：若仍在播放则重新朗读当前 segment
        if (this.#playing && !this.#paused && this.#current === segment) {
          try {
            this.#synth.cancel();
          } catch {}
          setTimeout(() => {
            if (this.#playing && !this.#paused && this.#current === segment) {
              try {
                this.#synth.speak(utterance);
              } catch {
                this.#current = null;
                this.#playNext();
              }
            }
          }, 100);
        }
        return;
      }
      logError(`[TTS][WebSpeechSession] utterance error: ${event.error}`, event);
      this.#current = null;
      this.#playNext();
    };

    try {
      this.#synth.speak(utterance);
    } catch (e) {
      logError('[TTS][WebSpeechSession] synth.speak 失败', e);
      this.#current = null;
      this.#playNext();
    }
  }

  #pickVoice(lang?: string): SpeechSynthesisVoice | null {
    const voices = this.#options.getVoices();
    if (voices.length === 0) return null;
    const voiceId = this.#options.getVoiceId();
    if (voiceId) {
      const found = voices.find((v) => (v.voiceURI || v.name) === voiceId);
      if (found) return found;
    }
    const target = (lang || this.#options.getPrimaryLang() || '').substring(0, 2).toLowerCase();
    if (!target) return voices[0] ?? null;
    return voices.find((v) => v.lang.substring(0, 2).toLowerCase() === target) || voices[0] || null;
  }

  #requestMoreIfNeeded(force: boolean): void {
    if (this.#endOfBook) return;
    if (this.#pendingMore) return;
    if (!force && this.#queue.length > this.#lowWatermark) return;
    this.#pendingMore = true;
    this.#listeners?.onRequestMore?.({
      remaining: this.#queue.length,
      cursor: this.#current?.cursor,
    });
  }
}


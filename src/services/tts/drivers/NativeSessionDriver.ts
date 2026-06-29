import type {
  IBackendSessionDriver,
} from '../providers/TTSContentProvider';
import type { BackendTTSRequest } from '../providers/TTSContentProvider';
import type {
  TTSSegment,
  TTSSessionEndEvent,
  TTSSessionEndReason,
  TTSSessionListeners,
  TTSSessionPauseStateEvent,
  TTSSessionProgressEvent,
  TTSSessionRequestMoreEvent,
  TTSSessionSegmentDoneEvent,
  TTSSessionWaitingMoreEvent,
} from '../types';
import {
  invokeTTSManagedSessionPause,
  invokeTTSManagedSessionResume,
  invokeTTSManagedSessionSetRate,
  invokeTTSManagedSessionSetVoice,
  invokeTTSManagedSessionStart,
  invokeTTSManagedSessionStop,
} from '../providers/backendBridge';
import { loadTauriCore } from '../core/tauriCore';
import { log, logError } from '../../index';

/** 注入给 NativeSessionDriver 的最小依赖 */
export interface NativeSessionDriverOptions {
  /** 仅 plugin 模式可用 */
  isPluginMode: () => boolean;
  /** 把语言映射到 BCP47 */
  toBCP47: (lang: string) => string;
  /** 当前主语言（启动时使用） */
  getPrimaryLang: () => string;
  /** 当前语速 */
  getRate: () => number;
  /** 当前语音 ID */
  getVoiceId: () => string;
}

type NativeEventPayload = {
  code?: string;
  segmentId?: string;
  sectionIndex?: number;
  chunkIndex?: number;
  cursor?: string;
  remaining?: number;
  estimatedSeconds?: number;
  reason?: string;
  message?: string;
  prevEngine?: string;
  engine?: string;
  anchor?: { quote?: string; prefix?: string; suffix?: string } | null;
};

/**
 * 原生 Android 后端会话驱动：把 IBackendSessionDriver 协议映射到
 * `native_tts_session_*` 主进程包装命令与 `tts_events` 事件通道。
 */
export class NativeSessionDriver implements IBackendSessionDriver {
  #options: NativeSessionDriverOptions;
  #listeners: TTSSessionListeners | null = null;
  #pluginListener: any = null;

  constructor(options: NativeSessionDriverOptions) {
    this.#options = options;
  }

  supportsSession(): boolean {
    return this.#options.isPluginMode();
  }

  supportsManagedSession(): boolean {
    return this.#options.isPluginMode();
  }

  async managedSessionStart(payload: {
    request: BackendTTSRequest;
    rate: number;
    voiceId?: string;
    lang?: string;
    lowWatermarkSeconds?: number;
  }): Promise<void> {
    await invokeTTSManagedSessionStart(payload);
    log('[TTS][NativeSession] managed_session_start', 'info');
  }

  async managedSessionStop(): Promise<void> {
    await invokeTTSManagedSessionStop();
  }

  async managedSessionPause(): Promise<void> {
    await invokeTTSManagedSessionPause();
  }

  async managedSessionResume(): Promise<void> {
    await invokeTTSManagedSessionResume();
  }

  async managedSessionSetRate(rate: number): Promise<void> {
    await invokeTTSManagedSessionSetRate(rate);
  }

  async managedSessionSetVoice(voiceId: string): Promise<void> {
    await invokeTTSManagedSessionSetVoice(voiceId);
  }

  async sessionStart(payload: {
    segments: TTSSegment[];
    rate: number;
    voiceId?: string;
    lang?: string;
    endOfBook: boolean;
  }): Promise<void> {
    const core = await loadTauriCore();
    if (!core?.invoke) throw new Error('Native TTS core invoke unavailable');
    await core.invoke('native_tts_session_start', {
      payload: {
        segments: this.#toNativeSegments(payload.segments),
        rate: payload.rate,
        voiceId: payload.voiceId || this.#options.getVoiceId() || undefined,
        lang: payload.lang
          ? this.#options.toBCP47(payload.lang)
          : this.#options.toBCP47(this.#options.getPrimaryLang()),
        endOfBook: payload.endOfBook,
      },
    });
    log(`[TTS][NativeSession] session_start: segments=${payload.segments.length} endOfBook=${payload.endOfBook}`, 'info');
  }

  async sessionPush(segments: TTSSegment[]): Promise<void> {
    if (segments.length === 0) return;
    const core = await loadTauriCore();
    if (!core?.invoke) return;
    await core.invoke('native_tts_session_push', {
      payload: { segments: this.#toNativeSegments(segments) },
    });
    log(`[TTS][NativeSession] session_push: segments=${segments.length}`, 'info');
  }

  async sessionStop(): Promise<void> {
    const core = await loadTauriCore();
    if (!core?.invoke) return;
    await core.invoke('native_tts_session_stop').catch(() => {});
  }

  async sessionPause(): Promise<void> {
    const core = await loadTauriCore();
    if (!core?.invoke) return;
    await core.invoke('native_tts_session_pause').catch(() => {});
  }

  async sessionResume(): Promise<void> {
    const core = await loadTauriCore();
    if (!core?.invoke) return;
    await core.invoke('native_tts_session_resume').catch(() => {});
  }

  async sessionSetRate(rate: number): Promise<void> {
    const core = await loadTauriCore();
    if (!core?.invoke) return;
    await core.invoke('native_tts_session_set_rate', {
      payload: { rate },
    }).catch(() => {});
  }

  async sessionSetVoice(voiceId: string): Promise<void> {
    const core = await loadTauriCore();
    if (!core?.invoke) return;
    await core.invoke('native_tts_session_set_voice', {
      payload: { voice: voiceId },
    }).catch(() => {});
  }

  async sessionSetEndOfBook(flag: boolean): Promise<void> {
    const core = await loadTauriCore();
    if (!core?.invoke) return;
    await core.invoke('native_tts_session_set_end_of_book', {
      payload: { endOfBook: flag },
    }).catch(() => {});
  }

  subscribeSession(listeners: TTSSessionListeners): () => void {
    this.#listeners = listeners;
    void this.#ensurePluginListener();
    return () => {
      if (this.#listeners === listeners) {
        this.#listeners = null;
      }
    };
  }

  /** 收到 NativeTTSPlugin tts_events 事件后由外部转发进来 */
  handleEvent(event: NativeEventPayload): boolean {
    if (!event || typeof event.code !== 'string') return false;
    const code = event.code;
    const listeners = this.#listeners;
    if (!listeners) return false;
    switch (code) {
      case 'session_progress': {
        const payload: TTSSessionProgressEvent = {
          segmentId: event.segmentId ?? '',
          sectionIndex: event.sectionIndex ?? 0,
          chunkIndex: event.chunkIndex ?? 0,
          cursor: event.cursor,
          anchor: event.anchor && event.anchor.quote
            ? {
                quote: event.anchor.quote,
                prefix: event.anchor.prefix,
                suffix: event.anchor.suffix,
              }
            : null,
        };
        listeners.onProgress?.(payload);
        return true;
      }
      case 'session_request_more': {
        const payload: TTSSessionRequestMoreEvent = {
          remaining: event.remaining ?? 0,
          estimatedSeconds: event.estimatedSeconds,
          cursor: event.cursor,
        };
        listeners.onRequestMore?.(payload);
        return true;
      }
      case 'session_waiting_more': {
        const payload: TTSSessionWaitingMoreEvent = { cursor: event.cursor };
        listeners.onWaitingMore?.(payload);
        return true;
      }
      case 'session_segment_done': {
        const payload: TTSSessionSegmentDoneEvent = {
          segmentId: event.segmentId ?? '',
          cursor: event.cursor,
        };
        listeners.onSegmentDone?.(payload);
        return true;
      }
      case 'session_paused': {
        const payload: TTSSessionPauseStateEvent = {
          segmentId: event.segmentId,
          cursor: event.cursor,
        };
        listeners.onPaused?.(payload);
        return true;
      }
      case 'session_resumed': {
        const payload: TTSSessionPauseStateEvent = {
          segmentId: event.segmentId,
          cursor: event.cursor,
        };
        listeners.onResumed?.(payload);
        return true;
      }
      case 'session_end': {
        const reason: TTSSessionEndReason =
          event.reason === 'completed' ||
          event.reason === 'stopped' ||
          event.reason === 'error' ||
          event.reason === 'stalled'
            ? event.reason
            : 'stopped';
        const payload: TTSSessionEndEvent = { reason, message: event.message };
        listeners.onEnd?.(payload);
        return true;
      }
      case 'engine_changed':
      case 'session_engine_changed': {
        listeners.onEngineChanged?.({
          prevEngine: event.prevEngine,
          engine: event.engine,
        });
        return true;
      }
      default:
        return false;
    }
  }

  /** 注销监听器（由 NativeTTSClient 在 shutdown 时调用） */
  async detach(): Promise<void> {
    this.#listeners = null;
    if (!this.#pluginListener) return;
    try {
      const l = this.#pluginListener;
      if (typeof l === 'function') l();
      else if (typeof l?.unlisten === 'function') l.unlisten();
      else if (typeof l?.unregister === 'function') l.unregister();
    } catch {}
    this.#pluginListener = null;
  }

  async #ensurePluginListener(): Promise<void> {
    if (this.#pluginListener) return;
    const core = await loadTauriCore();
    if (!core?.addPluginListener) return;
    try {
      this.#pluginListener = await core.addPluginListener(
        'native-tts',
        'tts_events',
        (event: NativeEventPayload) => {
          this.handleEvent(event);
        },
      );
      log('[TTS][NativeSession] plugin 事件监听已注册', 'info');
    } catch (e) {
      logError('[TTS][NativeSession] 事件监听注册失败', e);
      this.#pluginListener = null;
    }
  }

  #toNativeSegments(segments: TTSSegment[]): Array<{
    id: string;
    text: string;
    lang?: string;
    sectionIndex: number;
    chunkIndex: number;
    cursor?: string;
    anchor?: { quote: string; prefix?: string; suffix?: string } | null;
  }> {
    return segments.map((seg) => ({
      id: seg.id,
      text: seg.text,
      lang: seg.lang ? this.#options.toBCP47(seg.lang) : undefined,
      sectionIndex: seg.sectionIndex,
      chunkIndex: seg.chunkIndex,
      cursor: seg.cursor,
      anchor: seg.anchor
        ? {
            quote: seg.anchor.quote,
            prefix: seg.anchor.prefix,
            suffix: seg.anchor.suffix,
          }
        : null,
    }));
  }
}

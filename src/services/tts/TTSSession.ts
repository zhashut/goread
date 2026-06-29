import type {
  TTSReadingAnchor,
  TTSSessionEndEvent,
  TTSSessionListeners,
  TTSSessionPauseStateEvent,
  TTSSessionProgressEvent,
  TTSSessionRequestMoreEvent,
  TTSSessionSegmentDoneEvent,
  TTSState,
} from './types';
import type {
  IBackendSessionDriver,
  TTSContentProvider,
} from './providers/TTSContentProvider';
import { TTSSessionRefiller, type TTSSessionRefillHint } from './TTSSessionRefiller';
import { HighlightManager } from './core/highlightManager';
import { log, logError } from '../index';

/** 会话内可观察事件回调 */
export type TTSSessionStateChangeCallback = (state: TTSState) => void;
export type TTSSessionReadingActivityCallback = () => void;
export type TTSSessionEndedCallback = (event: TTSSessionEndEvent) => void;

/** 会话启动参数 */
export interface TTSSessionStartOptions {
  rate: number;
  voiceId?: string;
  lang?: string;
  /** 单批次最大 segment 数量（也是首批下发上限） */
  batchSize?: number;
  /** 用户当前阅读位置（章节索引），cursor=null 时使用 */
  startSectionIndex?: number;
  /** 用户当前阅读位置 anchor，用于从用户实际朗读处开始 */
  startAnchor?: TTSReadingAnchor | null;
}

const DEFAULT_BATCH_SIZE = 60;
const ACTIVITY_THROTTLE_MS = 3 * 1000;
const FOREGROUND_REALIGN_COOLDOWN_MS = 500;

/**
 * 新版 TTS 会话调度器
 * - 依赖 TTSContentProvider 取内容
 * - 依赖 IBackendSessionDriver 下发命令、订阅事件
 * - Refill 子模块负责补给，本类只管生命周期、状态、高亮
 */
export class TTSSession {
  #provider: TTSContentProvider;
  #driver: IBackendSessionDriver;
  #onStateChange?: TTSSessionStateChangeCallback;
  #onReadingActivity?: TTSSessionReadingActivityCallback;
  #onEnded?: TTSSessionEndedCallback;

  #state: TTSState = 'stopped';
  #unsubscribe: (() => void) | null = null;
  #disposed = false;
  #refiller: TTSSessionRefiller | null = null;
  #highlightManager = new HighlightManager();
  #latestSectionIndex = -1;
  #latestAnchor: TTSReadingAnchor | null = null;
  #lastActivityNotifyTs = 0;
  #batchSize = DEFAULT_BATCH_SIZE;
  #managed = false;
  /** 是否收到过 progress 事件（用于判断 shutdown 时是否需要恢复阅读位置） */
  #hasReceivedProgress = false;
  #lastForegroundRealignTs = 0;

  constructor(
    provider: TTSContentProvider,
    driver: IBackendSessionDriver,
    onStateChange?: TTSSessionStateChangeCallback,
    onReadingActivity?: TTSSessionReadingActivityCallback,
    onEnded?: TTSSessionEndedCallback,
  ) {
    this.#provider = provider;
    this.#driver = driver;
    this.#onStateChange = onStateChange;
    this.#onReadingActivity = onReadingActivity;
    this.#onEnded = onEnded;
  }

  /** 启动会话；返回是否成功开始播放 */
  async start(options: TTSSessionStartOptions): Promise<boolean> {
    if (this.#disposed) return false;
    if (!this.#driver.supportsSession()) {
      log('[TTSSession] driver 不支持会话协议，无法启动', 'warn');
      return false;
    }

    this.#batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
    log(
      `[TTSSession] start: format=${this.#provider.format} rate=${options.rate} voiceId=${options.voiceId ?? ''} lang=${options.lang ?? ''} batchSize=${this.#batchSize}`,
      'info',
    );

    const managedStart = this.#driver.managedSessionStart;
    const hasManaged =
      typeof this.#driver.supportsManagedSession === 'function' &&
      this.#driver.supportsManagedSession() &&
      typeof managedStart === 'function';

    if (hasManaged) {
      const hasExplicitStart =
        options.startSectionIndex != null || options.startAnchor != null;
      const startPosition =
        hasExplicitStart
          ? {
              sectionIndex: options.startSectionIndex ?? 0,
              anchor: options.startAnchor ?? null,
            }
          : undefined;
      const request = this.#provider.buildBackendRequest({
        cursor: null,
        maxSegments: this.#batchSize,
        startPosition,
      });
      if (!request) {
        log('[TTSSession] 托管会话请求构造失败', 'warn');
        return false;
      }

      this.#managed = true;
      this.#unsubscribe = this.#driver.subscribeSession(this.#buildListeners());
      try {
        await managedStart({
          request,
          rate: options.rate,
          voiceId: options.voiceId,
          lang: options.lang,
        });
      } catch (e) {
        logError('[TTSSession] managedSessionStart 调用失败', e);
        this.#cleanupListeners();
        this.#managed = false;
        return false;
      }
      this.#setState('playing');
      this.#bindVisibilityListener();
      return true;
    }

    const refiller = new TTSSessionRefiller({
      provider: this.#provider,
      driver: this.#driver,
      batchSize: this.#batchSize,
    });
    const hasExplicitStart =
      options.startSectionIndex != null || options.startAnchor != null;
    const first = await refiller.loadFirst(
      this.#batchSize,
      hasExplicitStart
        ? {
            sectionIndex: options.startSectionIndex ?? 0,
            anchor: options.startAnchor ?? null,
          }
        : undefined,
    );
    if (this.#disposed || !first || first.segments.length === 0) {
      log('[TTSSession] 首批为空，放弃启动', 'warn');
      return false;
    }

    this.#refiller = refiller;
    this.#unsubscribe = this.#driver.subscribeSession(this.#buildListeners());

    try {
      await this.#driver.sessionStart({
        segments: first.segments,
        rate: options.rate,
        voiceId: options.voiceId,
        lang: options.lang,
        endOfBook: first.endOfBook,
      });
    } catch (e) {
      logError('[TTSSession] sessionStart 调用失败', e);
      this.#cleanupListeners();
      return false;
    }

    this.#setState('playing');
    this.#bindVisibilityListener();
    return true;
  }

  async pause(): Promise<void> {
    if (this.#disposed || this.#state !== 'playing') return;
    try {
      if (this.#managed && this.#driver.managedSessionPause) {
        await this.#driver.managedSessionPause();
      } else {
        await this.#driver.sessionPause();
      }
      this.#setState('paused');
    } catch (e) {
      logError('[TTSSession] sessionPause 失败', e);
    }
  }

  async resume(): Promise<void> {
    if (this.#disposed || this.#state !== 'paused') return;
    try {
      if (this.#managed && this.#driver.managedSessionResume) {
        await this.#driver.managedSessionResume();
      } else {
        await this.#driver.sessionResume();
      }
      this.#setState('playing');
    } catch (e) {
      logError('[TTSSession] sessionResume 失败', e);
    }
  }

  async setRate(rate: number): Promise<void> {
    if (this.#disposed) return;
    try {
      if (this.#managed && this.#driver.managedSessionSetRate) {
        await this.#driver.managedSessionSetRate(rate);
      } else {
        await this.#driver.sessionSetRate(rate);
      }
    } catch (e) {
      logError('[TTSSession] sessionSetRate 失败', e);
    }
  }

  async setVoice(voiceId: string): Promise<void> {
    if (this.#disposed) return;
    try {
      if (this.#managed && this.#driver.managedSessionSetVoice) {
        await this.#driver.managedSessionSetVoice(voiceId);
      } else {
        await this.#driver.sessionSetVoice(voiceId);
      }
    } catch (e) {
      logError('[TTSSession] sessionSetVoice 失败', e);
    }
  }

  /** 文档变化（如翻页/章节重新渲染） */
  notifyDocumentUpdated(): void {
    if (this.#disposed) return;
    try {
      this.#provider.notifyDocumentUpdated();
    } catch (e) {
      logError('[TTSSession] provider.notifyDocumentUpdated 失败', e);
    }
  }

  /** 主动停止时保持当前页面位置，不再做停止后的回跳恢复 */
  async shutdown(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    log('[TTSSession] shutdown', 'info');
    try {
      if (this.#managed && this.#driver.managedSessionStop) {
        await this.#driver.managedSessionStop();
      } else {
        await this.#driver.sessionStop();
      }
    } catch (e) {
      logError('[TTSSession] sessionStop 失败', e);
    }
    this.#cleanupListeners();
    this.#highlightManager.clear();
    this.#setState('stopped');
  }

  getState(): TTSState {
    return this.#state;
  }

  #buildListeners(): TTSSessionListeners {
    return {
      onProgress: (event) => this.#handleProgress(event),
      onRequestMore: (event) => this.#handleRefillTrigger('request_more', event),
      onWaitingMore: () => this.#handleRefillTrigger('waiting_more'),
      onSegmentDone: (event) => this.#handleSegmentDone(event),
      onPaused: (event) => this.#handlePaused(event),
      onResumed: (event) => this.#handleResumed(event),
      onEnd: (event) => this.#handleEnd(event),
      onEngineChanged: () => this.#handleEngineChanged(),
    };
  }

  #handleProgress(event: TTSSessionProgressEvent): void {
    if (this.#disposed) return;
    this.#hasReceivedProgress = true;
    this.#notifyActivity();
    const previousSectionIndex = this.#latestSectionIndex;
    this.#latestSectionIndex = event.sectionIndex;
    this.#latestAnchor = event.anchor ?? null;
    void this.#handleProgressAsync(event, previousSectionIndex);
  }

  async #handleProgressAsync(
    event: TTSSessionProgressEvent,
    previousSectionIndex: number,
  ): Promise<void> {
    try {
      await this.#provider.followProgressPosition?.(
        {
          sectionIndex: event.sectionIndex,
          anchor: event.anchor ?? null,
        },
        previousSectionIndex,
      );
      this.#applyReadingPosition(event.sectionIndex, event.anchor, true);
    } catch (e) {
      logError('[TTSSession] locateAnchor / highlight 异常', e);
    }
  }

  #handleRefillTrigger(
    reason: 'request_more' | 'waiting_more',
    event?: TTSSessionRequestMoreEvent,
  ): void {
    const hint: TTSSessionRefillHint | undefined =
      event?.estimatedSeconds != null
        ? { estimatedSeconds: event.estimatedSeconds }
        : undefined;
    const tail = hint ? ` estimatedSeconds=${hint.estimatedSeconds}` : '';
    log(`[TTSSession] refill trigger: ${reason}${tail}`, 'info');
    void this.#refiller?.refill(hint);
  }

  #handleSegmentDone(event: TTSSessionSegmentDoneEvent): void {
    this.#refiller?.notifySegmentDone(event.cursor);
  }

  #handlePaused(_event: TTSSessionPauseStateEvent): void {
    this.#setState('paused');
  }

  #handleResumed(_event: TTSSessionPauseStateEvent): void {
    this.#setState('playing');
  }

  #handleEnd(event: TTSSessionEndEvent): void {
    if (this.#disposed) return;
    log(`[TTSSession] session_end reason=${event.reason}`, 'info');
    this.#disposed = true;
    if (this.#managed && this.#driver.managedSessionStop) {
      void this.#driver.managedSessionStop();
    }
    this.#cleanupListeners();
    this.#highlightManager.clear();
    void this.#restoreAfterSessionEnd(event);
    this.#setState('stopped');
    try {
      this.#onEnded?.(event);
    } catch (e) {
      logError('[TTSSession] onEnded 异常', e);
    }
  }

  #handleEngineChanged(): void {
    this.#handleEnd({ reason: 'error', message: 'engine_changed' });
  }

  async #restoreAfterSessionEnd(event: TTSSessionEndEvent): Promise<void> {
    if (event.reason === 'completed') return;
    await this.#restoreLatestReadingPosition();
  }

  async #restoreLatestReadingPosition(): Promise<void> {
    // 只有成功播放过才恢复阅读位置，避免启动失败时跳到错误位置
    if (!this.#hasReceivedProgress) return;
    if (this.#latestSectionIndex < 0) return;
    try {
      await this.#provider.restoreReadingPosition({
        sectionIndex: this.#latestSectionIndex,
        anchor: this.#latestAnchor,
      });
    } catch (e) {
      logError('[TTSSession] restoreReadingPosition 失败', e);
    }
  }

  #setState(next: TTSState): void {
    if (this.#state === next) return;
    this.#state = next;
    try {
      this.#onStateChange?.(next);
    } catch (e) {
      logError('[TTSSession] onStateChange 异常', e);
    }
  }

  #cleanupListeners(): void {
    this.#unbindVisibilityListener();
    if (this.#refiller) {
      this.#refiller.dispose();
      this.#refiller = null;
    }
    if (this.#unsubscribe) {
      try {
        this.#unsubscribe();
      } catch {}
      this.#unsubscribe = null;
    }
  }

  #notifyActivity(): void {
    if (!this.#onReadingActivity) return;
    const now = Date.now();
    if (now - this.#lastActivityNotifyTs < ACTIVITY_THROTTLE_MS) return;
    this.#lastActivityNotifyTs = now;
    try {
      this.#onReadingActivity();
    } catch (e) {
      logError('[TTSSession] onReadingActivity 异常', e);
    }
  }

  #bindVisibilityListener(): void {
    if (typeof document === 'undefined') return;
    document.addEventListener('visibilitychange', this.#handleVisibilityChange);
  }

  #unbindVisibilityListener(): void {
    if (typeof document === 'undefined') return;
    document.removeEventListener('visibilitychange', this.#handleVisibilityChange);
  }

  #handleVisibilityChange = (): void => {
    if (typeof document === 'undefined' || document.hidden) return;
    if (this.#disposed || this.#state !== 'playing') return;
    if (!this.#hasReceivedProgress || this.#latestSectionIndex < 0) return;
    const now = Date.now();
    if (now - this.#lastForegroundRealignTs < FOREGROUND_REALIGN_COOLDOWN_MS) return;
    this.#lastForegroundRealignTs = now;
    const applied = this.#applyReadingPosition(this.#latestSectionIndex, this.#latestAnchor, false);
    if (applied) {
      log(
        `[TTSSession] foreground realign sectionIndex=${this.#latestSectionIndex}`,
        'info',
      );
    }
  };

  #applyReadingPosition(
    sectionIndex: number,
    anchor: TTSReadingAnchor | null | undefined,
    clearOnMiss: boolean,
  ): boolean {
    const range = this.#provider.locateAnchor(sectionIndex, anchor);
    if (!range) {
      if (clearOnMiss) {
        this.#highlightManager.clear();
      }
      return false;
    }
    this.#highlightManager.apply(range);
    this.#highlightManager.maybeScrollIntoView(range);
    return true;
  }
}

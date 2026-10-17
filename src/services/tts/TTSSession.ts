import type {
  TTSReadingAnchor,
  TTSSessionEndEvent,
  TTSSessionListeners,
  TTSSessionPauseStateEvent,
  TTSSessionProgressEvent,
  TTSSessionRequestMoreEvent,
  TTSSessionSegmentDoneEvent,
  TTSState,
  TTSMediaAction,
} from './types';
import type {
  IBackendSessionDriver,
  TTSContentProvider,
} from './providers/TTSContentProvider';
import { TTSSessionRefiller, type TTSSessionRefillHint } from './TTSSessionRefiller';
import { HighlightManager } from './core/highlightManager';
import { log, logError } from '../index';
import { TTS_CHARS_PER_SECOND_EN, TTS_CHARS_PER_SECOND_ZH } from '../../constants/tts';

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
 * 媒体通知的章节进度（章节级，时间均为毫秒）
 * - durationMs：按章节字符数 + 语速估算的时长，0 表示未知
 * - positionMs：章节内已播放位置（按实际播放时间累计，seek 后带偏移）
 */
export interface TTSPlaybackProgress {
  positionMs: number;
  durationMs: number;
}

/**
 * 会话附加回调（可选）：
 * - onNarration：当前朗读句文本（用于媒体通知动态文案）
 * - onPlaybackProgress：章节进度（用于媒体通知进度条/拖动）
 * - onBackgroundServiceError：后台保活服务启动失败（便于前端提示）
 */
export interface TTSSessionCallbacks {
  onNarration?: (text: string) => void;
  onPlaybackProgress?: (progress: TTSPlaybackProgress) => void;
  onBackgroundServiceError?: (reason?: string) => void;
}

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
  #onNarration?: (text: string) => void;
  #onPlaybackProgress?: (progress: TTSPlaybackProgress) => void;
  #onBackgroundServiceError?: (reason?: string) => void;

  #state: TTSState = 'stopped';
  #unsubscribe: (() => void) | null = null;
  #disposed = false;
  #refiller: TTSSessionRefiller | null = null;
  #highlightManager = new HighlightManager();
  #latestSectionIndex = -1;
  #latestAnchor: TTSReadingAnchor | null = null;
  /** 当前高亮的 DOM Range（用于提取朗读中的句子文本） */
  #currentRange: Range | null = null;
  /** 当前朗读句文本（优先取后端下发的 segment 文本，后台不渲染时也可用） */
  #latestNarrationText = '';
  /** 回到前台对齐中：期间跳过跟读渲染，避免与 restore 并发操作渲染器 */
  #foregroundRealigning = false;
  #lastActivityNotifyTs = 0;
  #batchSize = DEFAULT_BATCH_SIZE;
  #managed = false;
  /** 是否收到过 progress 事件（用于判断 shutdown 时是否需要恢复阅读位置） */
  #hasReceivedProgress = false;
  #lastForegroundRealignTs = 0;

  // ---- 媒体通知章节进度（估算） ----
  /** 最近一次 start 的参数，seek 重启会话时复用 */
  #lastStartOptions: TTSSessionStartOptions | null = null;
  /** 本章预计总时长（ms），0 表示未知 */
  #chapterDurationMs = 0;
  /** 本章文本长度（字符数），用于把 anchor 偏移换算成进度 */
  #chapterTextLength = 0;
  /** seek 后的章节内基准位置（ms） */
  #chapterBaseMs = 0;
  /** 已累计的播放时长（ms，不含当前正在播放的片段） */
  #chapterElapsedMs = 0;
  /** 当前播放片段的起始时间戳；暂停/停止时为 null */
  #chapterResumeTs: number | null = null;
  /** 是否正在执行 seek 重启（避免拖动过程中并发重启会话） */
  #seekInProgress = false;
  /** 重启期间收到的最新一次 seek（合并处理，避免丢失最后一次拖动） */
  #pendingSeekMs: number | null = null;

  constructor(
    provider: TTSContentProvider,
    driver: IBackendSessionDriver,
    onStateChange?: TTSSessionStateChangeCallback,
    onReadingActivity?: TTSSessionReadingActivityCallback,
    onEnded?: TTSSessionEndedCallback,
    callbacks?: TTSSessionCallbacks,
  ) {
    this.#provider = provider;
    this.#driver = driver;
    this.#onStateChange = onStateChange;
    this.#onReadingActivity = onReadingActivity;
    this.#onEnded = onEnded;
    this.#onNarration = callbacks?.onNarration;
    this.#onPlaybackProgress = callbacks?.onPlaybackProgress;
    this.#onBackgroundServiceError = callbacks?.onBackgroundServiceError;
  }

  /** 启动会话；返回是否成功开始播放 */
  async start(options: TTSSessionStartOptions): Promise<boolean> {
    if (this.#disposed) return false;
    if (!this.#driver.supportsSession()) {
      log('[TTSSession] driver 不支持会话协议，无法启动', 'warn');
      return false;
    }

    this.#batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
    this.#lastStartOptions = { ...options };
    // 新会话/seek 重启：章节进度从零开始（seek 会在重启后设置基准位置）
    this.#chapterDurationMs = 0;
    this.#chapterTextLength = 0;
    this.#chapterBaseMs = 0;
    this.#chapterElapsedMs = 0;
    this.#chapterResumeTs = null;
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
      // 语速影响章节时长估算（时长 = 字符数 / 语速）
      if (this.#lastStartOptions) this.#lastStartOptions.rate = rate;
      if (this.#latestSectionIndex >= 0) {
        this.#updateChapterDuration(this.#latestSectionIndex, this.#latestNarrationText);
        this.#emitPlaybackProgress();
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

  /**
   * 把最后朗读位置写回阅读器视图（主动调用，如模式切换前）
   * 仅当本会话成功播放过才生效；未播放过则为 no-op
   */
  async restoreReadingPosition(): Promise<void> {
    if (this.#disposed) return;
    await this.#restoreLatestReadingPosition();
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
      onMediaAction: (action, positionMs) => this.#handleMediaAction(action, positionMs),
      onBackgroundServiceError: (reason) => this.#handleBackgroundServiceError(reason),
    };
  }

  /** 后台保活服务不可用：只影响通知，不影响朗读，交由上层提示 */
  #handleBackgroundServiceError(reason?: string): void {
    log(`[TTSSession] background_service_error reason=${reason ?? ''}`, 'warn');
    try {
      this.#onBackgroundServiceError?.(reason);
    } catch (e) {
      logError('[TTSSession] onBackgroundServiceError 异常', e);
    }
  }

  /**
   * 媒体控件动作：通知栏/锁屏/耳机按键。
   *
   * 播放、暂停复用会话自身的 pause/resume；停止等价于用户点“停止听书”
   * （结束会话并通知上层释放 client），但**不回跳阅读位置**，与 App 内停止行为一致。
   */
  #handleMediaAction(action: TTSMediaAction, positionMs?: number): void {
    if (this.#disposed) return;
    log(`[TTSSession] media_action=${action} state=${this.#state} positionMs=${positionMs ?? ''}`, 'info');
    switch (action) {
      case 'play':
        void this.resume();
        break;
      case 'pause':
        void this.pause();
        break;
      case 'stop':
        void this.#stopFromMediaControl();
        break;
      case 'seek':
        void this.#seekToPosition(positionMs ?? 0);
        break;
      default:
        break;
    }
  }

  /** 媒体控件“停止”：走与主动 shutdown 相同的收尾，再通知上层释放 client */
  async #stopFromMediaControl(): Promise<void> {
    if (this.#disposed) return;
    await this.shutdown();
    try {
      this.#onEnded?.({ reason: 'stopped' });
    } catch (e) {
      logError('[TTSSession] onEnded 异常', e);
    }
  }

  #handleProgress(event: TTSSessionProgressEvent): void {
    if (this.#disposed) return;
    this.#hasReceivedProgress = true;
    this.#notifyActivity();
    const previousSectionIndex = this.#latestSectionIndex;
    this.#latestSectionIndex = event.sectionIndex;
    this.#latestAnchor = event.anchor ?? null;
    if (event.text && event.text.trim()) {
      this.#latestNarrationText = event.text.trim();
    }
    if (previousSectionIndex !== event.sectionIndex) {
      // 进入新章节：先重置章节内进度；
      // 时长/进度基准要等 followProgressPosition 把新章节渲染出来后再计算（见 #handleProgressAsync）
      this.#chapterBaseMs = 0;
      this.#chapterElapsedMs = 0;
      this.#chapterResumeTs = this.#state === 'playing' ? Date.now() : null;
    }
    void this.#handleProgressAsync(event, previousSectionIndex);
  }

  async #handleProgressAsync(
    event: TTSSessionProgressEvent,
    previousSectionIndex: number,
  ): Promise<void> {
    try {
      // 前台对齐期间渲染器由 restore 接管，避免并发切章/翻页
      if (this.#foregroundRealigning) return;
      await this.#provider.followProgressPosition?.(
        {
          sectionIndex: event.sectionIndex,
          anchor: event.anchor ?? null,
        },
        previousSectionIndex,
      );
      if (this.#foregroundRealigning) return;
      this.#applyReadingPosition(event.sectionIndex, event.anchor, true);
      // 章节切换/首段/seek 重启后，等新章节渲染完成再读章节文本来估算时长与基准
      if (previousSectionIndex !== event.sectionIndex || this.#chapterDurationMs <= 0) {
        this.#updateChapterDuration(event.sectionIndex, event.text);
        this.#applyAnchorAsProgressBase(event.sectionIndex, event.anchor);
      }
      this.#notifyNarration();
      // 章节进度随朗读推进刷新（系统会按 speed 插值，不需要逐帧上报）
      this.#emitPlaybackProgress();
    } catch (e) {
      logError('[TTSSession] locateAnchor / highlight 异常', e);
    }
  }

  /** 把当前朗读句文本上报给上层（媒体通知动态文案） */
  #notifyNarration(): void {
    if (!this.#onNarration) return;
    // 优先用后端下发的 segment 文本：后台/未渲染时 Range 可能拿不到
    const source = this.#latestNarrationText || this.#currentRange?.toString() || '';
    const text = source.replace(/\s+/g, ' ').trim();
    if (!text) return;
    try {
      this.#onNarration(text);
    } catch (e) {
      logError('[TTSSession] onNarration 异常', e);
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
    const now = Date.now();
    // 暂停/停止时结算当前播放片段的时长
    if (this.#state === 'playing' && this.#chapterResumeTs !== null) {
      this.#chapterElapsedMs += Math.max(0, now - this.#chapterResumeTs);
      this.#chapterResumeTs = null;
    }
    this.#state = next;
    if (next === 'playing') {
      this.#chapterResumeTs = now;
    }
    try {
      this.#onStateChange?.(next);
    } catch (e) {
      logError('[TTSSession] onStateChange 异常', e);
    }
    this.#emitPlaybackProgress();
  }

  // ---------------------------------------------------------------------------
  // 媒体通知章节进度（估算）与拖动跳转
  // ---------------------------------------------------------------------------

  /** 按章节字符数 + 语速估算本章时长；未知长度时返回 0 */
  #updateChapterDuration(sectionIndex: number, sampleText?: string): void {
    const length = this.#provider.getSectionTextLength?.(sectionIndex) ?? 0;
    this.#chapterTextLength = Math.max(0, length);
    if (length <= 0) {
      this.#chapterDurationMs = 0;
      return;
    }
    const rate = Math.max(0.1, this.#lastStartOptions?.rate ?? 1);
    const sample = (sampleText ?? this.#latestNarrationText).trim();
    // 无样本时按中文估算（应用主要面向中文书籍）
    const isCjk = sample ? /[\u4e00-\u9fff]/.test(sample) : true;
    const baseCps = isCjk ? TTS_CHARS_PER_SECOND_ZH : TTS_CHARS_PER_SECOND_EN;
    this.#chapterDurationMs = Math.max(1000, Math.round((length / (baseCps * rate)) * 1000));
    log(
      `[TTSSession] chapter duration: section=${sectionIndex} chars=${length} rate=${rate} cps=${baseCps} durationMs=${this.#chapterDurationMs}`,
      'info',
    );
  }

  /** 用起播 anchor 的字符偏移初始化进度基准（从章中起播时进度条不会从 0 开始） */
  #applyAnchorAsProgressBase(
    sectionIndex: number,
    anchor: TTSReadingAnchor | null | undefined,
  ): void {
    if (this.#chapterDurationMs <= 0 || this.#chapterTextLength <= 0) {
      this.#chapterBaseMs = 0;
      return;
    }
    const offset = this.#provider.getAnchorTextOffset?.(sectionIndex, anchor) ?? null;
    if (offset == null) {
      this.#chapterBaseMs = 0;
      return;
    }
    const ratio = Math.min(1, Math.max(0, offset / this.#chapterTextLength));
    this.#chapterBaseMs = ratio * this.#chapterDurationMs;
  }

  /** 当前章节内位置（ms）：seek 基准 + 已播放/正在播放的时长 */
  #currentPositionMs(): number {
    if (this.#chapterDurationMs <= 0) return 0;
    let elapsed = this.#chapterElapsedMs;
    if (this.#state === 'playing' && this.#chapterResumeTs !== null) {
      elapsed += Math.max(0, Date.now() - this.#chapterResumeTs);
    }
    return Math.min(this.#chapterDurationMs, Math.max(0, this.#chapterBaseMs + elapsed));
  }

  /** 上报章节进度给上层（媒体通知进度条） */
  #emitPlaybackProgress(): void {
    if (!this.#onPlaybackProgress) return;
    try {
      this.#onPlaybackProgress({
        // 必须取整：原生侧（Rust/Kotlin）用 i64/Long 接收，浮点会导致命令解析失败
        positionMs: Math.max(0, Math.round(this.#currentPositionMs())),
        durationMs: Math.max(0, Math.round(this.#chapterDurationMs)),
      });
    } catch (e) {
      logError('[TTSSession] onPlaybackProgress 异常', e);
    }
  }

  /** 媒体进度条拖动：按比例生成章节内起点并重启会话 */
  async #seekToPosition(positionMs: number): Promise<void> {
    if (this.#disposed || this.#state === 'stopped') return;
    if (this.#seekInProgress) {
      // 拖动过程中连续触发时只保留最后一次，重启完成后继续处理
      this.#pendingSeekMs = positionMs;
      return;
    }
    this.#seekInProgress = true;
    try {
      let next: number | null = positionMs;
      while (next != null) {
        this.#pendingSeekMs = null;
        await this.#performSeek(next);
        next = this.#pendingSeekMs;
      }
    } finally {
      this.#seekInProgress = false;
    }
  }

  async #performSeek(positionMs: number): Promise<void> {
    const sectionIndex = this.#latestSectionIndex;
    if (sectionIndex < 0 || this.#chapterDurationMs <= 0) {
      log('[TTSSession] seek ignored: 章节时长未知', 'warn');
      return;
    }
    const ratio = Math.min(0.999, Math.max(0, positionMs / this.#chapterDurationMs));
    const anchor = this.#provider.buildAnchorAtRatio?.(sectionIndex, ratio) ?? null;
    if (!anchor) {
      log(`[TTSSession] seek ignored: 无法生成 anchor sectionIndex=${sectionIndex} ratio=${ratio}`, 'warn');
      return;
    }
    const duration = this.#chapterDurationMs;
    const wasPaused = this.#state === 'paused';
    log(
      `[TTSSession] seek: sectionIndex=${sectionIndex} ratio=${ratio.toFixed(3)} positionMs=${positionMs} durationMs=${duration}`,
      'info',
    );
    await this.#restartAt(sectionIndex, anchor);
    // 重启后把进度基准对齐到拖动位置，避免进度条跳回章节开头
    this.#chapterDurationMs = duration;
    this.#chapterBaseMs = ratio * duration;
    this.#chapterElapsedMs = 0;
    this.#chapterResumeTs = this.#state === 'playing' ? Date.now() : null;
    if (wasPaused && this.#state === 'playing') {
      await this.pause();
    }
    this.#emitPlaybackProgress();
  }

  /** 在当前章节内重启后端会话（保留 client 与前台服务） */
  async #restartAt(sectionIndex: number, anchor: TTSReadingAnchor): Promise<void> {
    const options = this.#lastStartOptions;
    if (!options) return;
    // 先解绑事件监听：非托管 stop 可能发出 session_end，不能让本次 seek 被当成“用户停止”
    const managed = this.#managed;
    this.#cleanupListeners();
    if (!managed) {
      try {
        await this.#driver.sessionStop();
      } catch (e) {
        logError('[TTSSession] seek stop 失败', e);
      }
    }
    // 托管模式不再显式 stop：managedSessionStart 内部会以 emitStoppedEvent=false
    // 停止旧会话（且不停止前台服务），避免 session_end 事件误结束本次 seek。
    this.#refiller = null;
    this.#managed = false;
    this.#foregroundRealigning = false;
    this.#highlightManager.clear();
    this.#currentRange = null;
    this.#latestNarrationText = '';
    this.#hasReceivedProgress = false;
    const restarted = await this.start({ ...options, startSectionIndex: sectionIndex, startAnchor: anchor });
    if (!restarted) {
      log('[TTSSession] seek 重启会话失败', 'warn');
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
    if (this.#disposed) return;
    // 播放中或暂停中都需要把视图对齐到最新朗读位置
    if (this.#state !== 'playing' && this.#state !== 'paused') return;
    if (!this.#hasReceivedProgress || this.#latestSectionIndex < 0) return;
    if (this.#foregroundRealigning) return;
    const now = Date.now();
    if (now - this.#lastForegroundRealignTs < FOREGROUND_REALIGN_COOLDOWN_MS) return;
    this.#lastForegroundRealignTs = now;
    this.#foregroundRealigning = true;
    void this.#realignToLatestPosition().finally(() => {
      this.#foregroundRealigning = false;
    });
  };

  /**
   * 回到前台时把阅读视图真正对齐到最新朗读位置。
   *
   * 后台期间渲染器会跳过跟读（如 EpubPositionRestorer.followHorizontalProgress 在
   * document.hidden 时直接返回），长时间后台可能已跨过多章；此时只在当前章节内
   * locateAnchor 必然落空，表现为“回到应用仍停在切后台时的页”。
   * 因此这里先走 provider.restoreReadingPosition 切章/翻页，再重建高亮。
   */
  async #realignToLatestPosition(): Promise<void> {
    let sectionIndex = this.#latestSectionIndex;
    let anchor = this.#latestAnchor;
    try {
      await this.#provider.restoreReadingPosition({ sectionIndex, anchor });
      // 恢复期间朗读并未暂停，可能又跨章：以最新位置再对齐一次（最多两次）
      if (this.#latestSectionIndex !== sectionIndex) {
        sectionIndex = this.#latestSectionIndex;
        anchor = this.#latestAnchor;
        await this.#provider.restoreReadingPosition({ sectionIndex, anchor });
      }
    } catch (e) {
      logError('[TTSSession] 前台恢复朗读位置失败', e);
    }
    if (this.#disposed) return;
    const applied = this.#applyReadingPosition(sectionIndex, anchor, false);
    // 恢复后同步一次通知文案（后台期间可能因为未渲染而没更新）
    this.#notifyNarration();
    log(
      `[TTSSession] foreground realign sectionIndex=${sectionIndex} applied=${applied}`,
      applied ? 'info' : 'warn',
    );
  }

  #applyReadingPosition(
    sectionIndex: number,
    anchor: TTSReadingAnchor | null | undefined,
    clearOnMiss: boolean,
  ): boolean {
    const range = this.#provider.locateAnchor(sectionIndex, anchor);
    if (!range) {
      if (clearOnMiss) {
        this.#highlightManager.clear();
        this.#currentRange = null;
      }
      return false;
    }
    this.#currentRange = range;
    this.#highlightManager.apply(range);
    this.#highlightManager.maybeScrollIntoView(range);
    return true;
  }
}

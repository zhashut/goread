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
import {
  getTtsDefaultCharsPerSecond,
  TTS_SPEED_PRIOR_MAX_FACTOR,
  TTS_SPEED_PRIOR_MIN_FACTOR,
} from '../../constants/tts';

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
  /**
   * 该语音在 rate=1 时的实测/历史语速（字符/秒）。
   * 有值则作为本轮时长估算初值；否则用语言先验。
   */
  charsPerSecondAtRate1?: number;
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
  /** 当前朗读章节标题（用于媒体通知，跟随 TTS progress 更新） */
  chapterTitle?: string;
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
  /** 实测语速（rate=1 字符/秒），用于按“引擎+语音+语言”持久化 */
  onSpeedMeasured?: (charsPerSecondAtRate1: number) => void;
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
  #onSpeedMeasured?: (charsPerSecondAtRate1: number) => void;
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
  /** 当前朗读章节标题（由 Provider 按 sectionIndex 解析，不依赖阅读器当前页） */
  #latestSectionTitle = '';
  /** 视图对齐中：期间跳过 progress 驱动的视图操作，避免与恢复渲染并发 */
  #aligning = false;
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
  /** 本章原始文本长度（用于 anchor 偏移 → 进度比例） */
  #chapterTextLength = 0;
  /** 本章可朗读字符数（去空白，用于时长估算） */
  #chapterSpeakableLength = 0;
  /** 最近一次后端下发的整章可朗读字符数及其章节（语速变化时复用，避免前端 DOM 统计不准） */
  #backendSectionSpeakableLength = 0;
  #backendSectionSpeakableSection = -1;
  /** 本章总 chunk 数（后端下发；文本进度的分母） */
  #chapterChunkCount = 0;
  /** 已完成的 chunk 数（文本进度；0 = 章首，chunkCount = 章末） */
  #chapterCompletedChunks = 0;
  /** 下一次 progress 是否必须重置文本进度（seek/跳章/新会话后 chunkIndex 可能回退） */
  #textProgressNeedsReset = true;
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

  // ---- 实测语速（按语音学习） ----
  /** 当前语音在 rate=1 时的字符/秒；0 表示未知，使用语言先验 */
  #charsPerSecondAtRate1 = 0;
  /** 本轮累计的采样时长（ms），≥阈值后才开始校准 */
  #speedSampleMs = 0;
  /** 上一次 progress 的时间戳（null 表示不采样） */
  #lastProgressAt: number | null = null;
  /** 上一句的可朗读字符数 */
  #lastSegmentSpeakable = 0;
  /** 上一次校准/持久化的时间戳（节流） */
  #lastCalibrationAt = 0;
  /** 是否已有真实采样（避免把语言先验当成实测值持久化） */
  #hasMeasuredSpeed = false;

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
    this.#onSpeedMeasured = callbacks?.onSpeedMeasured;
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
    if (options.charsPerSecondAtRate1 && options.charsPerSecondAtRate1 > 0) {
      this.#charsPerSecondAtRate1 = options.charsPerSecondAtRate1;
    }
    // 新会话/seek 重启：章节进度从零开始（seek 会在重启后设置基准位置）
    this.#chapterDurationMs = 0;
    this.#chapterTextLength = 0;
    this.#chapterSpeakableLength = 0;
    this.#chapterChunkCount = 0;
    this.#chapterCompletedChunks = 0;
    this.#textProgressNeedsReset = true;
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
    this.#persistSpeedEstimate();
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
      case 'prev-chapter':
        void this.#jumpToAdjacentChapter('prev');
        break;
      case 'next-chapter':
        void this.#jumpToAdjacentChapter('next');
        break;
      default:
        break;
    }
  }

  /**
   * 上一章/下一章：从目标章节开头重启会话。
   * 暂停状态下也自动开始播放（与主流听书软件一致）。
   */
  async #jumpToAdjacentChapter(direction: 'prev' | 'next'): Promise<void> {
    if (this.#disposed || this.#state === 'stopped') return;
    if (this.#seekInProgress) return;
    const current = this.#latestSectionIndex;
    if (current < 0) return;
    const target = this.#provider.getAdjacentSectionIndex?.(current, direction) ?? null;
    if (target == null) {
      log(`[TTSSession] ${direction}-chapter ignored: no adjacent section current=${current}`, 'warn');
      return;
    }
    this.#seekInProgress = true;
    try {
      log(`[TTSSession] ${direction}-chapter: ${current} -> ${target}`, 'info');
      this.#latestSectionIndex = target;
      this.#latestAnchor = null;
      this.#latestSectionTitle = this.#provider.getSectionTitle?.(target)?.trim() || '';
      await this.#restartAt(target, null);
      // 自动播放：start() 已把状态置为 playing；这里只重置章节进度
      this.#chapterDurationMs = 0;
      this.#chapterSpeakableLength = 0;
      this.#chapterTextLength = 0;
      this.#chapterChunkCount = 0;
      this.#chapterCompletedChunks = 0;
      this.#textProgressNeedsReset = true;
      this.#chapterBaseMs = 0;
      this.#chapterElapsedMs = 0;
      this.#chapterResumeTs = this.#state === 'playing' ? Date.now() : null;
      this.#emitPlaybackProgress();
    } finally {
      this.#seekInProgress = false;
    }
  }

  /** 当前章节是否存在上一章/下一章（供媒体通知控制按钮显隐） */
  getSkipAvailability(): { canSkipPrevious: boolean; canSkipNext: boolean } {
    const current = this.#latestSectionIndex;
    if (current < 0 || !this.#provider.getAdjacentSectionIndex) {
      return { canSkipPrevious: false, canSkipNext: false };
    }
    return {
      canSkipPrevious: this.#provider.getAdjacentSectionIndex(current, 'prev') != null,
      canSkipNext: this.#provider.getAdjacentSectionIndex(current, 'next') != null,
    };
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
    if (typeof event.sectionSpeakableLength === 'number' && event.sectionSpeakableLength > 0) {
      this.#backendSectionSpeakableLength = Math.floor(event.sectionSpeakableLength);
      this.#backendSectionSpeakableSection = event.sectionIndex;
    }
    this.#latestAnchor = event.anchor ?? null;
    if (event.text && event.text.trim()) {
      this.#latestNarrationText = event.text.trim();
    }
    if (previousSectionIndex !== event.sectionIndex) {
      // 章节标题跟随 TTS 的 sectionIndex，而不是阅读器当前页（后台/未渲染时也能更新）
      this.#latestSectionTitle = this.#provider.getSectionTitle?.(event.sectionIndex)?.trim() || '';
      // 进入新章节必须清空上一章时长/长度，否则新章节会沿用旧时长：
      // 旧时长偏短 -> 进度条很快满格；拿不到文本 -> 进度归零。
      this.#chapterDurationMs = 0;
      this.#chapterSpeakableLength = 0;
      this.#chapterTextLength = 0;
      this.#chapterChunkCount = 0;
      this.#chapterCompletedChunks = 0;
      this.#textProgressNeedsReset = true;
      this.#chapterBaseMs = 0;
      this.#chapterElapsedMs = 0;
      this.#chapterResumeTs = this.#state === 'playing' ? Date.now() : null;
    }
    // 文本进度：用 chunkIndex / sectionChunkCount 表示“读到哪”，
    // 不再用墙钟时间；缓冲、停顿、事件延迟都不会推进进度条。
    if (
      typeof event.sectionChunkCount === 'number' &&
      event.sectionChunkCount > 0
    ) {
      this.#chapterChunkCount = Math.floor(event.sectionChunkCount);
    }
    if (typeof event.chunkIndex === 'number' && event.chunkIndex >= 0) {
      const chunkIndex = Math.floor(event.chunkIndex);
      if (this.#textProgressNeedsReset) {
        // seek/跳章后首次 progress：直接采用目标 chunk，允许回退
        this.#chapterCompletedChunks = chunkIndex;
        this.#textProgressNeedsReset = false;
      } else {
        // 正常播放时只允许前进，避免乱序事件让进度回退
        this.#chapterCompletedChunks = Math.max(this.#chapterCompletedChunks, chunkIndex);
      }
    }
    // 语速采样放在切章重置之后：校准时刷新的是当前章节，不会用旧章节长度算完又立刻被清空
    this.#trackSpeechRate(event);
    void this.#handleProgressAsync(event, previousSectionIndex);
  }

  async #handleProgressAsync(
    event: TTSSessionProgressEvent,
    previousSectionIndex: number,
  ): Promise<void> {
    if (this.#disposed) return;
    // 并发 progress 可能乱序：旧章节的异步处理不能覆盖最新章节
    if (event.sectionIndex !== this.#latestSectionIndex) return;

    // 1) 先根据后端整章字符数更新时长/基准。
    //    这一步不依赖章节是否已渲染，也不依赖高亮成功，
    //    避免纵向模式高亮/locateAnchor 抛错时把章节时长留在 0。
    const needsChapterStats =
      previousSectionIndex !== event.sectionIndex || this.#chapterDurationMs <= 0;
    if (needsChapterStats) {
      this.#updateChapterDuration(
        event.sectionIndex,
        event.text,
        event.sectionSpeakableLength,
      );
      this.#applyAnchorAsProgressBase(event.sectionIndex, event.anchor);
      // 先上报一次：切章瞬间通知可能还显示上一章的满格进度，
      // 这里立即用新章节时长/基准覆盖，避免旧进度停留到渲染完成。
      this.#emitPlaybackProgress();
    }

    // 对齐进行中：视图操作交给当前这次对齐接管，这里只更新文案与进度
    if (this.#aligning) {
      this.#notifyNarration();
      this.#emitPlaybackProgress();
      return;
    }

    // 2) 格式私有的进度定位（TXT 同章翻页等），交给 Provider
    try {
      await this.#provider.followProgressPosition?.(
        {
          sectionIndex: event.sectionIndex,
          anchor: event.anchor ?? null,
        },
        previousSectionIndex,
      );
    } catch (e) {
      logError('[TTSSession] followProgressPosition 异常', e);
    }
    if (this.#disposed || event.sectionIndex !== this.#latestSectionIndex) return;

    // 3) 统一定位 + 高亮 + 吸附（跨章时内部先恢复章节）
    try {
      await this.#alignViewToNarration(event.sectionIndex, event.anchor ?? null);
    } catch (e) {
      logError('[TTSSession] 视图对齐异常', e);
    }

    // 只在切章/seek 的首个 progress 补一次基准：
    // 后续句子的 anchor 不能再当基准，否则会和已累计的播放时间重复计算
    if (needsChapterStats && this.#chapterDurationMs > 0) {
      this.#applyAnchorAsProgressBase(event.sectionIndex, event.anchor);
    }
    // 兜底：没有后端整章字符数且章节刚渲染出来时，再用前端文本统计一次
    if (this.#chapterDurationMs <= 0) {
      this.#updateChapterDuration(
        event.sectionIndex,
        event.text,
        event.sectionSpeakableLength,
      );
      this.#applyAnchorAsProgressBase(event.sectionIndex, event.anchor);
    }

    this.#notifyNarration();
    this.#emitPlaybackProgress();
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
    // 一句话播完：文本进度推进到 chunkIndex + 1；章末最后一个 chunk 完成后到达 100%
    if (
      event.sectionIndex != null &&
      event.sectionIndex === this.#latestSectionIndex &&
      event.chunkIndex != null
    ) {
      if (
        typeof event.sectionChunkCount === 'number' &&
        event.sectionChunkCount > 0
      ) {
        this.#chapterChunkCount = Math.floor(event.sectionChunkCount);
      }
      const completed = Math.floor(event.chunkIndex) + 1;
      this.#chapterCompletedChunks = Math.max(this.#chapterCompletedChunks, completed);
      this.#emitPlaybackProgress();
    }
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
    this.#persistSpeedEstimate();
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
      // 暂停会截断当前句，不能把暂停时长计入语速采样
      this.#lastProgressAt = null;
      this.#lastSegmentSpeakable = 0;
    }
    this.#state = next;
    if (next === 'playing') {
      this.#chapterResumeTs = now;
      this.#lastProgressAt = now;
      this.#lastSegmentSpeakable = 0;
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

  /** 当前应使用的字符/秒（rate=1）：优先实测，其次语言先验 */
  #effectiveCharsPerSecond(sampleText?: string): number {
    const prior = getTtsDefaultCharsPerSecond(sampleText ?? this.#latestNarrationText);
    if (this.#charsPerSecondAtRate1 > 0) {
      // 历史档案可能是异常采样写入的，超出语言先验合理区间时收敛回边界，
      // 否则章节时长会明显短于实际播放时间，进度条提前满格。
      return Math.min(
        prior * TTS_SPEED_PRIOR_MAX_FACTOR,
        Math.max(prior * TTS_SPEED_PRIOR_MIN_FACTOR, this.#charsPerSecondAtRate1),
      );
    }
    return prior;
  }

  /** 按章节可朗读字符数 + 语速估算本章时长；未知长度时返回 0 */
  #updateChapterDuration(
    sectionIndex: number,
    sampleText?: string,
    speakableOverride?: number,
  ): void {
    // 未显式传入时，复用该章节最近一次后端下发的整章字符数
    if (
      (speakableOverride === undefined || speakableOverride <= 0) &&
      this.#backendSectionSpeakableSection === sectionIndex
    ) {
      speakableOverride = this.#backendSectionSpeakableLength;
    }
    const rawLength = this.#provider.getSectionTextLength?.(sectionIndex) ?? 0;
    // 优先用后端下发的整章字符数：它来自后端真正切片的完整章节文本，
    // 比前端 DOM/缓存统计更可靠（纵向模式章节可能只渲染了部分）。
    const backendSpeakable =
      typeof speakableOverride === 'number' && speakableOverride > 0
        ? Math.floor(speakableOverride)
        : 0;
    const speakable =
      backendSpeakable > 0
        ? backendSpeakable
        : (this.#provider.getSectionSpeakableLength?.(sectionIndex) ?? rawLength);
    // anchor 偏移是按原始文本（含空白）算的，base 的分母也必须用原始长度；
    // 后端 speakable 只用于时长估算。文本进度模式不使用 base，这里的口径只影响旧驱动 fallback。
    this.#chapterTextLength = Math.max(0, rawLength > 0 ? rawLength : speakable);
    this.#chapterSpeakableLength = Math.max(0, speakable);
    if (this.#chapterSpeakableLength <= 0) {
      this.#chapterDurationMs = 0;
      return;
    }
    const rate = Math.max(0.1, this.#lastStartOptions?.rate ?? 1);
    const cps = this.#effectiveCharsPerSecond(sampleText);
    const previousDuration = this.#chapterDurationMs;
    this.#chapterDurationMs = Math.max(
      1000,
      Math.round((this.#chapterSpeakableLength / (cps * rate)) * 1000),
    );
    // 语速变化导致时长变化时，按比例缩放 seek 基准，避免位置突然跳到满格
    if (previousDuration > 0 && this.#chapterBaseMs > 0) {
      const fraction = Math.min(1, Math.max(0, this.#chapterBaseMs / previousDuration));
      this.#chapterBaseMs = fraction * this.#chapterDurationMs;
    }
    log(
      `[TTSSession] chapter duration: section=${sectionIndex} backendSpeakable=${backendSpeakable} chunks=${this.#chapterChunkCount} rawChars=${this.#chapterTextLength} speakable=${this.#chapterSpeakableLength} rate=${rate} cps=${cps.toFixed(2)} durationMs=${this.#chapterDurationMs}`,
      'info',
    );
  }

  /** 用最新的实测语速重算本章时长（不改变当前播放位置） */
  #refreshChapterDuration(): void {
    if (this.#chapterSpeakableLength <= 0) return;
    const previousDuration = this.#chapterDurationMs;
    const rate = Math.max(0.1, this.#lastStartOptions?.rate ?? 1);
    const cps = this.#effectiveCharsPerSecond();
    this.#chapterDurationMs = Math.max(
      1000,
      Math.round((this.#chapterSpeakableLength / (cps * rate)) * 1000),
    );
    // seek 后的进度基准是“毫秒偏移”，时长变化时按比例缩放，保持相同文本位置的比例
    if (previousDuration > 0) {
      const fraction = Math.min(1, Math.max(0, this.#chapterBaseMs / previousDuration));
      this.#chapterBaseMs = fraction * this.#chapterDurationMs;
    }
    this.#emitPlaybackProgress();
  }

  /** 根据上一句的真实播放间隔采样语速（含句间间隔），并用 EMA 平滑 */
  #trackSpeechRate(event: TTSSessionProgressEvent): void {
    const now = Date.now();
    if (this.#state === 'playing' && this.#lastProgressAt !== null) {
      const elapsed = now - this.#lastProgressAt;
      const chars = this.#lastSegmentSpeakable;
      if (elapsed >= 500 && elapsed <= 30000 && chars >= 5) {
        const rate = Math.max(0.1, this.#lastStartOptions?.rate ?? 1);
        const measured = chars / (elapsed / 1000) / rate;
        // 过滤异常采样：引擎跳句/事件抖动会让 measured 偏离真实语速一个数量级
        const prior = getTtsDefaultCharsPerSecond(event.text ?? this.#latestNarrationText);
        if (
          measured >= prior * TTS_SPEED_PRIOR_MIN_FACTOR &&
          measured <= prior * TTS_SPEED_PRIOR_MAX_FACTOR
        ) {
          this.#speedSampleMs += elapsed;
          this.#charsPerSecondAtRate1 = this.#charsPerSecondAtRate1 > 0
            ? this.#charsPerSecondAtRate1 * 0.8 + measured * 0.2
            : measured;
          this.#hasMeasuredSpeed = true;
          this.#maybeCalibrate(now);
        } else {
          log(
            `[TTSSession] speed sample ignored: measured=${measured.toFixed(2)} prior=${prior.toFixed(2)} chars=${chars} elapsedMs=${elapsed}`,
            'warn',
          );
        }
      }
    }
    this.#lastProgressAt = now;
    this.#lastSegmentSpeakable = event.speakableLength
      ?? (event.text ? event.text.replace(/\s+/g, '').length : 0);
  }

  /** 样本足够且距上次校准 ≥30s 时，刷新时长并持久化语速 */
  #maybeCalibrate(now: number): void {
    if (!this.#hasMeasuredSpeed) return;
    if (this.#speedSampleMs < 8000) return;
    if (now - this.#lastCalibrationAt < 30000) return;
    if (this.#charsPerSecondAtRate1 <= 0) return;
    this.#lastCalibrationAt = now;
    const cps = Math.round(this.#charsPerSecondAtRate1 * 100) / 100;
    log(
      `[TTSSession] speed calibrated: cpsAtRate1=${cps} sampleMs=${this.#speedSampleMs}`,
      'info',
    );
    this.#refreshChapterDuration();
    try {
      this.#onSpeedMeasured?.(cps);
    } catch (e) {
      logError('[TTSSession] onSpeedMeasured 异常', e);
    }
  }

  /** 会话结束时持久化最终语速 */
  #persistSpeedEstimate(): void {
    if (!this.#hasMeasuredSpeed || this.#charsPerSecondAtRate1 <= 0) return;
    try {
      this.#onSpeedMeasured?.(Math.round(this.#charsPerSecondAtRate1 * 100) / 100);
    } catch (e) {
      logError('[TTSSession] onSpeedMeasured 异常', e);
    }
  }

  /** 用起播 anchor 的字符偏移初始化进度基准（从章中起播时进度条不会从 0 开始） */
  #applyAnchorAsProgressBase(
    sectionIndex: number,
    anchor: TTSReadingAnchor | null | undefined,
  ): void {
    // 文本进度模式位置由 chunk 比例决定，anchor 毫秒基准不再参与
    if (this.#chapterChunkCount > 0) {
      this.#chapterBaseMs = 0;
      return;
    }
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

  /**
   * 当前章节内位置（ms）。
   *
   * 优先使用“文本进度”：已完成 chunk 数 / 本章总 chunk 数。
   * 这样只要本章还有文本没读完，进度就不会到 100%，
   * 不受 TTS 缓冲、句间停顿、后台事件延迟和语速估算偏差影响。
   *
   * 旧原生/旧驱动没有 sectionChunkCount 时，回退到墙钟时间。
   */
  #currentPositionMs(): number {
    if (this.#chapterDurationMs <= 0) return 0;
    if (this.#chapterChunkCount > 0) {
      const fraction = Math.min(
        1,
        Math.max(0, this.#chapterCompletedChunks / this.#chapterChunkCount),
      );
      return Math.round(this.#chapterDurationMs * fraction);
    }
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
        chapterTitle: this.#latestSectionTitle || undefined,
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
    const chapterSpeakableLength = this.#chapterSpeakableLength;
    const chapterTextLength = this.#chapterTextLength;
    const wasPaused = this.#state === 'paused';
    log(
      `[TTSSession] seek: sectionIndex=${sectionIndex} ratio=${ratio.toFixed(3)} positionMs=${positionMs} durationMs=${duration}`,
      'info',
    );
    await this.#restartAt(sectionIndex, anchor);
    // 重启后把进度基准对齐到拖动位置，避免进度条跳回章节开头。
    // start() 会清空章节统计，这里恢复，保证后续语速校准还能重算本章时长。
    this.#chapterDurationMs = duration;
    this.#chapterSpeakableLength = chapterSpeakableLength;
    this.#chapterTextLength = chapterTextLength;
    this.#chapterBaseMs = ratio * duration;
    this.#chapterElapsedMs = 0;
    this.#chapterResumeTs = this.#state === 'playing' ? Date.now() : null;
    if (wasPaused && this.#state === 'playing') {
      await this.pause();
    }
    this.#emitPlaybackProgress();
  }

  /** 在当前章节内重启后端会话（保留 client 与前台服务） */
  async #restartAt(sectionIndex: number, anchor: TTSReadingAnchor | null): Promise<void> {
    const options = this.#lastStartOptions;
    if (!options) return;
    const measuredCps = this.#charsPerSecondAtRate1;
    this.#lastProgressAt = null;
    this.#lastSegmentSpeakable = 0;
    this.#chapterChunkCount = 0;
    this.#chapterCompletedChunks = 0;
    this.#textProgressNeedsReset = true;
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
    this.#aligning = false;
    this.#highlightManager.clear();
    this.#currentRange = null;
    this.#latestNarrationText = '';
    this.#hasReceivedProgress = false;
    const restarted = await this.start({ ...options, startSectionIndex: sectionIndex, startAnchor: anchor });
    // start() 会用 options 里的历史语速覆盖实测值，这里恢复本次会话的学习结果
    if (measuredCps > 0) this.#charsPerSecondAtRate1 = measuredCps;
    if (!restarted) {
      log('[TTSSession] 重启会话失败', 'warn');
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
    const now = Date.now();
    if (now - this.#lastForegroundRealignTs < FOREGROUND_REALIGN_COOLDOWN_MS) return;
    this.#lastForegroundRealignTs = now;
    // 后台期间朗读可能已跨过多章，且渲染器在后台不跟读：回前台立即对齐一次
    void this.#alignViewToNarration(this.#latestSectionIndex, this.#latestAnchor)
      .finally(() => this.#notifyNarration());
  };

  /**
   * 把阅读视图对齐到指定朗读位置（每句 progress、回前台共用这一条路径）。
   *
   * 同章：直接在当前 DOM 定位 → 高亮 → 吸附到朗读所在列；
   * 跨章（或用户此前翻到了其它章节）：先由 Provider 恢复章节，再定位、高亮、吸附。
   * 未命中时保留上一句高亮：跨章瞬间 DOM 可能尚未就绪，清空会让用户看到“朗读中却没有高亮”。
   */
  async #alignViewToNarration(
    sectionIndex: number,
    anchor: TTSReadingAnchor | null,
  ): Promise<boolean> {
    if (this.#disposed) return false;
    // 后台不操作视图（渲染器内部的帧等待在后台不会触发）
    if (typeof document !== 'undefined' && document.hidden) return false;
    if (this.#aligning) return false;
    this.#aligning = true;
    let path: 'same-chapter' | 'restore' = 'same-chapter';
    try {
      let range = this.#provider.locateAnchor(sectionIndex, anchor);
      if (!range) {
        path = 'restore';
        await this.#provider.restoreReadingPosition({ sectionIndex, anchor });
        if (this.#disposed) return false;
        // 恢复期间朗读可能已推进到新章节：旧的定位交给下一句处理
        if (sectionIndex !== this.#latestSectionIndex) return false;
        range = this.#provider.locateAnchor(sectionIndex, anchor);
      }
      if (!range) {
        log(`[TTS][Align] section=${sectionIndex} path=miss lastPath=${path}`, 'warn');
        return false;
      }
      this.#currentRange = range;
      this.#highlightManager.apply(range);
      this.#highlightManager.maybeScrollIntoView(range);
      log(`[TTS][Align] section=${sectionIndex} path=${path}`, 'info');
      return true;
    } finally {
      this.#aligning = false;
    }
  }
}

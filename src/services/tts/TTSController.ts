import type { ITTSClient } from './TTSClient';
import type { TTSState, TTSVisibleStart } from './types';
import type { IBookRenderer } from '../formats/types';
import { parseSSMLMarks, preprocessSSML, parseSSMLLang } from './ssmlParser';
import { HighlightManager } from './core/highlightManager';
import { TTSRendererAdapter, type TTSDocumentData as AdapterTTSDocumentData } from './core/rendererAdapter';
import { DomSSMLIterator } from './core/iteratorDom';
import { TextSSMLIterator } from './core/iteratorText';
import { PrefetchAdvanceManager } from './core/prefetchAdvance';
import { log, logError } from '../index';
import {
  createTextContentSearchCache,
  findRangeByTextQuote,
  type TextContentSearchCache,
  type TextQuote,
} from '../../utils/ttsDOM';

/** TTS 文档数据：渲染器返回的内容 */
export type TTSDocumentData = AdapterTTSDocumentData;

/** 状态变化回调 */
export type TTSStateChangeCallback = (state: TTSState) => void;
export type TTSMarkCallback = (mark: string) => void | Promise<void>;

/**
 * TTS 核心调度器
 * 负责从渲染器获取文本、生成 SSML、调用客户端朗读、管理状态
 */
export class TTSController {
  #client: ITTSClient;
  #renderer: IBookRenderer;
  #rendererAdapter: TTSRendererAdapter;
  #state: TTSState = 'stopped';
  #onStateChange?: TTSStateChangeCallback;
  #onReadingActivity?: () => void;
  #onMark?: TTSMarkCallback;

  #domIterator: DomSSMLIterator | null = null;
  #textIterator: TextSSMLIterator | null = null;
  /** 当前高亮 Range，用于朗读时标记位置 */
  #highlightRange: Range | null = null;
  #highlightManager = new HighlightManager();
  /** 当前 block 的 ranges 快照，防止 prefetch 覆盖导致高亮错位 */
  #currentRanges: Map<string, Range> = new Map();
  #currentMarkAnchors: Map<string, TextQuote> = new Map();
  #lastMark: string | null = null;
  #docCache: TextContentSearchCache | null = null;
  #docInvalidated = false;
  #notifySeq = 0;
  /** 是否已销毁，防止 shutdown 后残余异步任务继续执行 */
  #disposed = false;
  #activityTimerId: number | null = null;
  #lastActivityNotifyTs = 0;

  /** 当前朗读任务的 AbortController */
  #abortController: AbortController | null = null;
  /** 当前朗读 Promise */
  #speakPromise: Promise<void> | null = null;
  /** 连续无 SSML 输出计数 */
  #emptyCount = 0;

  #prefetchAdvance = new PrefetchAdvanceManager();

  static readonly #ACTIVITY_TIMER_MS = 30 * 1000;
  static readonly #ACTIVITY_THROTTLE_MS = 3 * 1000;

  constructor(
    client: ITTSClient,
    renderer: IBookRenderer,
    onStateChange?: TTSStateChangeCallback,
    onReadingActivity?: () => void,
    onMark?: TTSMarkCallback,
  ) {
    this.#client = client;
    this.#renderer = renderer;
    this.#rendererAdapter = new TTSRendererAdapter(renderer);
    this.#onStateChange = onStateChange;
    this.#onReadingActivity = onReadingActivity;
    this.#onMark = onMark;
  }

  get state(): TTSState {
    return this.#state;
  }

  /** 获取当前朗读高亮的 Range */
  get highlightRange(): Range | null {
    return this.#highlightRange;
  }

  /** 初始化客户端 */
  async init(): Promise<boolean> {
    return this.#client.init();
  }

  /** 设置主语言 */
  setLang(lang: string): void {
    this.#client.setPrimaryLang(lang);
  }

  /** 设置语速 */
  setRate(rate: number): void {
    this.#client.setRate(rate);
  }

  /** 获取当前语速 */
  getRate(): number {
    return this.#client.getRate();
  }

  // --- 状态控制 ---

  #setState(state: TTSState): void {
    const prevState = this.#state;
    this.#state = state;
    if (state === 'playing') {
      this.#startActivityTimer(prevState !== 'paused');
    } else {
      this.#stopActivityTimer();
    }
    this.#onStateChange?.(state);
  }

  #emitReadingActivity(force = false): void {
    if (this.#disposed) return;
    if (!this.#onReadingActivity) return;
    if (!force && this.#state !== 'playing') return;

    const now = Date.now();
    if (!force && now - this.#lastActivityNotifyTs < TTSController.#ACTIVITY_THROTTLE_MS) {
      return;
    }
    this.#lastActivityNotifyTs = now;

    try {
      this.#onReadingActivity();
    } catch (e) {
      logError('[TTS] onReadingActivity error', e);
    }
  }

  #startActivityTimer(emitImmediately: boolean): void {
    if (this.#activityTimerId != null) return;
    if (emitImmediately) {
      this.#emitReadingActivity(true);
    }
    this.#activityTimerId = window.setInterval(() => {
      this.#emitReadingActivity(false);
    }, TTSController.#ACTIVITY_TIMER_MS);
  }

  #stopActivityTimer(): void {
    if (this.#activityTimerId == null) return;
    window.clearInterval(this.#activityTimerId);
    this.#activityTimerId = null;
  }

  /** 获取文档数据的最大重试次数 */
  static readonly #DOC_DATA_MAX_RETRIES = 3;
  /** 每次重试的间隔（ms） */
  static readonly #DOC_DATA_RETRY_DELAY = 300;

  /**
   * 开始朗读当前可见内容，返回是否成功开始朗读
   * @param fromBeginning 为 true 时跳过可见位置检测，从页面/章节开头开始（翻页后调用）
   */
  async start(fromBeginning = false): Promise<boolean> {
    if (this.#disposed) {
      log('[TTS] start() 被拦截：controller 已销毁', 'warn');
      return false;
    }
    try {
      log('[TTS] start() 开始，准备获取文档数据', 'info');

      const docData = await this.#rendererAdapter.getDocumentDataWithRetry(
        TTSController.#DOC_DATA_MAX_RETRIES,
        TTSController.#DOC_DATA_RETRY_DELAY,
      );
      if (!docData) {
        return false;
      }

      log(`[TTS] 获取到文档数据，type=${docData.type}，内容长度=${docData.type === 'text' ? docData.text.length : '(dom)'}`, 'info');

      // 首次启动时从用户阅读位置开始；翻页后从新页开头开始
      const visibleStart = fromBeginning ? null : this.#rendererAdapter.getVisibleStart();
      log(`[TTS] visibleStart: ${visibleStart ? `type=${visibleStart.type}` : 'null（从头开始）'}, fromBeginning=${fromBeginning}`, 'info');

      if (docData.type === 'dom') {
        return await this.#startDomPath(docData.doc, visibleStart);
      } else {
        return await this.#startTextPath(docData.text, visibleStart);
      }
    } catch (err) {
      logError('[TTS] start() 异常', err);
      // 打印详细错误信息，包括类型和消息
      const errMsg = err instanceof Error
        ? `${err.name}: ${err.message}\n${err.stack}`
        : JSON.stringify(err, Object.getOwnPropertyNames(err ?? {}));
      log(`[TTS] start() 异常详情: ${errMsg}`, 'error');
      this.#setState('stopped');
      return false;
    }
  }

  /**
   * 恢复暂停的朗读
   */
  async resume(): Promise<void> {
    if (this.#state !== 'paused') return;
    if (this.#disposed) return;
    try {
      await this.#client.resume();
      if (this.#disposed) return;
      if (this.#state !== 'paused') return;
      this.#setState('playing');
      this.#emitReadingActivity(true);
    } catch (e) {
      logError('[TTS] resume() error', e);
    }
  }

  /**
   * 暂停朗读
   */
  async pause(): Promise<void> {
    if (this.#state !== 'playing') return;
    if (this.#disposed) return;
    this.#setState('paused');
    try {
      await this.#client.pause();
    } catch (e) {
      logError('[TTS] pause() error', e);
      if (!this.#disposed && this.#abortController) {
        this.#setState('playing');
      }
    }
  }

  /**
   * 停止朗读（可重新开始）
   */
  async stop(): Promise<void> {
    log(`[TTS] stop() 开始, disposed=${this.#disposed}`, 'info');
    try {
      this.#stopActivityTimer();
      if (this.#abortController) {
        this.#abortController.abort();
        this.#abortController = null;
      }
      await this.#client.stop();
    } catch (e) {
      logError('[TTS] stop() error', e);
    } finally {
      this.#speakPromise = null;
      this.#clearPrefetchState();
      this.#currentRanges.clear();
      this.#currentMarkAnchors.clear();
      this.#lastMark = null;
      this.#docCache = null;
      this.#docInvalidated = false;
      this.#highlightManager.clear();
      this.#highlightRange = null;
      this.#setState('stopped');
      log('[TTS] stop() 完成', 'info');
    }
  }

  /**
   * 完全关闭，释放所有资源
   */
  async shutdown(): Promise<void> {
    log(`[TTS] shutdown() 开始, disposed=${this.#disposed}`, 'info');
    this.#disposed = true;
    this.#stopActivityTimer();
    // 先中断，不等待
    if (this.#abortController) {
      this.#abortController.abort();
      this.#abortController = null;
    }
    this.#speakPromise = null;
    this.#clearPrefetchState();
    this.#currentRanges.clear();
    this.#currentMarkAnchors.clear();
    this.#lastMark = null;
    this.#docCache = null;
    this.#docInvalidated = false;
    this.#highlightManager.resetStyle();
    this.#highlightRange = null;
    this.#domIterator?.dispose();
    this.#domIterator = null;
    this.#textIterator = null;
    try {
      await this.#client.stop();
      await this.#client.shutdown();
    } catch (e) {
      logError('[TTS] shutdown() error', e);
    } finally {
      this.#setState('stopped');
      log('[TTS] shutdown() 完成', 'info');
    }
  }

  async notifyDocumentUpdated(): Promise<void> {
    if (this.#disposed) return;
    if (this.#state === 'stopped') return;

    const seq = ++this.#notifySeq;
    try {
      this.#docInvalidated = true;
      this.#highlightManager.resetStyle();
      this.#highlightRange = null;

      const docData = await this.#rendererAdapter.getDocumentDataWithRetry(
        TTSController.#DOC_DATA_MAX_RETRIES,
        TTSController.#DOC_DATA_RETRY_DELAY,
      );
      if (seq !== this.#notifySeq) return;
      if (!docData || docData.type !== 'dom') return;

      const rootEl = 'body' in docData.doc ? (docData.doc as Document).body : docData.doc;
      const cache = createTextContentSearchCache(rootEl);
      if (seq !== this.#notifySeq) return;
      this.#docCache = cache;
      if (!cache) return;

      const mark = this.#lastMark;
      if (!mark) return;
      const anchor = this.#currentMarkAnchors.get(mark);
      if (!anchor) return;

      const range = findRangeByTextQuote(cache, anchor);
      if (!range) return;

      this.#highlightRange = range;
      this.#highlightManager.apply(range);
      if (this.#state === 'playing') {
        this.#highlightManager.maybeScrollIntoView(range);
      }
    } catch (e) {
      logError('[TTS] notifyDocumentUpdated error', e);
    }
  }

  // --- 内部实现 ---

  /** 大文本块阈值，超过此长度视为 block 分割失效 */
  static readonly #LARGE_BLOCK_THRESHOLD = 5000;

  /** DOM 路径：使用 foliate-js TTS 类 */
  async #startDomPath(docOrEl: Document | Element, visibleStart?: TTSVisibleStart | null): Promise<boolean> {
    log('[TTS] #startDomPath 开始', 'info');

    // 检查文档是否包含有效文本
    const bodyEl = 'body' in docOrEl ? (docOrEl as Document).body : docOrEl;
    const bodyText = bodyEl.textContent?.trim();
    log(`[TTS] #startDomPath 文档文本长度=${bodyText?.length ?? 0}, 前60字="${bodyText?.substring(0, 60)}..."`, 'info');
    if (!bodyText) {
      log('[TTS] 文档内容为空，无法朗读', 'warn');
      this.#setState('stopped');
      return false;
    }

    this.#domIterator?.dispose();
    this.#domIterator = new DomSSMLIterator(docOrEl, (range: Range) => this.#handleHighlight(range));

    // 根据可见位置决定从哪里开始朗读
    const { ssml, usedFrom, fromError } = this.#domIterator.start(visibleStart);
    if (visibleStart?.type === 'range') {
      if (usedFrom) {
        log('[TTS] #startDomPath: 使用 from(range) 从可见位置开始', 'info');
      } else if (fromError) {
        log(`[TTS] #startDomPath: from(range) 失败，降级为 start(): ${fromError}`, 'warn');
      }
    }
    // 保存当前 block 的 ranges 快照，避免 prefetch 覆盖
    this.#currentRanges = this.#domIterator.getRangesSnapshot();
    this.#docInvalidated = false;
    this.#docCache = null;
    log(`[TTS] #startDomPath foliate-js SSML: ${ssml ? `长度=${ssml.length}, 文本="${ssml.replace(/<[^>]+>/g, '').substring(0, 60)}..."` : 'null'}`, 'info');
    if (!ssml?.trim()) {
      // SSML 为空，降级到纯文本路径
      if (bodyText) {
      log('[TTS] foliate-js 未生成有效 SSML，降级为纯文本路径', 'warn');
        this.#domIterator.dispose();
        this.#domIterator = null;
        return await this.#startTextPath(bodyText);
      }
      this.#setState('stopped');
      return false;
    }

    // 检查首段 SSML 文本长度，过长说明 block 分割失效（如 HTML 无 block 标签）
    const textLength = ssml.replace(/<[^>]+>/g, '').length;
    if (textLength > TTSController.#LARGE_BLOCK_THRESHOLD) {
        log('[TTS] SSML 文本块过长，降级为纯文本路径', 'warn');
      this.#domIterator.dispose();
      this.#domIterator = null;
      return await this.#startTextPath(bodyText);
    }

    await this.#speak(ssml);
    return this.#state === 'playing';
  }

  /** 纯文本路径：使用 TextBlockIterator 逐段生成 SSML */
  async #startTextPath(text: string, visibleStart?: TTSVisibleStart | null): Promise<boolean> {
    log(`[TTS] #startTextPath 输入文本长度=${text.length}，前50字: "${text.substring(0, 50)}"`, 'info');
    if (!text.trim()) {
      log('[TTS] #startTextPath 文本为空', 'warn');
      this.#setState('stopped');
      return false;
    }
    this.#textIterator = new TextSSMLIterator(text);
    this.#docInvalidated = false;
    this.#docCache = null;

    // 根据可见位置偏移从指定位置开始
    let ssml: string | null;
    if (visibleStart?.type === 'offset' && visibleStart.offset > 0) {
      ssml = this.#textIterator.start(visibleStart);
      log(`[TTS] #startTextPath: 使用 startFrom(${visibleStart.offset}) 从偏移位置开始`, 'info');
    } else {
      ssml = this.#textIterator.start();
    }
    log(`[TTS] #startTextPath 生成SSML: ${ssml ? `长度=${ssml.length}` : 'null'}`, 'info');
    if (!ssml?.trim()) {
      log('[TTS] #startTextPath SSML为空', 'warn');
      this.#setState('stopped');
      return false;
    }
    await this.#speak(ssml);
    return this.#state === 'playing';
  }

  /** 核心朗读逻辑 */
  async #speak(ssml: string | undefined): Promise<void> {
    if (this.#disposed) return;

    // 中断当前朗读任务（不触发 stopped 状态变化）
    if (this.#abortController) {
      this.#abortController.abort();
      this.#abortController = null;
    }
    await this.#client.stop();

    if (!ssml) {
      this.#emptyCount++;
      if (this.#emptyCount < 10) {
        await this.#forward();
      }
      return;
    }
    this.#emptyCount = 0;

    const processed = preprocessSSML(ssml);
    const { plainText, marks } = parseSSMLMarks(processed);
    const { plainText: anchorText, marks: anchorMarks } = parseSSMLMarks(ssml);
    const currentPage = (this.#renderer as any).getCurrentPage?.() ?? '?';
    log(`[TTS] #speak: page=${currentPage}, marks数=${marks.length}, 文本="${plainText.substring(0, 60)}${plainText.length > 60 ? '...' : ''}"`, 'info');
    if (!plainText.trim() || marks.length === 0) {
      log('[TTS] #speak: 无有效文本或marks，跳到下一段', 'warn');
      await this.#forward();
      return;
    }

    const anchors = new Map<string, TextQuote>();
    const contextLen = 24;
    for (const m of anchorMarks) {
      const prefixStart = Math.max(0, m.offset - contextLen);
      const suffixEnd = Math.min(anchorText.length, m.offset + m.text.length + contextLen);
      anchors.set(m.name, {
        quote: m.text,
        prefix: anchorText.slice(prefixStart, m.offset),
        suffix: anchorText.slice(m.offset + m.text.length, suffixEnd),
      });
    }
    this.#currentMarkAnchors = anchors;

    // 检测语言并通知客户端
    const lang = parseSSMLLang(processed);
    this.#client.setPrimaryLang(lang);
    log(
      `[TTS] 播放参数: engine=${this.#client.name} voiceId=${this.#client.getVoiceId() || 'default'} lang=${lang} rate=${this.#client.getRate()}`,
      'info',
    );

    this.#abortController = new AbortController();
    const { signal } = this.#abortController;

    this.#setState('playing');

    // 朗读开始后立即预取下一段 SSML
    this.#prefetch();

    this.#speakPromise = (async () => {
      try {
        const iter = this.#client.speak(processed, signal);
        let lastCode: string | undefined;

        for await (const event of iter) {
          if (signal.aborted) return;

          lastCode = event.code;
          if (event.code === 'boundary' && event.mark) {
            this.#emitReadingActivity(false);
            await this.#onMark?.(event.mark);
            this.#setMarkFromCache(event.mark);
          }
        }

        // 当前段朗读完成，自动前进到下一段
        if (lastCode === 'end' && this.#state === 'playing' && !signal.aborted && !this.#disposed) {
          await this.#forward();
        }
      } catch (e) {
        if (!signal.aborted) {
        logError('[TTS] speak error', e);
          this.#setState('stopped');
        }
      }
    })();

    await this.#speakPromise;
  }

  /**
   * 从缓存的 ranges 快照中取 Range 并高亮
   * 不依赖 foliate-js 内部的可变 #ranges，避免 prefetch 覆盖导致错位
   */
  #setMarkFromCache(mark: string): void {
    this.#lastMark = mark;

    if (this.#docInvalidated && this.#docCache) {
      const anchor = this.#currentMarkAnchors.get(mark);
      if (anchor) {
        const range = findRangeByTextQuote(this.#docCache, anchor);
        if (range) {
          this.#handleHighlight(range);
          return;
        }
      }
    }

    const range = this.#currentRanges.get(mark);
    if (range) {
      const text = range.toString();
      log(`[TTS] setMark(${mark}) 从缓存取 Range: "${text.substring(0, 40)}${text.length > 40 ? '...' : ''}"`, 'info');
      this.#handleHighlight(range.cloneRange());
    } else {
      log(`[TTS] setMark(${mark}) 缓存中无对应 Range`, 'warn');
      this.#domIterator?.setMark(mark);
    }
  }

  /** 高亮回调：TTS 引擎在 setMark 时调用，标记当前朗读位置 */
  #handleHighlight(range: Range): void {
    const text = range.toString().substring(0, 40);
    log(`[TTS] 高亮: "${text}${range.toString().length > 40 ? '...' : ''}"`, 'info');
    this.#highlightRange = range;
    this.#highlightManager.apply(range);
    this.#highlightManager.maybeScrollIntoView(range);
  }

  /**
   * 预取下一个 block 的 SSML 到缓冲区
   * 在当前 block 朗读期间调用，减少 block 切换延迟
   */
  #prefetch(): void {
    if (this.#disposed) return;

    this.#prefetchAdvance.prefetch(() => {
      if (this.#domIterator) {
        const ssml = this.#domIterator.next();
        log(`[TTS] prefetch: 预取下一段 SSML ${ssml ? `长度=${ssml.length}` : 'null'}`, 'info');
        return ssml;
      }
      if (this.#textIterator) {
        return this.#textIterator.next();
      }
      return null;
    }, () => {});
  }

  /** 清理预取和预翻页的所有状态 */
  #clearPrefetchState(): void {
    this.#prefetchAdvance.clear();
    this.#textIterator = null;
  }

  /** 前进到下一段，优先从预取缓冲区取，当前页/章节遍历完后自动翻页 */
  async #forward(): Promise<void> {
    if (this.#disposed) {
      log('[TTS] #forward() 被拦截：controller 已销毁', 'warn');
      return;
    }
    await this.#prefetchAdvance.awaitPrefetch();

    // 优先从预取缓冲区取 SSML
    const prefetched = this.#prefetchAdvance.consumePrefetched();
    if (prefetched) {
      log('[TTS] #forward: 使用预取 SSML', 'info');
      // 预取触发了 next()，此时 foliate-js 内部 #ranges 已更新为新 block
      // 保存新 block 的 ranges 快照
      if (this.#domIterator) {
        this.#currentRanges = this.#domIterator.getRangesSnapshot();
      }
      await this.#speak(prefetched);
      return;
    }

    // 预取为空，检查是否有预备翻页结果
    if (this.#prefetchAdvance.hasAdvancePending) {
      const advanced = await this.#prefetchAdvance.consumeAdvanceResult();
      if (advanced) {
        // 翻页成功，清理旧实例并重新开始
        this.#domIterator?.dispose();
        this.#domIterator = null;
        this.#textIterator = null;
        this.#highlightRange = null;
        this.#highlightManager.resetStyle();
        const success = await this.start(true);
        if (success) return;
      }
    }

    // 没有预翻页任务，尝试同步翻页（兜底）
    const advanced = await this.#rendererAdapter.advanceForTTS((err) => {
      logError('[TTS] advanceForTTS error', err);
    });
    if (advanced) {
      this.#domIterator?.dispose();
      this.#domIterator = null;
      this.#textIterator = null;
      this.#highlightRange = null;
      this.#highlightManager.resetStyle();
      const success = await this.start(true);
      if (success) return;
    }

    // 无法前进了，停止朗读
    this.#setState('stopped');
  }
}

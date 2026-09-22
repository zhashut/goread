/**
 * TXT 渲染器
 * 实现纯文本文件的阅读渲染与虚拟分页
 * 支持两种模式：
 * 1. 全量模式（默认）：一次加载全文内容
 * 2. 章节模式：按章节懒加载，配合预加载实现流畅阅读
 */

import {
  IBookRenderer,
  BookFormat,
  BookInfo,
  TocItem,
  RenderOptions,
  SearchResult,
  RendererCapabilities,
} from '../types';
import { registerRenderer } from '../registry';
import { logError } from '../../index';
import type {
  TTSContentProvider,
  TTSReadingPosition,
} from '../../tts/providers/TTSContentProvider';
import { TxtContentProvider } from '../../tts/providers/TxtContentProvider';
import { findFirstVisibleTextRange, rangeToTextQuote } from '../../../utils/ttsDOM';
import { generateTxtBookId } from './txtPreloader';
import { TXT_CHAPTER_OFFSET_MAX } from './constants';
import {
  useTxtRendererCore,
  useTxtDocumentLoader,
  useTxtProgressController,
  useTxtChapterWindowJump,
  useTxtChapterTitleMap,
  type PageRange,
  type TxtRendererCore,
  type TxtChapterCacheHook,
  type TxtDocumentLoader,
  type TxtProgressController,
  type ChapterTitleMap,
  type TxtChapterWindowJumpHook,
  type TxtChapterWindowOptions,
  type TxtChapterTitleMapHook,
} from './hooks';
import { TxtBookMeta } from './txtCacheService';

/** 渲染器加载选项 */
export interface TxtLoadOptions {
  /** 使用章节加载模式（默认 false） */
  useChapterMode?: boolean;
  /** 跳过预加载缓存检查 */
  skipPreloaderCache?: boolean;
  /** 初始进度（0-1） */
  startProgress?: number;
  /** 直接指定初始章节索引（0-based），优先于 startProgress */
  startChapterIndex?: number;
}

export type { TxtChapterWindowOptions } from './hooks';

/**
 * TXT 渲染器实现
 * 支持横向分页和纵向滚动阅读
 */
export class TxtRenderer implements IBookRenderer {
  readonly format: BookFormat = 'txt';
  readonly capabilities: RendererCapabilities = {
    supportsBitmap: false,
    supportsDomRender: true,
    supportsPagination: true,
    supportsSearch: false,
  };

  // 内部状态
  private _content: string = '';
  private _encoding: string = '';
  private _pages: PageRange[] = [];
  private _toc: TocItem[] = [];
  private _currentPage: number = 1;
  private _container: HTMLElement | null = null;
  private _filePath: string | null = null;
  private _bookId: string | null = null;
  private _isReady: boolean = false;
  private _lastRenderOptions: RenderOptions | null = null;
  private _isVerticalMode: boolean = false;
  private _scrollHeight: number = 0;
  private _core: TxtRendererCore;
  private _loader: TxtDocumentLoader;
  private _progress: TxtProgressController;
  private _windowJump: TxtChapterWindowJumpHook;
  private _titleMap: TxtChapterTitleMapHook;
  // 精确进度（浮点数），用于撤回跳转等场景的精确定位
  private _currentPreciseProgress: number = 1;
  private _bookPreciseProgress: number = 1;

  // 章节模式相关
  private _useChapterMode: boolean = false;
  private _chapterCache: TxtChapterCacheHook | null = null;
  private _bookMeta: TxtBookMeta | null = null;
  private _currentChapterIndex: number = 0;
  private _currentHideDivider: boolean = false;
  private _verticalPageTops: number[] = [];
  private _verticalPageHeights: number[] = [];
  // 记录当前 content 中包含哪些章节
  private _loadedChapters = new Set<number>();
  // 各已加载章节在拼接后 _content 中的起始偏移
  private _chapterContentOffsets = new Map<number, number>();
  // 章节标题映射缓存（内容变化时需清除）
  private _cachedTitleMap: ChapterTitleMap | null = null;

  // 分页版本号，每次异步精确分页替换后自增，用于 scroll handler 检测数据变化
  private _pagesVersion: number = 0;
  // 当前分页所属的渲染模式（横向/纵向），模式切换时用于失效旧分页
  // 横纵容器样式不同（padding / overflow），跨模式复用分页会导致边界错误
  private _pagesMode: 'vertical' | 'horizontal' | null = null;

  // 目录更新回调，分页完成后触发，用于通知 UI 层刷新目录数据
  onTocUpdated?: (toc: TocItem[]) => void;

  constructor() {
    this._core = useTxtRendererCore();
    this._loader = useTxtDocumentLoader({
      setUseChapterMode: (value) => {
        this._useChapterMode = value;
      },
      getUseChapterMode: () => this._useChapterMode,
      setContent: (value) => {
        this._content = value;
      },
      setEncoding: (value) => {
        this._encoding = value;
      },
      setToc: (value) => {
        this._toc = value;
      },
      setIsReady: (value) => {
        this._isReady = value;
      },
      setChapterCache: (value) => {
        this._chapterCache = value;
      },
      getChapterCache: () => this._chapterCache,
      setBookMeta: (value) => {
        this._bookMeta = value;
      },
      getBookMeta: () => this._bookMeta,
      setCurrentChapterIndex: (value) => {
        this._currentChapterIndex = value;
      },
      getCurrentChapterIndex: () => this._currentChapterIndex,
    });
    this._progress = useTxtProgressController({
      getUseChapterMode: () => this._useChapterMode,
      getChapterCount: () => this.getChapterCount(),
      getPageCount: () => this.getPageCount(),
      getCurrentChapterIndex: () => this._currentChapterIndex,
      getContainer: () => this._container,
      isVerticalMode: () => this._isVerticalMode,
      getScrollHeight: () => this._scrollHeight,
      getVerticalPageTops: () => this._verticalPageTops,
      setVerticalPageTops: (tops) => {
        this._verticalPageTops = tops;
      },
      getVerticalPageHeights: () => this._verticalPageHeights,
      setVerticalPageHeights: (heights) => {
        this._verticalPageHeights = heights;
      },
      getCurrentPreciseProgress: () => this._currentPreciseProgress,
      setCurrentPreciseProgress: (value) => {
        this._currentPreciseProgress = value;
      },
      getBookPreciseProgress: () => this._bookPreciseProgress,
      setBookPreciseProgress: (value) => {
        this._bookPreciseProgress = value;
      },
      getCurrentPage: () => this._currentPage,
      setCurrentPage: (value) => {
        this._currentPage = value;
      },
      goToPage: (page) => this.goToPage(page),
      goToChapter: (chapterIndex, renderMode) =>
        this.goToChapter(chapterIndex, renderMode),
      // 横向章节模式：章节精确进度 → 章内页精确定位（供 jumpToPreciseProgress 使用）
      goToChapterPage: (chapterIndex, pageInChapter) =>
        this.goToChapterPage(chapterIndex, pageInChapter),
      getChapterPageFromPrecise: (precise) => this.getChapterPageFromPrecise(precise),
      getCharOffsetFromProgress: (progress) => this.getCharOffsetFromProgress(progress),
      jumpToCharOffset: (charOffset) => this.jumpToCharOffset(charOffset),
      getChapterIndexByPage: (pageIndex) => this.getChapterIndexByPage(pageIndex),
    });

    this._windowJump = useTxtChapterWindowJump({
      getIsReady: () => this._isReady,
      getUseChapterMode: () => this._useChapterMode,
      getIsVerticalMode: () => this._isVerticalMode,
      getContainer: () => this._container,
      getBookMeta: () => this._bookMeta,
      getChapterCache: () => this._chapterCache,

      setContent: (value) => {
        this._content = value;
      },
      setPages: (value) => {
        this._pages = value;
      },
      setCurrentChapterIndex: (value) => {
        this._currentChapterIndex = value;
      },
      setBookPreciseProgress: (value) => {
        this._bookPreciseProgress = value;
      },
      resetLoadedChapters: (indices) => {
        this._loadedChapters.clear();
        for (const idx of indices) this._loadedChapters.add(idx);
      },
      resetChapterContentOffsets: (pairs) => {
        this._chapterContentOffsets.clear();
        for (const { chapterIndex, offset } of pairs) {
          this._chapterContentOffsets.set(chapterIndex, offset);
        }
      },
      invalidateTitleMapCache: () => {
        this._invalidateTitleMapCache();
      },

      estimatePages: (content, chapterIndex, baseOffset) =>
        this._estimatePages(content, chapterIndex, baseOffset),
      bumpPagesVersion: () => {
        this._pagesVersion++;
      },
      renderFullContent: (container) =>
        this.renderFullContent(container, this._lastRenderOptions || {}),
      convertChapterPreciseToVirtualPrecise: (progress) =>
        this.convertChapterPreciseToVirtualPrecise(progress),
      scrollToVirtualPage: (virtualPrecise, viewportHeight) => {
        this.scrollToVirtualPage(virtualPrecise, viewportHeight);
      },
      getCharOffsetFromProgress: (progress) =>
        this.getCharOffsetFromProgress(progress),
      scrollToCharOffset: (charOffset) => this.scrollToCharOffset(charOffset),
      preloadAdjacentChapters: (chapterIndex) =>
        this.preloadAdjacentChapters(chapterIndex),
      jumpToPreciseProgress: (progress) => this.jumpToPreciseProgress(progress),
    });

    this._titleMap = useTxtChapterTitleMap({
      getUseChapterMode: () => this._useChapterMode,
      getBookMeta: () => this._bookMeta,
      getToc: () => this._toc,
      getContentLength: () => this._content.length,
      getCurrentChapterIndex: () => this._currentChapterIndex,
      getChapterContentOffsetsPairs: () =>
        Array.from(this._chapterContentOffsets.entries()).map(([chapterIndex, offset]) => ({
          chapterIndex,
          offset,
        })),
      getCachedTitleMap: () => this._cachedTitleMap,

      setCachedTitleMap: (value) => {
        this._cachedTitleMap = value;
      },
      ensureChapterOffsetsInitialized: () => {
        if (this._chapterContentOffsets.size === 0 && this._content.length > 0) {
          this._chapterContentOffsets.set(this._currentChapterIndex, 0);
          this._loadedChapters.add(this._currentChapterIndex);
        }
      },
    });
  }

  private _mergeRenderOptions(options?: RenderOptions): RenderOptions {
    const next: RenderOptions = { ...(options || {}) };
    if (typeof next.hideDivider === 'boolean') {
      this._currentHideDivider = next.hideDivider;
    } else {
      next.hideDivider = this._currentHideDivider;
    }
    return next;
  }

  get isReady(): boolean {
    return this._isReady;
  }

  /** 加载 TXT 文档 */
  async loadDocument(filePath: string, options?: TxtLoadOptions): Promise<BookInfo> {
    this._filePath = filePath;
    this._bookId = generateTxtBookId(filePath);
    return await this._loader.loadDocument(filePath, options);
  }

  /** 获取目录 */
  async getToc(): Promise<TocItem[]> {
    return this._toc;
  }

  /** 获取总页数 */
  getPageCount(): number {
    return this._pages.length || 1;
  }

  /** 获取当前页码 */
  getCurrentPage(): number {
    return this._currentPage;
  }

  /** 获取分页版本号，用于 scroll handler 检测异步分页替换 */
  getPagesVersion(): number {
    return this._pagesVersion;
  }

  /** 获取精确进度（浮点数），用于撤回跳转等场景 */
  getPreciseProgress(): number {
    return this._progress.getPreciseProgress();
  }

  /** 更新精确进度，由滚动监听调用 */
  updatePreciseProgress(progress: number): void {
    this._progress.updatePreciseProgress(progress);
  }

  updateDividerVisibility(hidden: boolean): void {
    this._currentHideDivider = hidden;
    if (this._lastRenderOptions) {
      this._lastRenderOptions = { ...this._lastRenderOptions, hideDivider: hidden };
    }

    const container = this._container;
    if (container) {
      const dividers = container.querySelectorAll('.txt-page-divider') as NodeListOf<HTMLElement>;
      dividers.forEach((d) => {
        d.style.display = hidden ? 'none' : 'block';
      });
      if (this._isVerticalMode) {
        requestAnimationFrame(() => {
          this.refreshVerticalPageMap(container);
        });
      }
    }
  }

  refreshVerticalPageMap(container?: HTMLElement): void {
    this._progress.refreshVerticalPageMap(container);
  }

  getVirtualPreciseByScrollTop(scrollTop: number): number {
    return this._progress.getVirtualPreciseByScrollTop(scrollTop);
  }

  convertChapterPreciseToVirtualPrecise(chapterPrecise: number): number {
    return this._progress.convertChapterPreciseToVirtualPrecise(chapterPrecise);
  }

  convertVirtualPreciseToChapterPrecise(virtualPrecise: number): number {
    return this._progress.convertVirtualPreciseToChapterPrecise(virtualPrecise);
  }

  async jumpToPreciseProgress(progress: number): Promise<void> {
    if (!this._isReady) return;
    await this._progress.jumpToPreciseProgress(progress);
  }

  async jumpToPreciseProgressWithWindow(
    progress: number,
    window: TxtChapterWindowOptions = { includePrev: true, includeNext: true }
  ): Promise<void> {
    if (!this._isReady) return;
    await this._windowJump.jumpToPreciseProgressWithWindow(progress, window);
  }

  /** 跳转到指定页（横向模式，支持浮点数精确进度） */
  async goToPage(page: number): Promise<void> {
    // 记录精确进度（可能是浮点数）
    this._currentPreciseProgress = page;

    // 取整数部分用于实际分页渲染
    const intPage = Math.floor(page);
    if (intPage < 1 || intPage > this._pages.length) {
      return;
    }
    this._currentPage = intPage;
    // 章节模式下回写章节精确进度（章内页码 → 章节进度），
    // 保证横向/纵向共用同一进度坐标系，切换模式时位置不丢
    if (this._useChapterMode && this._pages.length > 0) {
      this._bookPreciseProgress = this.getPreciseFromChapterPage(intPage);
    }
    // 确保有容器时才渲染
    if (this._container) {
      await this.renderPage(intPage, this._container, this._lastRenderOptions || {});
    }
    this.onPageChange?.(intPage);
  }

  /**
   * 跳转到指定章节的指定章内页（横向模式）
   * 与 goToChapter 的区别：支持章内多页定位，并回写章节精确进度
   */
  async goToChapterPage(
    chapterIndex: number,
    pageInChapter: number
  ): Promise<void> {
    if (!this._useChapterMode || !this._chapterCache || !this._bookMeta) {
      return;
    }
    if (chapterIndex < 0 || chapterIndex >= this._bookMeta.chapters.length) {
      return;
    }

    // 章节变化时先切换章节（内部会清空分页并按横向模式渲染章首页）
    if (chapterIndex !== this._currentChapterIndex) {
      await this.goToChapter(chapterIndex, 'horizontal');
    } else if (this._pages.length === 0 && this._container) {
      // 同章但分页未计算（如首次进入横向），先补算分页
      await this._calculatePages(this._container, this._lastRenderOptions || {});
    }

    // 横向模式：渲染目标章内页（goToPage 内部会回写章节精确进度）
    if (this._container && this._pages.length > 0) {
      const validPage = Math.min(
        Math.max(1, pageInChapter),
        this._pages.length
      );
      await this.goToPage(validPage);
    }
  }

  /**
   * 按章节精确进度定位章内页（跨章安全）
   * 与 goToChapterPage 的区别：先把 _pages 切到目标章再换算页号，
   * 避免调用方在目标章页数未知时用当前章页数算错
   */
  async goToChapterPageAtProgress(
    chapterIndex: number,
    precise: number
  ): Promise<void> {
    if (!this._useChapterMode || !this._chapterCache || !this._bookMeta) {
      return;
    }
    if (chapterIndex < 0 || chapterIndex >= this._bookMeta.chapters.length) {
      return;
    }

    // 切章（若不同）：goToChapter 会清空分页并按横向模式渲染章首页
    if (chapterIndex !== this._currentChapterIndex) {
      await this.goToChapter(chapterIndex, 'horizontal');
    } else if (this._pages.length === 0 && this._container) {
      // 同章但分页未计算（如重排后失效），先补算
      await this._calculatePages(this._container, this._lastRenderOptions || {});
    }

    // 此时 _pages 已是目标章分页，用精确进度换算章内页
    if (this._container && this._pages.length > 0) {
      const pageInChapter = this.getChapterPageFromPrecise(precise);
      await this.goToPage(pageInChapter);
    }
  }

  /** 当前章内是否还有下一页（横向章节模式） */
  hasNextPageInChapter(): boolean {
    if (this._useChapterMode && !this._isVerticalMode) {
      return this._currentPage < this._pages.length;
    }
    return false;
  }

  /** 翻到章内下一页（横向章节模式）；章末返回 false */
  async goToNextPageInChapter(): Promise<boolean> {
    if (!this._useChapterMode || this._isVerticalMode) return false;
    if (this._currentPage >= this._pages.length) return false;
    await this.goToPage(this._currentPage + 1);
    return true;
  }

  /** 当前章内是否还有上一页（横向章节模式） */
  hasPrevPageInChapter(): boolean {
    if (this._useChapterMode && !this._isVerticalMode) {
      return this._currentPage > 1;
    }
    return false;
  }

  /** 翻到章内上一页（横向章节模式）；章首返回 false */
  async goToPrevPageInChapter(): Promise<boolean> {
    if (!this._useChapterMode || this._isVerticalMode) return false;
    if (this._currentPage <= 1) return false;
    await this.goToPage(this._currentPage - 1);
    return true;
  }

  /**
   * 章节精确进度 → 全局字符偏移
   * offset 语义 = 章内字符比例：offset = (charOffset - char_start) / (char_end - char_start)
   * 注意：返回值为 JS 字符串索引语义（与 PageRange.startOffset 一致）；
   * 中文（BMP）下与后端 char_start/char_end（Unicode 字符数）数值一致
   */
  getCharOffsetFromProgress(progress: number): number {
    if (!this._bookMeta || this._bookMeta.chapters.length === 0) {
      return 0;
    }
    const chapters = this._bookMeta.chapters;
    const chapterCount = chapters.length;
    const chapterInt = Math.min(
      Math.max(1, Math.floor(progress)),
      chapterCount
    );
    const offset = Math.min(
      TXT_CHAPTER_OFFSET_MAX,
      Math.max(0, progress - chapterInt)
    );
    const chapter = chapters[chapterInt - 1]!;
    const span = Math.max(1, chapter.char_end - chapter.char_start);
    return chapter.char_start + Math.floor(offset * span);
  }

  /**
   * 全局字符偏移 → 章节精确进度（chapterIndex + 1 + 章内字符比例）
   * 章节边界按字符偏移与 char_start/char_end 精确比较，无浮点抖动
   */
  getProgressFromCharOffset(charOffset: number): number {
    if (!this._bookMeta || this._bookMeta.chapters.length === 0) {
      return 1;
    }
    const chapters = this._bookMeta.chapters;
    const totalChars = this._bookMeta.total_chars || 1;
    const clamped = Math.min(Math.max(0, charOffset), totalChars);
    // 二分查找字符偏移所在章节
    let lo = 0;
    let hi = chapters.length - 1;
    let chapterIndex = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (clamped >= chapters[mid]!.char_start) {
        chapterIndex = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    const chapter = chapters[chapterIndex]!;
    const span = Math.max(1, chapter.char_end - chapter.char_start);
    const ratio = (clamped - chapter.char_start) / span;
    const offset = Math.min(TXT_CHAPTER_OFFSET_MAX, Math.max(0, ratio));
    return chapterIndex + 1 + offset;
  }

  /**
   * 取当前视口/页面对应的全局字符偏移（模式无关，保存进度用）
   * - 纵向：视口顶部段落（data-char-offset，相对当前已加载内容窗口）+ 段内比例 → 全书字符偏移
   * - 横向：当前页首字符偏移（精确）
   */
  getCharOffsetFromViewport(): number | null {
    const container = this._container;
    if (!container) return null;

    if (this._isVerticalMode) {
      const scrollTop = container.scrollTop + 1;
      const els = container.querySelectorAll('[data-char-offset]');
      if (els.length === 0) return null;
      // 找最后一个 offsetTop <= scrollTop 的段落（视口顶部所在段）
      let idx = 0;
      for (let i = 0; i < els.length; i++) {
        const top = (els[i] as HTMLElement).offsetTop;
        if (top <= scrollTop) idx = i;
        else break;
      }
      const el = els[idx] as HTMLElement | undefined;
      if (!el) return null;
      const relStart = Number(el.getAttribute('data-char-offset')) || 0;
      const len = Number(el.getAttribute('data-char-length')) || 0;
      // 段内比例：视口顶部在段落内的相对位置
      const elTop = el.offsetTop;
      const elHeight = el.offsetHeight || 1;
      const ratio = Math.max(0, Math.min(1, (scrollTop - elTop) / elHeight));
      // 相对已加载内容窗口的字符偏移 → 全书字符偏移
      return this._contentOffsetToCharOffset(relStart + Math.floor(ratio * len));
    }

    // 横向：当前页首字符偏移（相对章节 → 全书偏移，保持统一基准）
    const pageIndex = Math.max(0, this._currentPage - 1);
    const page = this._pages[pageIndex];
    if (!page) return null;
    const chapter = this._bookMeta?.chapters[this._currentChapterIndex];
    return chapter ? chapter.char_start + page.startOffset : page.startOffset;
  }

  /**
   * 相对已加载内容窗口的字符偏移 → 全书字符偏移
   * 纵向窗口可能拼接多章（_chapterContentOffsets 记录每章在窗口中的起始偏移）
   */
  private _contentOffsetToCharOffset(contentOffset: number): number | null {
    if (!this._bookMeta || this._chapterContentOffsets.size === 0) {
      return contentOffset;
    }
    // 找 contentOffset 所属章节（_chapterContentOffsets 的键按章节序递增）
    let chapterIndex = -1;
    for (const [idx, off] of this._chapterContentOffsets) {
      if (off <= contentOffset) chapterIndex = idx;
      else break;
    }
    if (chapterIndex < 0) return null;
    const chapter = this._bookMeta.chapters[chapterIndex];
    if (!chapter) return null;
    const chapterContentStart = this._chapterContentOffsets.get(chapterIndex) ?? 0;
    return chapter.char_start + (contentOffset - chapterContentStart);
  }

  /**
   * 全书字符偏移 → 相对已加载内容窗口的字符偏移
   * 目标章节未加载（不在 _chapterContentOffsets 中）时返回 null
   */
  private _charOffsetToContentOffset(charOffset: number): number | null {
    if (!this._bookMeta || this._chapterContentOffsets.size === 0) {
      return charOffset;
    }
    const progress = this.getProgressFromCharOffset(charOffset);
    const chapterIndex = Math.min(
      Math.max(0, Math.floor(progress) - 1),
      this._bookMeta.chapters.length - 1
    );
    if (!this._chapterContentOffsets.has(chapterIndex)) return null;
    const chapter = this._bookMeta.chapters[chapterIndex];
    const chapterContentStart = this._chapterContentOffsets.get(chapterIndex) ?? 0;
    return chapterContentStart + (charOffset - chapter.char_start);
  }

  /**
   * 定位到指定字符偏移（纵向：滚动到对应段落；横向：翻到对应页）
   * 纵向段内按比例换算滚动位置（段落边界精确、段内近似）
   */
  async scrollToCharOffset(charOffset: number): Promise<void> {
    const container = this._container;
    if (!container) return;

    if (this._isVerticalMode) {
      // 全书字符偏移 → 相对已加载内容窗口（目标章节必须已加载）
      const contentOffset = this._charOffsetToContentOffset(charOffset);
      if (contentOffset === null) return;
      const els = container.querySelectorAll('[data-char-offset]');
      if (els.length === 0) return;
      // 找包含 contentOffset 的段落（最后一个 start <= contentOffset）
      let idx = 0;
      for (let i = 0; i < els.length; i++) {
        const start = Number((els[i] as HTMLElement).getAttribute('data-char-offset')) || 0;
        if (start <= contentOffset) idx = i;
        else break;
      }
      const el = els[idx] as HTMLElement | undefined;
      if (!el) return;
      const start = Number(el.getAttribute('data-char-offset')) || 0;
      const len = Number(el.getAttribute('data-char-length')) || 0;
      const ratio = len <= 0 ? 0 : Math.min(1, Math.max(0, (contentOffset - start) / len));
      // 目标位于视口顶部
      container.scrollTop = Math.max(0, el.offsetTop + el.offsetHeight * ratio);
      // 同步进度基准（滚动监听随后会按真实 scrollTop 校正）
      if (this._useChapterMode) {
        this._bookPreciseProgress = this.getProgressFromCharOffset(charOffset);
      } else {
        this._currentPreciseProgress = this.getProgressFromCharOffset(charOffset);
      }
      return;
    }

    // 横向：全书字符偏移 → 相对当前章 → 二分 _pages → 页
    console.log('[TxtRenderer] scrollToCharOffset H', {
      charOffset,
      fontSize: this._lastRenderOptions?.fontSize,
      theme: this._lastRenderOptions?.theme,
      pagesLen: this._pages.length,
    });
    if (this._pages.length === 0 && container) {
      await this._calculatePages(container, this._lastRenderOptions || {});
    }
    if (this._pages.length === 0) return;
    const chapter = this._bookMeta?.chapters[this._currentChapterIndex];
    const relOffset = chapter
      ? Math.max(0, charOffset - chapter.char_start)
      : charOffset;
    // 二分找包含 relOffset 的页；章末边界（offset=0.9999 换算的字符偏移可能落在
    // 最后一行换行符/行尾之后）不命中时兜底为最后一页，避免误跳第一页
    let pageIndex = this._pages.length - 1;
    for (let i = 0; i < this._pages.length; i++) {
      if (relOffset < (this._pages[i]!.endOffset ?? 0)) {
        pageIndex = i;
        break;
      }
    }
    await this.goToPage(pageIndex + 1);
  }

  /**
   * 模式无关的精确跳转：字符偏移 → 目标章节 → 该模式视图定位
   * 用于进入阅读 / 模式切换 / 进度恢复
   */
  async jumpToCharOffset(charOffset: number): Promise<void> {
    if (!this._isReady) return;

    if (this._useChapterMode && this._bookMeta) {
      const progress = this.getProgressFromCharOffset(charOffset);
      const targetChapterIndex = Math.min(
        Math.max(0, Math.floor(progress) - 1),
        this._bookMeta.chapters.length - 1
      );
      if (targetChapterIndex !== this._currentChapterIndex) {
        await this.goToChapter(
          targetChapterIndex,
          this._isVerticalMode ? 'vertical' : 'horizontal'
        );
      }
    }

    await this.scrollToCharOffset(charOffset);
  }

  /**
   * 章节精确进度 → 章内页码（1-based，横向模式）
   * 字符偏移语义：progress → 全书字符偏移 → 相对当前章 → 二分 _pages
   * 调用方必须保证 _pages 是目标章节的分页（如切章后）
   */
  getChapterPageFromPrecise(precise: number): number {
    if (this._pages.length === 0) return 1;
    const charOffset = this.getCharOffsetFromProgress(precise);
    const chapter = this._bookMeta?.chapters[this._currentChapterIndex];
    const relOffset = chapter ? charOffset - chapter.char_start : charOffset;
    for (let i = 0; i < this._pages.length; i++) {
      if (relOffset < (this._pages[i]!.endOffset ?? 0)) {
        return i + 1;
      }
    }
    return this._pages.length;
  }

  /**
   * 章内页码 → 章节精确进度（chapterIndex + 1 + 章内字符比例）
   * 页首相对章节偏移 → 全书字符偏移 → 章节进度
   */
  getPreciseFromChapterPage(pageInChapter: number): number {
    if (this._pages.length === 0) {
      return this._currentChapterIndex + 1;
    }
    const page = Math.min(Math.max(1, pageInChapter), this._pages.length);
    const pageStart = this._pages[page - 1]!.startOffset;
    const chapter = this._bookMeta?.chapters[this._currentChapterIndex];
    if (!chapter) {
      return this._currentChapterIndex + 1;
    }
    // 页首相对章节偏移 → 全书字符偏移 → 章节精确进度
    return this.getProgressFromCharOffset(chapter.char_start + pageStart);
  }

  /**
   * 使分页缓存失效，下次渲染时重新计算
   * 模式切换 / 字号变化 / 容器尺寸变化时由上层调用
   */
  invalidatePagination(): void {
    this._pages = [];
    this._pagesVersion++;
  }

  /**
   * 应用新的渲染选项（字号/主题/页距等）并使分页失效，不渲染
   * 配合 jumpToCharOffset 使用：先应用参数，再按字符偏移定位（横向必须走此路径，
   * 否则 _calculatePages/renderPage 会用旧 _lastRenderOptions 计算与渲染）
   */
  applyRenderOptions(options?: RenderOptions): void {
    const merged = this._mergeRenderOptions(options);
    console.log('[TxtRenderer] applyRenderOptions', {
      fontSize: merged?.fontSize,
      theme: merged?.theme,
      isVertical: this._isVerticalMode,
    });
    this._lastRenderOptions = merged;
    this.invalidatePagination();
    if (this._container) {
      this._core.applyStyles(this._container, merged, this._isVerticalMode);
    }
  }

  /**
   * 显式切换渲染模式（不重渲染，仅同步内部状态并使分页失效）
   * 模式切换后 _isVerticalMode 可能仍是旧值，且同章切模式时 goToChapter
   * 会 early return（不渲染），导致后续 scrollToCharOffset 等误走旧模式分支
   */
  switchMode(renderMode: 'vertical' | 'horizontal'): void {
    const nextVertical = renderMode === 'vertical';
    if (this._isVerticalMode !== nextVertical) {
      this._isVerticalMode = nextVertical;
      this._pages = [];
      this._pagesVersion++;
      this._pagesMode = null;
    }
  }

  /** 跳转到指定章节（章节模式）
   * @param renderMode 目标渲染模式；缺省时沿用当前内部模式（_isVerticalMode）
   * 注意：模式切换后 _isVerticalMode 可能是旧模式的残留值，
   * 调用方应显式传入目标模式，避免切到横向时误渲染整章
   */
  async goToChapter(
    chapterIndex: number,
    renderMode?: 'vertical' | 'horizontal'
  ): Promise<void> {
    if (!this._useChapterMode || !this._chapterCache || !this._bookMeta) {
      return;
    }

    if (chapterIndex < 0 || chapterIndex >= this._bookMeta.chapters.length) {
      return;
    }

    if (chapterIndex === this._currentChapterIndex) {
      // 确保当前章节在已加载集合中（初次加载时可能为空）
      if (!this._loadedChapters.has(chapterIndex)) {
        this._loadedChapters.add(chapterIndex);
      }
      return;
    }

    logError(`[TxtRenderer] 跳转到章节 ${chapterIndex}`).catch(() => { });

    // 加载新章节
    const chapter = await this._chapterCache.getChapter(chapterIndex);
    this._content = chapter.content;
    this._currentChapterIndex = chapterIndex;
    this._bookPreciseProgress = chapterIndex + 1;

    // 清空分页缓存，需要重新计算
    this._pages = [];

    // 重置已加载章节集合和内容偏移映射
    this._loadedChapters.clear();
    this._loadedChapters.add(chapterIndex);
    this._chapterContentOffsets.clear();
    this._chapterContentOffsets.set(chapterIndex, 0);
    this._invalidateTitleMapCache();

    // 如果有容器，按目标模式重新渲染
    if (this._container) {
      const targetMode = renderMode ?? (this._isVerticalMode ? 'vertical' : 'horizontal');
      if (targetMode === 'vertical') {
        await this.renderFullContent(this._container, this._lastRenderOptions || {});
      } else {
        await this.renderPage(1, this._container, this._lastRenderOptions || {});
      }
    }

    // 后台预加载相邻章节
    this._chapterCache.preloadAdjacentChapters(
      chapterIndex,
      this._bookMeta.chapters.length
    ).catch(() => { });
  }

  /** 获取已加载章节的最大索引 */
  getMaxLoadedChapterIndex(): number {
    if (this._loadedChapters.size === 0) return this._currentChapterIndex;
    return Math.max(...this._loadedChapters);
  }

  /**
   * 追加下一章（连续滚动模式）
   * 返回 true 表示成功追加，false 表示无法追加（已是最后一章或已加载）
   */
  async appendNextChapter(): Promise<boolean> {
    if (!this._useChapterMode || !this._chapterCache || !this._bookMeta) {
      return false;
    }

    // 基于已加载章节的最大索引来判断下一章
    const maxLoaded = this.getMaxLoadedChapterIndex();
    const nextIndex = maxLoaded + 1;
    if (nextIndex >= this._bookMeta.chapters.length) {
      return false;
    }

    // 防止重复加载
    if (this._loadedChapters.has(nextIndex)) {
      return false;
    }

    console.log(`[TxtRenderer] Appending chapter ${nextIndex}`);

    // 加载新章节
    const chapter = await this._chapterCache.getChapter(nextIndex);

    if (!this._container) return false;

    const options = this._lastRenderOptions || {};
    const currentContentLength = this._content.length;

    // 纵向滚动模式：使用轻量估算分页，保持 _pages 与 DOM wrapper 一致
    const estimatedPages = this._estimatePages(chapter.content, nextIndex, currentContentLength);

    // 记录新章节在拼接后 _content 中的起始偏移
    this._chapterContentOffsets.set(nextIndex, currentContentLength);
    this._content += chapter.content;
    this._invalidateTitleMapCache();

    const shiftedPages = estimatedPages.map(p => ({
      ...p,
      chapterIndex: nextIndex,
      index: p.index + this._pages.length,
      startOffset: p.startOffset + currentContentLength,
      endOffset: p.endOffset + currentContentLength
    }));
    this._pages.push(...shiftedPages);

    this._loadedChapters.add(nextIndex);

    // 追加 TOC 不依赖分页计算，直接处理
    this.onTocUpdated?.(this._toc);

    // DOM 即将变化，递增版本号让 scroll handler 跳过过渡期的页码计算
    this._pagesVersion++;

    // 渲染追加的内容
    const startPageIndex = this._pages.length - estimatedPages.length;

    const appendTitles = this._titleMap.getTitleMapForRange(currentContentLength, this._content.length);

    if (this._isVerticalMode) {
      this._core.appendContentWithPageDividers(
        this._container,
        chapter.content,
        estimatedPages,
        options,
        startPageIndex,
        appendTitles,
        // 段落标注基准：新章在拼接 _content 中的起始偏移（此前内容长度）
        currentContentLength
      );

      // 等一帧让 DOM 生效，刷新 pageMap
      await new Promise<void>(resolve => {
        requestAnimationFrame(() => {
          if (this._container) {
            this._scrollHeight = this._container.scrollHeight;
            this.refreshVerticalPageMap(this._container);
          }
          resolve();
        });
      });

    }

    // 预加载下一章
    this._chapterCache.preloadAdjacentChapters(
      nextIndex,
      this._bookMeta.chapters.length
    ).catch(() => { });

    return true;
  }

  /**
   * 基于内容行数和平均行高做轻量估算分页
   * 不涉及 DOM 测量，避免阻塞追加流程
   */
  private _estimatePages(
    content: string,
    chapterIndex: number,
    _baseOffset: number
  ): PageRange[] {
    // 用现有分页数据估算平均每页字符数
    const avgCharsPerPage = this._pages.length > 0
      ? Math.max(200, Math.floor(this._content.length / this._pages.length))
      : 2000;

    const pages: PageRange[] = [];
    let offset = 0;
    let pageIndex = 0;
    while (offset < content.length) {
      const end = Math.min(offset + avgCharsPerPage, content.length);
      pages.push({
        index: pageIndex,
        startOffset: offset,
        endOffset: end,
        chapterIndex,
      });
      offset = end;
      pageIndex++;
    }
    // 至少返回一页
    if (pages.length === 0) {
      pages.push({
        index: 0,
        startOffset: 0,
        endOffset: content.length,
        chapterIndex,
      });
    }
    return pages;
  }

  /**
   * 向前追加上一章（连续滚动模式）
   * 返回 true 表示成功追加，false 表示无法追加
   */
  async prependPrevChapter(): Promise<boolean> {
    if (!this._useChapterMode || !this._chapterCache || !this._bookMeta) {
      return false;
    }

    // 基于已加载章节的最小索引来判断上一章
    const minLoaded = this.getMinLoadedChapterIndex();
    const prevIndex = minLoaded - 1;
    if (prevIndex < 0) {
      return false;
    }

    if (this._loadedChapters.has(prevIndex)) {
      return false;
    }

    if (!this._container) return false;

    console.log(`[TxtRenderer] Prepending chapter ${prevIndex}`);

    // DOM 即将变化，递增版本号让 scroll handler 跳过过渡期的页码计算
    this._pagesVersion++;

    const chapter = await this._chapterCache.getChapter(prevIndex);
    const options = this._lastRenderOptions || {};

    // 使用轻量估算分页，避免阻塞
    const newPages = this._estimatePages(chapter.content, prevIndex, 0);

    // 记录插入前的滚动高度
    const prevScrollHeight = this._container.scrollHeight;

    const newContentLength = chapter.content.length;

    // 更新现有 pages 的偏移量（向后移动）
    for (const p of this._pages) {
      p.startOffset += newContentLength;
      p.endOffset += newContentLength;
      if (p.index !== undefined) {
        p.index += newPages.length;
      }
    }

    // 更新已有章节的内容偏移（全部后移）
    for (const [idx, off] of this._chapterContentOffsets) {
      this._chapterContentOffsets.set(idx, off + newContentLength);
    }
    this._chapterContentOffsets.set(prevIndex, 0);

    // 创建新页面并插入到头部
    const prependedPages = newPages.map(p => ({
      ...p,
      chapterIndex: prevIndex,
    }));
    this._pages.unshift(...prependedPages);

    // 更新内容
    this._content = chapter.content + this._content;
    this._loadedChapters.add(prevIndex);
    this._invalidateTitleMapCache();

    // 渲染追加的内容到 DOM 前面
    if (this._isVerticalMode) {
      const prependTitles = this._titleMap.getTitleMapForRange(0, newContentLength);

      // prepend 前收集旧段落引用：内容整体后移 newContentLength，渲染后统一平移标注
      const prevCharOffsetEls = this._container.querySelectorAll('[data-char-offset]');

      this._core.prependContentWithPageDividers(
        this._container,
        chapter.content,
        newPages,
        options,
        0,
        prependTitles,
        // 新章位于拼接 _content 起始（偏移 0）
        0
      );

      // 旧段落标注平移（保证 data-char-offset 始终相对拼接 _content）
      prevCharOffsetEls.forEach((el) => {
        const v = Number(el.getAttribute('data-char-offset')) || 0;
        el.setAttribute('data-char-offset', String(v + newContentLength));
      });

      // 按 DOM 顺序重新编号所有 page wrapper 的 data-page-index
      const orderedWrappers = this._container.querySelectorAll('[data-page-index]');
      orderedWrappers.forEach((el, i) => {
        el.setAttribute('data-page-index', String(i));
      });

      // 连续两帧确认布局稳定后再修正 scrollTop
      await new Promise<void>(resolve => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (this._container) {
              const newScrollHeight = this._container.scrollHeight;
              const scrollDelta = newScrollHeight - prevScrollHeight;
              this._container.scrollTop += scrollDelta;

              this._scrollHeight = newScrollHeight;
              this.refreshVerticalPageMap(this._container);
            }
            resolve();
          });
        });
      });

    }

    // 预加载相邻章节
    this._chapterCache.preloadAdjacentChapters(
      prevIndex,
      this._bookMeta.chapters.length
    ).catch(() => { });

    return true;
  }

  /** 获取已加载章节的最小索引 */
  getMinLoadedChapterIndex(): number {
    if (this._loadedChapters.size === 0) return this._currentChapterIndex;
    return Math.min(...this._loadedChapters);
  }

  /** 获取当前章节索引 */
  getCurrentChapterIndex(): number {
    return this._currentChapterIndex;
  }

  /** 获取章节总数 */
  getChapterCount(): number {
    return this._bookMeta?.chapters.length ?? 1;
  }

  async preloadAdjacentChapters(centerIndex?: number): Promise<void> {
    if (!this._useChapterMode || !this._chapterCache || !this._bookMeta) {
      return;
    }
    const total = this._bookMeta.chapters.length;
    const index = typeof centerIndex === 'number' ? centerIndex : this._currentChapterIndex;
    if (index < 0 || index >= total) {
      return;
    }
    await this._chapterCache.preloadAdjacentChapters(index, total);
  }

  /** 渲染指定页面（横向模式） */
  async renderPage(
    page: number,
    container: HTMLElement,
    options?: RenderOptions
  ): Promise<void> {
    if (!this._isReady) {
      throw new Error('Document not loaded');
    }

    this._container = container;
    const mergedOptions = this._mergeRenderOptions(options);
    this._lastRenderOptions = mergedOptions;
    this._isVerticalMode = false;

    // 模式切换检测：旧分页基于另一种模式的容器样式计算，必须失效重算
    if (this._pagesMode !== null && this._pagesMode !== 'horizontal') {
      this._pages = [];
      this._pagesVersion++;
    }
    this._pagesMode = 'horizontal';

    // 如果还没有分页，先进行分页计算
    if (this._pages.length === 0) {
      await this._calculatePages(container, mergedOptions);
    }

    // 确保页码有效
    const validPage = Math.min(Math.max(1, page), this._pages.length);
    this._currentPage = validPage;

    // 获取当前页内容
    const pageInfo = this._pages[validPage - 1];
    const pageContent = this._content.slice(pageInfo.startOffset, pageInfo.endOffset);

    // 渲染内容（横向模式传递页面偏移量以正确识别标题行）
    this._renderContent(container, pageContent, mergedOptions, false, pageInfo.startOffset);
  }

  /** 渲染全部内容（纵向模式） */
  async renderFullContent(container: HTMLElement, options?: RenderOptions): Promise<void> {
    if (!this._isReady) {
      throw new Error('Document not loaded');
    }

    this._container = container;
    const mergedOptions = this._mergeRenderOptions(options);
    this._lastRenderOptions = mergedOptions;
    this._isVerticalMode = true;

    // 模式切换检测：横向分页（章内页、padding 16px）不适用于纵向容器
    if (this._pagesMode !== null && this._pagesMode !== 'vertical') {
      this._pages = [];
      this._pagesVersion++;
    }
    this._pagesMode = 'vertical';

    if (this._pages.length === 0) {
      await this._calculatePages(container, mergedOptions);
    }

    // 渲染全部内容
    this._renderContent(container, this._content, mergedOptions, true);

    // 等待布局完成后记录滚动高度
    await new Promise<void>(resolve => {
      requestAnimationFrame(() => {
        this._scrollHeight = container.scrollHeight;
        this.refreshVerticalPageMap(container);
        resolve();
      });
    });
  }

  /** 计算虚拟页数（纵向模式） */
  calculateVirtualPages(viewportHeight: number): number {
    return this._progress.calculateVirtualPages(viewportHeight);
  }

  /** 获取当前虚拟页（纵向模式） */
  getCurrentVirtualPage(scrollTop: number, viewportHeight: number): number {
    return this._progress.getCurrentVirtualPage(scrollTop, viewportHeight);
  }

  /** 滚动到虚拟页（纵向模式，支持浮点数精确进度） */
  scrollToVirtualPage(page: number, viewportHeight: number): void {
    this._progress.scrollToVirtualPage(page, viewportHeight);
  }

  /** 计算虚拟分页 */
  private async _calculatePages(
    container: HTMLElement,
    options?: RenderOptions
  ): Promise<void> {
    // 先对容器应用样式，确保 calculatePages 读取到正确的 padding 和宽度
    this._core.applyStyles(container, options, this._isVerticalMode);

    const chapterTitles = this._titleMap.getFullTitleMap();
    const { pages, toc } = await this._core.calculatePages(
      this._content,
      this._toc,
      container,
      options,
      { updateTocPageNumbers: !this._useChapterMode },
      chapterTitles
    );

    // 如果是章节模式，需要为 pages 添加 chapterIndex
    if (this._useChapterMode) {
      const chapterIndex = this._currentChapterIndex;
      this._pages = pages.map(p => ({ ...p, chapterIndex }));
    } else {
      this._pages = pages;
    }

    this._toc = toc;
  }

  getChapterIndexByPage(pageIndex: number): number {
    if (pageIndex < 0 || pageIndex >= this._pages.length) {
      return this._currentChapterIndex;
    }
    return this._pages[pageIndex].chapterIndex ?? this._currentChapterIndex;
  }

  /** 渲染内容到容器 */
  private _renderContent(
    container: HTMLElement,
    content: string,
    options?: RenderOptions,
    isVertical: boolean = false,
    contentStartOffset: number = 0
  ): void {
    const chapterTitles = this._titleMap.getTitleMapForRender({
      isVertical,
      contentStartOffset,
      contentLength: content.length,
    });
    if (isVertical) {
      this._core.renderContentWithPageDividers(container, content, this._pages, options, chapterTitles);
    } else {
      this._core.renderContent(container, content, options, false, chapterTitles);
    }
  }

  /** 使标题映射缓存失效（内容变化时调用） */
  private _invalidateTitleMapCache(): void {
    this._titleMap.invalidate();
  }

  /** 搜索文本（TXT 不支持搜索） */
  async searchText(
    _query: string,
    _options?: { caseSensitive?: boolean }
  ): Promise<SearchResult[]> {
    return [];
  }

  /** 提取指定页的文本 */
  async extractText(page: number): Promise<string> {
    if (page < 1 || page > this._pages.length) {
      return '';
    }
    const pageInfo = this._pages[page - 1];
    return this._content.slice(pageInfo.startOffset, pageInfo.endOffset);
  }

  /** 获取全文内容（章节模式下返回当前章节内容） */
  getContent(): string {
    return this._content;
  }

  /** 获取编码 */
  getEncoding(): string {
    return this._encoding;
  }

  /** 获取滚动容器 */
  getScrollContainer(): HTMLElement | null {
    return this._container;
  }

  /** 确保分页数据已计算 */
  async ensurePagination(container: HTMLElement, options?: RenderOptions): Promise<void> {
    if (!this._isReady) {
      throw new Error('Document not loaded');
    }
    // 保存容器引用，确保后续 goToPage 可用
    this._container = container;
    const mergedOptions = this._mergeRenderOptions(options);
    this._lastRenderOptions = mergedOptions;

    if (this._pages.length === 0) {
      await this._calculatePages(container, mergedOptions);
      // 分页完成后，通知 UI 层更新目录（此时目录页码已从字符偏移量转换为真实页码）
      this.onTocUpdated?.(this._toc);
    }
  }

  /** 是否为纵向模式 */
  isVerticalMode(): boolean {
    return this._isVerticalMode;
  }

  /** 是否为章节加载模式 */
  isChapterMode(): boolean {
    return this._useChapterMode;
  }

  /** 获取缓存统计（章节模式） */
  getCacheStats(): { cachedCount: number; memoryMB: number } | null {
    if (!this._chapterCache) {
      return null;
    }
    return this._chapterCache.getCacheStats();
  }

  /**
   * 创建 TXT 新版 TTS 内容供给方
   */
  createTTSContentProvider(): TTSContentProvider {
    return new TxtContentProvider({
      getBookId: () => this._bookId || (this._filePath ? generateTxtBookId(this._filePath) : 'txt_unknown'),
      getFilePath: () => this._filePath,
      isVerticalMode: () => this._isVerticalMode,
      getContent: () => this._content,
      getPages: () => this._pages,
      getCurrentPage: () => this._currentPage,
      getCurrentChapterIndex: () => this._currentChapterIndex,
      getContainer: () => this._container,
      goToPage: (page) => this.goToPage(page),
      // 横向恢复朗读位置：切章并渲染章内页
      goToChapterPage: (chapterIndex, pageInChapter) =>
        this.goToChapterPage(chapterIndex, pageInChapter),
      getVisibleStartPosition: () => this.getVisibleStartPositionForTTS(),
    });
  }

  /**
   * 计算当前视口顶部对应的章节索引与 anchor
   * 横纵模式统一返回 { sectionIndex: 章节索引, anchor: 章内文本引用 }
   * anchor 用于 TTS 章内精确定位/裁前缀
   */
  private getVisibleStartPositionForTTS(): TTSReadingPosition | null {
    const container = this._container;
    if (!container) return null;

    if (!this._isVerticalMode) {
      // 横向：当前章内页 → 章节索引 + 当前页首行文本引用
      const pageIndex = Math.max(0, this._currentPage - 1);
      const chapterIndex = this.getChapterIndexByPage(pageIndex);
      const range = findFirstVisibleTextRange(container, container, 'horizontal');
      if (range) {
        const quote = rangeToTextQuote(range, {
          quoteLength: 24,
          contextLength: 24,
          searchRoot: container,
        });
        if (quote) {
          return {
            sectionIndex: chapterIndex,
            anchor: { quote: quote.quote, prefix: quote.prefix, suffix: quote.suffix },
          };
        }
      }
      return { sectionIndex: chapterIndex, anchor: null };
    }

    const wrappers = Array.from(
      container.querySelectorAll('[data-page-index]'),
    ) as HTMLElement[];
    if (wrappers.length === 0) return null;

    const scrollTop = container.scrollTop + 1;
    let visibleIndex = 0;
    for (let i = 0; i < wrappers.length; i++) {
      const top = wrappers[i]?.offsetTop ?? 0;
      if (top <= scrollTop) visibleIndex = i;
      else break;
    }

    const wrapper = wrappers[visibleIndex];
    if (!wrapper) return { sectionIndex: visibleIndex, anchor: null };

    const range = findFirstVisibleTextRange(wrapper, container, 'vertical');
    if (!range) return { sectionIndex: visibleIndex, anchor: null };

    const quote = rangeToTextQuote(range, {
      quoteLength: 24,
      contextLength: 24,
      searchRoot: wrapper,
    });
    if (!quote) return { sectionIndex: visibleIndex, anchor: null };

    return {
      sectionIndex: this.getChapterIndexByPage(visibleIndex),
      anchor: { quote: quote.quote, prefix: quote.prefix, suffix: quote.suffix },
    };
  }

  /** 关闭并释放资源 */
  async close(): Promise<void> {
    this._content = '';
    this._encoding = '';
    this._pages = [];
    this._toc = [];
    this._currentPage = 1;
    this._container = null;
    this._isReady = false;
    this._lastRenderOptions = null;
    this._isVerticalMode = false;
    this._scrollHeight = 0;
    this._pagesMode = null;
    this._currentPreciseProgress = 1;
    this._bookPreciseProgress = 1;
    this._pagesVersion = 0;
    this._useChapterMode = false;
    this._chapterCache = null;
    this._bookMeta = null;
    this._currentChapterIndex = 0;
    this._currentHideDivider = false;
    this._verticalPageTops = [];
    this._verticalPageHeights = [];
    this._chapterContentOffsets.clear();
    this._cachedTitleMap = null;
  }

  /** 页面变化回调 */
  onPageChange?: (page: number) => void;
}

// 注册 TXT 渲染器
registerRenderer({
  format: 'txt',
  extensions: ['.txt'],
  factory: () => new TxtRenderer(),
  displayName: 'TXT',
});


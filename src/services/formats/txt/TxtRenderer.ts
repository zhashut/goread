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
import {
  useTxtRendererCore,
  useTxtDocumentLoader,
  useTxtProgressController,
  type PageRange,
  type TxtRendererCore,
  type TxtChapterCacheHook,
  type TxtDocumentLoader,
  type TxtProgressController,
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
}

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
  private _isReady: boolean = false;
  private _lastRenderOptions: RenderOptions | null = null;
  private _isVerticalMode: boolean = false;
  private _scrollHeight: number = 0;
  private _core: TxtRendererCore;
  private _loader: TxtDocumentLoader;
  private _progress: TxtProgressController;
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
      goToChapter: (chapterIndex) => this.goToChapter(chapterIndex),
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
    // 确保有容器时才渲染
    if (this._container) {
      await this.renderPage(intPage, this._container, this._lastRenderOptions || {});
    }
    this.onPageChange?.(intPage);
  }

  /** 跳转到指定章节（章节模式） */
  async goToChapter(chapterIndex: number): Promise<void> {
    if (!this._useChapterMode || !this._chapterCache || !this._bookMeta) {
      return;
    }

    if (chapterIndex < 0 || chapterIndex >= this._bookMeta.chapters.length) {
      return;
    }

    if (chapterIndex === this._currentChapterIndex) {
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

    // 如果有容器，重新渲染
    if (this._container) {
      if (this._isVerticalMode) {
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

    // 渲染内容
    this._renderContent(container, pageContent, mergedOptions, false);
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
    const { pages, toc } = await this._core.calculatePages(
      this._content,
      this._toc,
      container,
      options,
      { updateTocPageNumbers: !this._useChapterMode }
    );
    this._pages = pages;
    this._toc = toc;
  }

  /** 渲染内容到容器 */
  private _renderContent(
    container: HTMLElement,
    content: string,
    options?: RenderOptions,
    isVertical: boolean = false
  ): void {
    if (isVertical) {
      this._core.renderContentWithPageDividers(container, content, this._pages, options);
    } else {
      this._core.renderContent(container, content, options, false);
    }
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
    this._currentPreciseProgress = 1;
    this._bookPreciseProgress = 1;
    this._useChapterMode = false;
    this._chapterCache = null;
    this._bookMeta = null;
    this._currentChapterIndex = 0;
    this._currentHideDivider = false;
    this._verticalPageTops = [];
    this._verticalPageHeights = [];
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

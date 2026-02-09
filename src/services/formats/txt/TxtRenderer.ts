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
  /** 直接指定初始章节索引（0-based），优先于 startProgress */
  startChapterIndex?: number;
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
  // 记录当前 content 中包含哪些章节
  private _loadedChapters = new Set<number>();

  // 分页版本号，每次异步精确分页替换后自增，用于 scroll handler 检测数据变化
  private _pagesVersion: number = 0;

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
      getChapterIndexByPage: (pageIndex) => this.getChapterIndexByPage(pageIndex),
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

    // 重置已加载章节集合
    this._loadedChapters.clear();
    this._loadedChapters.add(chapterIndex);
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

    this._content += chapter.content;

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

    if (this._isVerticalMode) {
      this._core.appendContentWithPageDividers(
        this._container,
        chapter.content,
        estimatedPages,
        options,
        startPageIndex
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
    _chapterIndex: number,
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

    // 创建新页面并插入到头部
    const prependedPages = newPages.map(p => ({
      ...p,
      chapterIndex: prevIndex,
    }));
    this._pages.unshift(...prependedPages);

    // 更新内容
    this._content = chapter.content + this._content;
    this._loadedChapters.add(prevIndex);

    // 渲染追加的内容到 DOM 前面
    if (this._isVerticalMode) {
      this._core.prependContentWithPageDividers(
        this._container,
        chapter.content,
        newPages,
        options,
        0
      );

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
    this._pagesVersion = 0;
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

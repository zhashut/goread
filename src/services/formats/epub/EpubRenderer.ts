/**
 * EPUB 渲染器
 * 使用后端 Rust 引擎和缓存渲染 EPUB 电子书
 */

import {
  IBookRenderer,
  BookFormat,
  BookInfo,
  TocItem,
  RenderOptions,
  SearchResult,
  PageContent,
  RendererCapabilities,
  ReaderTheme,
} from '../types';
import { registerRenderer } from '../registry';
import type { TTSContentProvider, TTSReadingPosition } from '../../tts/providers/TTSContentProvider';
import { EpubContentProvider } from '../../tts/providers/EpubContentProvider';
import { findFirstVisibleTextRange, rangeToTextQuote } from '../../../utils/ttsDOM';

// 导入 hooks
import {
  useEpubTheme,
  useEpubResource,
  useEpubNavigation,
  useVerticalRender,
  useHorizontalRender,
  type EpubThemeHook,
  type EpubResourceHook,
  type EpubNavigationHook,
  type VerticalRenderHook,
  type HorizontalRenderHook,
} from './hooks';
import { getSpineIndexForHref } from './hooks/tocMapping';

// 导入 Lifecycle Hook
import { useEpubLifecycle, EpubLifecycleHook } from './hooks/useEpubLifecycle';

import {
  type IEpubSectionCache,
  type IEpubResourceCache,
} from './cache';
import { epubCacheService } from './epubCacheService';

/**
 * EPUB 渲染器实现
 * 基于后端缓存的章节数据进行渲染
 */
export class EpubRenderer implements IBookRenderer {
  readonly format: BookFormat = 'epub';

  /** EPUB 支持 DOM 渲染和分页 */
  readonly capabilities: RendererCapabilities = {
    supportsBitmap: false,
    supportsDomRender: true,
    supportsPagination: true,
    supportsSearch: false,
  };

  private _currentContainer: HTMLElement | null = null;
  private _readingMode: 'horizontal' | 'vertical' = 'horizontal';
  private _expectedReadingMode: 'horizontal' | 'vertical' | null = null;
  private _currentTheme: ReaderTheme = 'light';
  private _currentPageGap: number = 4;
  private _currentHideDivider: boolean = false;

  // 缓存管理器
  private _sectionCache: IEpubSectionCache | null = null;
  private _resourceCache: IEpubResourceCache | null = null;

  // Blob URL 管理（供 hooks 使用）
  private _blobUrls: Set<string> = new Set();

  private _themeHook: EpubThemeHook;
  private _lifecycleHook: EpubLifecycleHook;
  private _resourceHook: EpubResourceHook | null = null;
  private _navigationHook: EpubNavigationHook | null = null;
  private _verticalRenderHook: VerticalRenderHook | null = null;
  private _horizontalRenderHook: HorizontalRenderHook | null = null;

  constructor() {
    // 初始化无依赖的 hooks
    this._themeHook = useEpubTheme();
    this._lifecycleHook = useEpubLifecycle();
    // 使用全局缓存服务（单例，跨 EpubRenderer 实例共享）
    this._sectionCache = epubCacheService.sectionCache;
    this._resourceCache = epubCacheService.resourceCache;
  }

  /** 当前章节索引（1-based currentPage 减 1） */
  private getCurrentSectionIndex(): number {
    return Math.max(0, this.getCurrentPage() - 1);
  }

  /** 总章节数 */
  private getSectionCount(): number {
    return this.getPageCount();
  }

  /** TTS 期间指定当前章节索引（不触发跳转） */
  private setCurrentSectionIndexForTTS(sectionIndex: number): void {
    const page = sectionIndex + 1;
    if (this._readingMode === 'vertical' && this._verticalRenderHook) {
      this._verticalRenderHook.state.currentPage = page;
      this._verticalRenderHook.state.currentPreciseProgress = page;
    }
    if (this._readingMode === 'horizontal' && this._horizontalRenderHook) {
      this._horizontalRenderHook.state.currentPage = page;
      this._horizontalRenderHook.state.currentPreciseProgress = page;
    }
    if (this.onPageChange) {
      this.onPageChange(page);
    }
  }

  /**
   * 初始化依赖 book 的 hooks
   */
  private _initHooks(): void {
    // 创建动态上下文对象，使 hooks 可以在运行时访问最新的 book
    const { state: lifeState, ensureBookLoaded } = this._lifecycleHook;

    // 资源 hook
    const resourceContext = {
      book: null, // book 属性在 resourceHook 内部通过 ensureBookLoaded 动态获取
      bookId: lifeState.bookId,
      blobUrls: this._blobUrls,
    };
    this._resourceHook = useEpubResource(resourceContext);

    // 纵向渲染 hook
    // 清理旧的纵向渲染 hook
    if (this._verticalRenderHook) {
      this._verticalRenderHook.cleanup();
      this._verticalRenderHook = null;
    }
    const verticalContext = {
      book: null,
      get sectionCount() { return lifeState.sectionCount; },
      currentTheme: this._currentTheme,
      currentPageGap: this._currentPageGap,
      get toc() { return lifeState.toc; },
      get spine() { return lifeState.spine; },
      onPageChange: (page: number) => {
        // 这里的 _currentPage 仅用于对外暴露 getter，实际状态在 hook 中
        // 但为了兼容旧接口 behavior，我们需要同步 hook 状态吗？
        // 实际上 getPageCount 等方法需要访问状态。
        // 我们统一优先访问 hook.state，如果 hook 未初始化，访问 lifecycle.state
        if (this.onPageChange) {
          this.onPageChange(page);
        }
      },
      onTocChange: (href: string) => {
        this._currentTocHref = href;
        if (this.onTocChange) {
          this.onTocChange(href);
        }
      },
      onScrollActivity: () => {
        if (this.onScrollActivity) {
          this.onScrollActivity();
        }
      },
      onFirstScreenReady: () => {
        if (this.onFirstScreenReady) {
          this.onFirstScreenReady();
        }
      },
      resourceHook: this._resourceHook!,
      themeHook: this._themeHook,
      // 缓存相关
      get bookId() { return lifeState.bookId || undefined; },
      sectionCache: this._sectionCache || undefined,
      resourceCache: this._resourceCache || undefined,
      // 懒加载回调（兼容旧接口，当前实现已不依赖前端解析）
      ensureBookLoaded: () => ensureBookLoaded(),
    };
    this._verticalRenderHook = useVerticalRender(verticalContext);

    // 清理旧的横向渲染 hook（防止 ResizeObserver 泄漏）
    if (this._horizontalRenderHook) {
      this._horizontalRenderHook.destroy();
      this._horizontalRenderHook = null;
    }

    const self = this;
    const horizontalContext = {
      get bookId() { return lifeState.bookId; },
      get sectionCount() { return lifeState.sectionCount; },
      get totalPages() { return lifeState.totalPages; },
      get currentTheme() { return self._currentTheme; },
      themeHook: this._themeHook,
      resourceHook: this._resourceHook!,
      get toc() { return lifeState.toc; },
      get spine() { return lifeState.spine; },
      sectionCache: this._sectionCache || undefined,
      resourceCache: this._resourceCache || undefined,
      onPageChange: (page: number) => {
        if (this.onPageChange) this.onPageChange(page);
      },
      onTocChange: (href: string) => {
        if (this.onTocChange) this.onTocChange(href);
      },
    };
    this._horizontalRenderHook = useHorizontalRender(horizontalContext);

    // 导航 hook
    const navigationContext = {
      getScrollContainer: () => this._verticalRenderHook?.state.scrollContainer ?? null,
      sectionContainers: this._verticalRenderHook!.state.sectionContainers,
      goToPage: (page: number) => this._verticalRenderHook!.goToPage(page),
      get toc() { return lifeState.toc; },
      get spine() { return lifeState.spine; },
      get sectionCount() { return lifeState.sectionCount; },
    };
    this._navigationHook = useEpubNavigation(navigationContext);

    // 将导航 hook 传递给纵向渲染 hook
    this._verticalRenderHook.setNavigationHook(this._navigationHook);
  }

  get isReady(): boolean {
    return this._lifecycleHook.state.isReady;
  }

  /**
   * 设置期望的阅读模式
   */
  setExpectedReadingMode(mode: 'horizontal' | 'vertical'): void {
    this._expectedReadingMode = mode;
  }

  /**
   * 加载 EPUB 文档
   * @param filePath 文件路径
   * @param options 加载选项（可选，用于大文件导入等场景）
   */
  async loadDocument(filePath: string, options?: { skipPreloaderCache?: boolean }): Promise<BookInfo> {
    const bookInfo = await this._lifecycleHook.loadDocument(filePath, {
      expectedReadingMode: this._expectedReadingMode,
      skipPreloaderCache: options?.skipPreloaderCache,
    });

    // 初始化 Hooks
    this._initHooks();

    return bookInfo;
  }

  /**
   * 获取目录
   */
  async getToc(): Promise<TocItem[]> {
    return this._lifecycleHook.state.toc;
  }

  /**
   * 获取总页数（章节数）
   */
  getPageCount(): number {
    return this._lifecycleHook.state.totalPages;
  }

  /**
   * 获取当前页码（章节索引）
   */
  getCurrentPage(): number {
    if (this._readingMode === 'vertical' && this._verticalRenderHook) {
      return this._verticalRenderHook.state.currentPage;
    }
    if (this._readingMode === 'horizontal' && this._horizontalRenderHook) {
      return this._horizontalRenderHook.state.currentPage;
    }
    return 1;
  }

  /**
   * 获取当前精确阅读进度
   */
  getPreciseProgress(): number {
    if (this._readingMode === 'vertical' && this._verticalRenderHook) {
      return this._verticalRenderHook.state.currentPreciseProgress;
    }
    if (this._readingMode === 'horizontal' && this._horizontalRenderHook) {
      return this._horizontalRenderHook.state.currentPreciseProgress;
    }
    return 1;
  }

  getInstantPreciseProgress(): number {
    if (this._readingMode === 'vertical' && this._verticalRenderHook) {
      return this._verticalRenderHook.getInstantPreciseProgress();
    }
    if (this._readingMode === 'horizontal' && this._horizontalRenderHook) {
      return this._horizontalRenderHook.getInstantPreciseProgress();
    }
    return this.getPreciseProgress();
  }

  /**
   * 渲染 EPUB 到容器
   */
  async renderPage(
    page: number,
    container: HTMLElement,
    options?: RenderOptions
  ): Promise<void> {
    const readingMode = options?.readingMode || 'horizontal';
    const theme = options?.theme || this._currentTheme || 'light';
    const hideDividerFromOptions =
      typeof options?.hideDivider === 'boolean' ? options.hideDivider : undefined;

    const prevContainer = this._currentContainer;
    const prevReadingMode = this._readingMode;

    // 检测阅读模式是否变化
    const isModeChange = readingMode && readingMode !== prevReadingMode;

    this._currentTheme = theme as ReaderTheme;
    if (hideDividerFromOptions !== undefined) {
      this._currentHideDivider = hideDividerFromOptions;
    }
    this._currentContainer = container;
    this._readingMode = readingMode;

    if (readingMode === 'vertical') {
      if (!this._verticalRenderHook) {
        if (!this.isReady) throw new Error('Document not loaded');
        this._initHooks();
      }

      const isSameContainer = prevContainer === container;

      // 已渲染且模式未变化时仅更新样式，跳过完整重渲染
      if (
        isSameContainer &&
        this._verticalRenderHook?.state.verticalContinuousMode &&
        !isModeChange
      ) {
        if (options?.pageGap !== undefined) {
          this.updatePageGap(options.pageGap);
        }
        await this._verticalRenderHook.applyLayoutAndRestoreAnchor({
          ...options,
          theme,
          hideDivider: this._currentHideDivider,
        });
        return;
      }

      return this._verticalRenderHook!.renderVerticalContinuous(container, {
        ...options,
        theme,
        hideDivider: this._currentHideDivider,
      });
    }

    // 横向模式
    if (!this._horizontalRenderHook) {
      if (!this.isReady && !this._lifecycleHook.state.book) {
        if (!this.isReady) throw new Error('文档未加载');
        this._initHooks();
      }
    }

    const applied = await this._horizontalRenderHook!.applyThemeUpdateAndRestoreAnchor({
      ...options,
      theme,
    });
    if (applied) return;

    return this._horizontalRenderHook!.renderHorizontal(page, container, {
      ...options,
      theme,
    });
  }

  /**
   * 动态更新分隔线可见性 (纵向模式)
   */
  updateDividerVisibility(hidden: boolean): void {
    this._currentHideDivider = hidden;
    if (this._verticalRenderHook) {
      this._verticalRenderHook.updateDividerVisibility(hidden);
    }
  }

  /**
   * 跳转到指定页面（章节）
   */
  async goToPage(page: number): Promise<void> {
    if (this._readingMode === 'vertical' && this._verticalRenderHook?.state.verticalContinuousMode) {
      await this._verticalRenderHook.goToPage(page);
      return;
    }

    if (this._readingMode === 'horizontal' && this._horizontalRenderHook) {
      await this._horizontalRenderHook.goToPage(page);
      return;
    }
  }

  /**
   * 跳转到目录项（href）
   */
  async goToHref(href: string): Promise<void> {
    if (this._readingMode === 'vertical' && this._verticalRenderHook?.state.verticalContinuousMode) {
      const lifeState = this._lifecycleHook.state;
      const sectionCount = lifeState.sectionCount || 0;
      const sectionIndex = getSpineIndexForHref(href, lifeState.spine);

      if (sectionIndex >= 0 && sectionIndex < sectionCount) {
        await this.goToPage(sectionIndex + 1);
        return;
      }
    }

    // Horizontal
    if (this._horizontalRenderHook) {
      await this._horizontalRenderHook.goToHref(href);
    }
  }

  /**
   * 下一页
   */
  async nextPage(): Promise<void> {
    if (this._readingMode === 'vertical' && this._verticalRenderHook?.state.verticalContinuousMode) {
      const nextPage = Math.min(this.getCurrentPage() + 1, this.getPageCount());
      await this.goToPage(nextPage);
      return;
    }

    if (this._horizontalRenderHook) {
      await this._horizontalRenderHook.nextPage();
    }
  }

  /**
   * 上一页
   */
  async prevPage(): Promise<void> {
    if (this._readingMode === 'vertical' && this._verticalRenderHook?.state.verticalContinuousMode) {
      const prevPage = Math.max(this.getCurrentPage() - 1, 1);
      await this.goToPage(prevPage);
      return;
    }

    if (this._horizontalRenderHook) {
      await this._horizontalRenderHook.prevPage();
    }
  }

  /**
   * 搜索文本
   */
  async searchText(_query: string, _options?: { caseSensitive?: boolean }): Promise<SearchResult[]> {
    return [];
  }

  /**
   * 获取页面内容
   */
  async extractText(page: number): Promise<string> {
    const content = await this.getPageContent(page);
    if (content.type === 'text') {
      return content.content || '';
    }
    return '';
  }

  /**
   * 获取页面内容
   */
  async getPageContent(_page: number, _options?: RenderOptions): Promise<PageContent> {
    return {
      type: 'text',
      content: '',
    };
  }

  /**
   * 滚动到锚点（目录项 href）
   */
  scrollToAnchor(anchor: string): void {
    this.goToHref(anchor).catch(() => { });
  }

  /**
   * 获取滚动容器
   */
  getScrollContainer(): HTMLElement | null {
    if (this._readingMode === 'vertical') {
      return this._currentContainer;
    }
    return this._currentContainer;
  }

  /**
   * 计算虚拟页数
   */
  calculateVirtualPages(_viewportHeight: number): number {
    return this.getPageCount();
  }

  /**
   * 获取当前虚拟页码
   */
  getCurrentVirtualPage(_scrollTop: number, _viewportHeight: number): number {
    return this.getCurrentPage();
  }

  /**
   * 滚动到指定虚拟页
   */
  scrollToVirtualPage(page: number, _viewportHeight: number): void {
    this.goToPage(page).catch(() => { });
  }

  /**
   * 关闭并释放资源
   */
  async close(): Promise<void> {
    // Hooks cleanup
    this._horizontalRenderHook?.destroy();
    this._verticalRenderHook?.cleanup();
    this._lifecycleHook.reset();

    // 清理 Blob URL
    this._blobUrls.forEach(url => URL.revokeObjectURL(url));
    this._blobUrls.clear();

    // Reset references
    this._currentContainer = null;
    this._resourceHook = null;
    this._navigationHook = null;
    this._verticalRenderHook = null;
    this._horizontalRenderHook = null;

    this._currentPageGap = 4;
  }

  /** Callbacks */
  onPageChange?: (page: number) => void;
  onTocChange?: (href: string) => void;
  onScrollActivity?: () => void;
  onFirstScreenReady?: () => void; // EPUB vertical specific

  getCurrentTocHref(): string | null {
    return this._currentTocHref;
  }
  private _currentTocHref: string | null = null;

  updatePageGap(pageGap: number): void {
    if (this._readingMode !== 'vertical' || !this._verticalRenderHook) return;
    if (pageGap === this._currentPageGap) return;
    this._currentPageGap = pageGap;
    this._verticalRenderHook.updatePageGap(pageGap);
  }

  /**
   * 设置阅读模式
   * 模式切换时完全重建渲染状态，确保样式正确
   */
  async setReadingMode(mode: 'horizontal' | 'vertical'): Promise<void> {
    if (this._readingMode === mode) {
      return;
    }

    const preciseProgress = this.getPreciseProgress();
    const currentPage = this.getCurrentPage();
    const savedProgress = preciseProgress > 0 ? preciseProgress : currentPage;
    const savedPage = Math.max(1, Math.floor(savedProgress) || currentPage || 1);

    // 切换模式前，完全重置容器
    if (this._currentContainer) {
      // 清空内容
      this._currentContainer.innerHTML = '';
      // 重置滚动位置
      this._currentContainer.scrollTop = 0;
      // 完全清除行内样式，让新渲染器从零开始设置
      this._currentContainer.removeAttribute('style');
    }

    // 使用 _readingMode 判断当前模式
    const isCurrentlyVertical = this._readingMode === 'vertical';

    // 纵向模式转横向模式
    if (isCurrentlyVertical && mode === 'horizontal') {
      this._readingMode = mode;

      // 完全清理纵向渲染 hook
      this._verticalRenderHook?.cleanup();
      this._verticalRenderHook = null;

      if (this._currentContainer) {
        this._currentContainer.innerHTML = '';
      }

      // 重新初始化 hooks
      this._initHooks();

      if (this._currentContainer) {
        await this.renderPage(savedPage, this._currentContainer, {
          initialVirtualPage: savedProgress,
          readingMode: mode,
          theme: this._currentTheme,
          pageGap: this._currentPageGap,
        });
      }
      return;
    }

    // 横向模式转纵向模式
    if (!isCurrentlyVertical && mode === 'vertical') {
      this._readingMode = mode;

      // 确保书籍加载完成
      if (!this.isReady) {
        await this._lifecycleHook.ensureBookLoaded();
      }

      // 完全清理横向渲染 hook
      if (this._horizontalRenderHook) {
        this._horizontalRenderHook.destroy();
        this._horizontalRenderHook = null;
      }

      // 清空容器并重新初始化 hooks
      if (this._currentContainer) {
        this._currentContainer.innerHTML = '';
      }
      this._initHooks();

      if (this._currentContainer) {
        await this.renderPage(savedPage, this._currentContainer, {
          initialVirtualPage: savedProgress,
          readingMode: mode,
          theme: this._currentTheme,
          pageGap: this._currentPageGap,
        });
      }
      return;
    }

    // 相同模式切换或更新设置
    this._readingMode = mode;

    // 重新渲染
    if (this._currentContainer) {
      await this.renderPage(savedPage, this._currentContainer, {
        initialVirtualPage: savedProgress,
        readingMode: mode,
        theme: this._currentTheme,
        pageGap: this._currentPageGap,
      });
    }
  }

  scrollBy(deltaY: number): void {
    if (this._readingMode === 'vertical' && this._currentContainer) {
      this._currentContainer.scrollBy({ top: deltaY, behavior: 'smooth' });
      return;
    }
    this._horizontalRenderHook?.scrollBy(deltaY);
  }

  /**
   * 创建新版 TTS 内容供给方
   * 内容拉取统一走 Rust 端 tts_get_segments；
   * 前端只承担 anchor 高亮、视口起点探测与停止后位置回写
   */
  createTTSContentProvider(): TTSContentProvider {
    return new EpubContentProvider({
      getReadingMode: () => this._readingMode,
      getContainer: () => this._currentContainer,
      getBookId: () => this._lifecycleHook.state.bookId,
      getFilePath: () => this._lifecycleHook.state.filePath,
      getTotalSections: () => this.getSectionCount(),
      getCurrentSectionIndex: () => this.getCurrentSectionIndex(),
      getCurrentSectionRoot: () => this.getCurrentTTSSectionRoot(),
      getSectionRootByIndex: (idx) => this.getTTSSectionRootByIndex(idx),
      getVisibleStartPosition: () => this.getVisibleStartPositionForTTS(),
      goToProgress: (progress) => this.goToPage(progress),
      setSectionIndex: (idx) => this.setCurrentSectionIndexForTTS(idx),
    });
  }

  /**
   * 计算"当前视口顶部"对应的章节索引和文本 anchor
   * 横向模式：在当前章节根 DOM 内按当前内页可视区域寻找首个可见文本
   * 纵向模式：在当前章节根 DOM 内按 TreeWalker 找首个底部越过 viewport top 的文本
   * 返回 null 时 Provider 会回退到章节起点
   */
  private getVisibleStartPositionForTTS(): TTSReadingPosition | null {
    const sectionIndex = this.getCurrentSectionIndex();
    const root = this.getCurrentTTSSectionRoot();
    if (!root) return { sectionIndex, anchor: null };

    const scrollContainer = this.getScrollContainerForTTS();
    if (!scrollContainer) return { sectionIndex, anchor: null };

    const axis: 'horizontal' | 'vertical' =
      this._readingMode === 'horizontal' ? 'horizontal' : 'vertical';
    const range = findFirstVisibleTextRange(root, scrollContainer, axis);
    if (!range) return { sectionIndex, anchor: null };

    const quote = rangeToTextQuote(range, {
      quoteLength: 24,
      contextLength: 24,
      searchRoot: root,
    });
    if (!quote) return { sectionIndex, anchor: null };

    return {
      sectionIndex,
      anchor: { quote: quote.quote, prefix: quote.prefix, suffix: quote.suffix },
    };
  }

  /** EPUB 横纵向各自的滚动容器：横向是 host 容器自身，纵向是包裹整本的 _currentContainer */
  private getScrollContainerForTTS(): Element | null {
    return this._currentContainer ?? null;
  }

  private getCurrentTTSSectionRoot(): Element | null {
    if (this._readingMode === 'horizontal') {
      const shadow = this._currentContainer?.shadowRoot;
      const content = shadow?.querySelector('.epub-section-content');
      return (content as Element | null) ?? null;
    }
    if (this._readingMode === 'vertical' && this._verticalRenderHook) {
      const idx = this.getCurrentSectionIndex();
      return this.getTTSSectionRootByIndex(idx);
    }
    return null;
  }

  private getTTSSectionRootByIndex(sectionIndex: number): Element | null {
    if (this._readingMode === 'vertical' && this._verticalRenderHook) {
      const wrapper = this._verticalRenderHook.state.sectionContainers.get(sectionIndex);
      const shadow = wrapper?.shadowRoot;
      const content = shadow?.querySelector('.epub-section-content');
      return (content as Element | null) ?? null;
    }
    return this.getCurrentTTSSectionRoot();
  }
}

// 注册 EPUB 渲染器
registerRenderer({
  format: 'epub',
  extensions: ['.epub'],
  factory: () => new EpubRenderer(),
  displayName: 'EPUB',
});


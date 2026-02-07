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

    // 在更新状态前检测主题是否变化
    const isThemeChange = options?.theme && options.theme !== this._currentTheme;
    // 检测阅读模式是否变化
    const isModeChange = readingMode && readingMode !== this._readingMode;

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

      // 已渲染且主题/模式未变化时仅更新样式，跳过完整重渲染
      if (
        this._currentContainer === container &&
        this._verticalRenderHook?.state.verticalContinuousMode &&
        !isThemeChange &&
        !isModeChange
      ) {
        if (options?.pageGap !== undefined) {
          this.updatePageGap(options.pageGap);
        }
        if (hideDividerFromOptions !== undefined) {
          this._verticalRenderHook?.updateDividerVisibility(this._currentHideDivider);
        }
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
      const book: any = lifeState.book as any;
      const sectionCount = lifeState.sectionCount || 0;

      const normalizeHref = (h: string) => h?.split('#')[0] || '';
      const hrefBase = normalizeHref(href);

      let sectionIndex = -1;

      if (book && Array.isArray(book.sections)) {
        sectionIndex = book.sections.findIndex((section: any) => {
          const sectionId = normalizeHref(section.id || '');
          return (
            section.id === href ||
            (hrefBase && sectionId === hrefBase) ||
            section.id.endsWith(href) ||
            (hrefBase && sectionId.endsWith(hrefBase))
          );
        });
      }

      if (sectionIndex < 0 && Array.isArray(lifeState.toc) && lifeState.toc.length > 0 && sectionCount > 0) {
        const flat: TocItem[] = [];
        const walk = (items: TocItem[]) => {
          for (const item of items) {
            flat.push(item);
            if (item.children && item.children.length > 0) {
              walk(item.children);
            }
          }
        };

        walk(lifeState.toc);

        const normalizedHref = hrefBase || href;

        sectionIndex = flat.findIndex((item) => {
          const loc = item.location;
          if (typeof loc !== 'string' || !loc) return false;
          const locBase = normalizeHref(loc);
          return (
            loc === href ||
            (normalizedHref && locBase === normalizedHref) ||
            loc.endsWith(href) ||
            (normalizedHref && locBase.endsWith(normalizedHref))
          );
        });

        if (sectionIndex >= 0 && sectionCount > 0) {
          if (sectionIndex >= sectionCount) {
            sectionIndex = sectionCount - 1;
          }
        }
      }

      if (sectionIndex >= 0) {
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
   * 预热指定章节范围到缓存
   */
  async preloadSections(start: number, end: number): Promise<void> {
    if (!this.isReady) throw new Error('文档未加载');
    if (!this._verticalRenderHook) throw new Error('渲染 Hook 未初始化');

    const validStart = Math.max(0, start);
    const validEnd = Math.min(this.getPageCount() - 1, end); // Use API

    if (validEnd < validStart) return;

    const indices: number[] = [];
    for (let i = validStart; i <= validEnd; i++) {
      indices.push(i);
    }

    await this._verticalRenderHook.preloadSectionsOffscreen(indices);
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
}

// 注册 EPUB 渲染器
registerRenderer({
  format: 'epub',
  extensions: ['.epub'],
  factory: () => new EpubRenderer(),
  displayName: 'EPUB',
});

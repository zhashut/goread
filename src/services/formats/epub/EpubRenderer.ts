/**
 * EPUB 渲染器
 * 使用 foliate-js 渲染 EPUB 电子书
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
import { logError } from '../../index';

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
 * 使用 foliate-js 的 View Web Component 进行渲染
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

    // 资源 hook - 使用动态 book 访问
    const resourceContext = {
      get book() { return lifeState.book; },
      blobUrls: this._blobUrls, 
    };
    // Wait, if I create a new Set here every time _initHooks is declared? 
    // _initHooks is called once per loadDocument. That's fine.
    
    this._resourceHook = useEpubResource(resourceContext);

    // 纵向渲染 hook
    // 清理旧的纵向渲染 hook
    if (this._verticalRenderHook) {
        this._verticalRenderHook.cleanup();
        this._verticalRenderHook = null;
    }
    const verticalContext = {
      get book() { return lifeState.book; },
      get sectionCount() { return lifeState.sectionCount; },
      currentTheme: this._currentTheme,
      currentPageGap: this._currentPageGap,
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
      // 懒加载回调
      ensureBookLoaded: () => ensureBookLoaded(),
    };
    this._verticalRenderHook = useVerticalRender(verticalContext);

    // 清理旧的横向渲染 hook（防止 ResizeObserver 泄漏）
    if (this._horizontalRenderHook) {
      this._horizontalRenderHook.destroy();
      this._horizontalRenderHook = null;
    }

    // 横向渲染 hook
    const horizontalContext = {
      get book() { return lifeState.book; },
      get bookId() { return lifeState.bookId; },
      get sectionCount() { return lifeState.sectionCount; },
      get totalPages() { return lifeState.totalPages; },
      currentTheme: this._currentTheme,
      themeHook: this._themeHook,
      resourceHook: this._resourceHook!,
      onPageChange: (page: number) => {
         if (this.onPageChange) this.onPageChange(page);
      },
      onTocChange: (href: string) => {
        if (this.onTocChange) this.onTocChange(href);
      },
      ensureBookLoaded: () => ensureBookLoaded(),
      get bookLoadPromise() { return null; }, // Lifecycle Hook 内部管理 Promise，暂不直接暴露
      get isReady() { return lifeState.isReady; },
    };
    this._horizontalRenderHook = useHorizontalRender(horizontalContext);

    // 导航 hook - 使用动态 book 访问
    const navigationContext = {
      get book() { return lifeState.book; },
      getScrollContainer: () => this._verticalRenderHook?.state.scrollContainer ?? null,
      sectionContainers: this._verticalRenderHook!.state.sectionContainers,
      goToPage: (page: number) => this._verticalRenderHook!.goToPage(page),
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
   */
  async loadDocument(filePath: string): Promise<BookInfo> {
    const bookInfo = await this._lifecycleHook.loadDocument(filePath, this._expectedReadingMode);
    
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
    
    // 更新主题和容器记录
    const theme = options?.theme || this._currentTheme || 'light';
    this._currentTheme = theme as ReaderTheme;
    this._currentContainer = container;
    this._readingMode = readingMode;

    if (readingMode === 'vertical') {
      if (!this._verticalRenderHook) {
         // Should not happen if loaded
         if (!this.isReady) throw new Error('Document not loaded');
         this._initHooks(); // Defensive
      }
      return this._verticalRenderHook!.renderVerticalContinuous(container, {
        ...options,
        theme,
      });
    }
    
    // 横向模式
    if (!this._horizontalRenderHook) {
        if (!this.isReady && !this._lifecycleHook.state.book) {
             // 确保 hooks 已初始化，防止未就绪时调用报错
             if (!this.isReady) throw new Error('文档未加载');
             this._initHooks();
        }
    }
    
    return this._horizontalRenderHook!.renderHorizontal(page, container, {
        ...options,
        theme,
    });
  }

  async renderVerticalContinuous(container: HTMLElement, options?: RenderOptions): Promise<void> {
     if (!this._verticalRenderHook) throw new Error('Vertical render hook not initialized');
     
     const theme = options?.theme || this._currentTheme || 'light';
     this._currentTheme = theme as ReaderTheme;
     this._currentPageGap = options?.pageGap ?? this._currentPageGap;

     await this._verticalRenderHook.renderVerticalContinuous(container, {
       ...options,
       theme,
       pageGap: this._currentPageGap
     });
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
    // 纵向连续模式下，根据 href 找到对应章节并跳转
    if (this._readingMode === 'vertical' && this._verticalRenderHook?.state.verticalContinuousMode) {
       // Logic moved here or stay? Vertical hook doesn't have goToHref? 
       // Check `useVerticalRender.ts`. It has `goToPage`.
       // Logic to find page by href was in EpubRenderer. I should preserve it or move to hook?
       // Ideally move to hook. But `useVerticalRender` doesn't have it currently.
       // I can keep it here using lifecycle book.
       const book = this._lifecycleHook.state.book as any; // Cast for sections access
       if (!book) return;

       const normalizeHref = (h: string) => h?.split('#')[0] || '';
       const hrefBase = normalizeHref(href);
      
       const findSectionIndex = (): number => {
        return book.sections.findIndex((section: any) => {
          const sectionId = normalizeHref(section.id || '');
          return section.id === href || 
                 (hrefBase && sectionId === hrefBase) ||
                 section.id.endsWith(href) ||
                 (hrefBase && sectionId.endsWith(hrefBase));
        });
       };
       const sectionIndex = findSectionIndex();
       if (sectionIndex >= 0) {
        await this.goToPage(sectionIndex + 1);
       } else {
        logError(`[EpubRenderer] 未找到匹配的章节: ${href}`).catch(() => {});
       }
       return;
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
   * 提取指定章节的文本
   */
  async extractText(page: number): Promise<string> {
    const book = this._lifecycleHook.state.book;
    if (!book) return '';

    const sectionIndex = page - 1;
    if (sectionIndex < 0 || sectionIndex >= this._lifecycleHook.state.sectionCount) return '';

    try {
      const section = book.sections[sectionIndex];
      if (section?.createDocument) {
        const doc = await section.createDocument();
        return doc.body?.textContent || '';
      }
    } catch (e) {
      logError('[EpubRenderer] 提取文本失败', { error: String(e), page }).catch(() => {});
    }

    return '';
  }

  /**
   * 获取页面内容
   */
  async getPageContent(page: number, _options?: RenderOptions): Promise<PageContent> {
    const text = await this.extractText(page);
    return {
      type: 'text',
      content: text,
    };
  }

  /**
   * 滚动到锚点（目录项 href）
   */
  scrollToAnchor(anchor: string): void {
      this.goToHref(anchor).catch((e) => {
         logError('[EpubRenderer] 滚动到锚点失败', { error: String(e), anchor }).catch(() => {});
      });
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
    this.goToPage(page).catch(() => {});
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

    await logError(`[EpubRenderer] 开始预热章节 ${validStart + 1}-${validEnd + 1}`);
    await this._verticalRenderHook.preloadSectionsOffscreen(indices);
    await logError(`[EpubRenderer] 预热完成`);
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
   */
  async setReadingMode(mode: 'horizontal' | 'vertical'): Promise<void> {
    if (this._readingMode === mode) return;
    
    const preciseProgress = this.getPreciseProgress();
    const currentPage = this.getCurrentPage();
    const savedProgress = preciseProgress > 0 ? preciseProgress : currentPage;
    const savedPage = Math.max(1, Math.floor(savedProgress) || currentPage || 1);
    
    const isCurrentlyVertical = this._verticalRenderHook?.state.verticalContinuousMode;
    
    // 纵向模式转横向模式
    if (isCurrentlyVertical && mode === 'horizontal') {
      this._readingMode = mode;
      
      this._verticalRenderHook?.cleanup();

      if (this._currentContainer) {
        this._currentContainer.innerHTML = '';
      }
      
      // 切换模式时清理并重载资源
      if (this._lifecycleHook.state.filePath && this._lifecycleHook.state.bookId) {
         // 强制重载
         await this._lifecycleHook.reloadBook();
         this._initHooks(); // 重新绑定
      } else {
         await this._lifecycleHook.ensureBookLoaded();
      }
      
      if (this._currentContainer) {
        await this.renderPage(savedPage, this._currentContainer, {
          initialVirtualPage: savedPage,
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
      
      // 确保书籍加载完成（防止从横向加载中快速切换回纵向导致的未就绪错误）
      if (!this.isReady) {
         await this._lifecycleHook.ensureBookLoaded();
      }
      
      // 清理横向渲染 hook
      if (this._horizontalRenderHook) {
        this._horizontalRenderHook.destroy();
        this._horizontalRenderHook = null;
      }

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

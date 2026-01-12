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
  useEpubLoader,
  useEpubTheme,
  useEpubResource,
  useEpubNavigation,
  useVerticalRender,
  type EpubBook,
  type EpubLoaderHook,
  type EpubThemeHook,
  type EpubResourceHook,
  type EpubNavigationHook,
  type VerticalRenderHook,
  type FoliateView,
} from './hooks';

// 导入缓存模块
import {
  generateQuickBookId,
  getMimeType,
  type IEpubSectionCache,
  type IEpubResourceCache,
} from './cache';
import { epubCacheService } from './epubCacheService';
import { epubPreloader } from './epubPreloader';

/** 获取 Tauri invoke 函数 */
async function getInvoke() {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke;
}

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
    supportsSearch: true,
  };

  private _isReady = false;
  private _book: EpubBook | null = null;
  private _bookLoadPromise: Promise<void> | null = null;
  private _view: FoliateView | null = null;
  private _toc: TocItem[] = [];
  private _currentContainer: HTMLElement | null = null;
  private _currentPage = 1;
  private _totalPages = 1;
  private _sectionCount = 0;
  private _currentTocHref: string | null = null;
  private _readingMode: 'horizontal' | 'vertical' = 'horizontal';
  private _currentTheme: ReaderTheme = 'light';
  private _resizeObserver: ResizeObserver | null = null;
  private _lastRenderContainer: HTMLElement | null = null;
  private _currentPageGap: number = 4;
  private _currentPreciseProgress: number = 1;

  // Blob URL 管理（供 hooks 使用）
  private _blobUrls: Set<string> = new Set();

  // 缓存管理器
  private _bookId: string | null = null;
  private _sectionCache: IEpubSectionCache | null = null;
  private _resourceCache: IEpubResourceCache | null = null;

  // Hooks 实例
  private _loaderHook: EpubLoaderHook;
  private _themeHook: EpubThemeHook;
  private _resourceHook: EpubResourceHook | null = null;
  private _navigationHook: EpubNavigationHook | null = null;
  private _verticalRenderHook: VerticalRenderHook | null = null;

  constructor() {
    // 初始化无依赖的 hooks
    this._loaderHook = useEpubLoader();
    this._themeHook = useEpubTheme();

    // 使用全局缓存服务（单例，跨 EpubRenderer 实例共享）
    this._sectionCache = epubCacheService.sectionCache;
    this._resourceCache = epubCacheService.resourceCache;
  }

  /**
   * 初始化依赖 book 的 hooks
   */
  private _initHooks(): void {
    // 创建动态上下文对象，使 hooks 可以在运行时访问最新的 book
    const self = this;

    // 资源 hook - 使用动态 book 访问
    const resourceContext = {
      get book() { return self._book; },
      blobUrls: this._blobUrls,
    };
    this._resourceHook = useEpubResource(resourceContext);

    // 纵向渲染 hook - 使用动态 book 访问
    const verticalContext = {
      get book() { return self._book; },
      sectionCount: this._sectionCount,
      currentTheme: this._currentTheme,
      currentPageGap: this._currentPageGap,
      onPageChange: (page: number) => {
        this._currentPage = Math.floor(page);
        this._currentPreciseProgress = page;
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
      bookId: this._bookId || undefined,
      sectionCache: this._sectionCache || undefined,
      resourceCache: this._resourceCache || undefined,
      // 懒加载回调
      ensureBookLoaded: () => this._ensureBookLoaded(),
    };
    this._verticalRenderHook = useVerticalRender(verticalContext);

    // 导航 hook - 使用动态 book 访问
    const navigationContext = {
      get book() { return self._book; },
      getScrollContainer: () => this._verticalRenderHook?.state.scrollContainer ?? null,
      sectionContainers: this._verticalRenderHook!.state.sectionContainers,
      goToPage: (page: number) => this._verticalRenderHook!.goToPage(page),
    };
    this._navigationHook = useEpubNavigation(navigationContext);

    // 将导航 hook 传递给纵向渲染 hook
    this._verticalRenderHook.setNavigationHook(this._navigationHook);
  }

  get isReady(): boolean {
    return this._isReady;
  }

  /**
   * 加载 EPUB 文档
   */
  /**
   * 加载 EPUB 文档
   */
  async loadDocument(filePath: string): Promise<BookInfo> {
    // 1. 生成 Quick ID
    this._bookId = generateQuickBookId(filePath);

    // 2. 检查预加载缓存（用户点击书籍时已提前触发加载）
    const preloadedBook = await epubPreloader.get(filePath);
    if (preloadedBook) {
      logError(`[EpubRenderer] 命中预加载缓存，直接使用: ${this._bookId}`).catch(() => {});
      
      this._book = preloadedBook;
      this._sectionCount = preloadedBook.sections?.length || 1;
      this._toc = this._loaderHook.convertToc(preloadedBook.toc || []);
      this._totalPages = this._sectionCount;
      this._isReady = true;
      
      // 初始化 Hooks
      this._initHooks();
      
      // 异步保存/更新元数据缓存
      const bookInfoForCache: BookInfo = {
        title: preloadedBook.metadata?.title,
        author: Array.isArray(preloadedBook.metadata?.author) 
          ? preloadedBook.metadata?.author.join(', ') 
          : preloadedBook.metadata?.author,
        publisher: preloadedBook.metadata?.publisher,
        language: preloadedBook.metadata?.language,
        description: preloadedBook.metadata?.description,
        pageCount: this._totalPages,
        format: 'epub',
      };
      
      epubCacheService.saveMetadata(this._bookId, {
        bookInfo: bookInfoForCache,
        toc: this._toc,
        sectionCount: this._sectionCount,
      }).catch(() => {});
      
      return {
        ...bookInfoForCache,
        coverImage: await this._loaderHook.getCoverImage(preloadedBook),
      };
    }

    // 3. 尝试获取元数据缓存
    const metadata = await epubCacheService.getMetadata(this._bookId);

    if (metadata) {
      logError(`[EpubRenderer] 命中元数据缓存，启用懒加载: ${this._bookId}`).catch(() => {});
      
      // 恢复状态
      this._toc = metadata.toc;
      this._sectionCount = metadata.sectionCount;
      this._totalPages = this._sectionCount; 
      this._isReady = true;

      // 启动后台加载
      this._bookLoadPromise = this._lazyLoadBook(filePath, this._bookId);

      // 初始化 Hooks (book 为 null，但 hooks 将通过 getter 访问)
      this._initHooks(); 

      return {
        ...metadata.bookInfo,
        format: 'epub',
      };
    }

    // 3. 缓存未命中，执行完整加载
    logError(`[EpubRenderer] 元数据未命中，执行完整加载`).catch(() => {});
    await this._lazyLoadBook(filePath, this._bookId);
    
    // 标记就绪
    this._isReady = true;
    
    // 初始化 Hooks
    this._initHooks();
    
    // 返回 BookInfo
    const book = this._book!;
    const bookInfo: BookInfo = {
      title: book.metadata?.title,
      author: Array.isArray(book.metadata?.author) ? book.metadata?.author.join(', ') : book.metadata?.author,
      publisher: book.metadata?.publisher,
      language: book.metadata?.language,
      description: book.metadata?.description,
      pageCount: this._totalPages,
      format: 'epub',
      coverImage: await this._loaderHook.getCoverImage(book),
    };
    
    return bookInfo;
  }

  /**
   * 懒加载书籍文件（后台执行）
   */
  private async _lazyLoadBook(filePath: string, bookId: string): Promise<void> {
    try {
      // 通过 Tauri 读取文件
      const invoke = await getInvoke();
      const bytes = await invoke<number[]>('read_file_bytes', { path: filePath });
      const arrayBuffer = new Uint8Array(bytes).buffer;

      // 创建 File 对象
      const fileName = this._loaderHook.extractFileName(filePath);
      const file = new File([arrayBuffer], fileName + '.epub', {
        type: 'application/epub+zip',
      });

      this._book = await this._loaderHook.createBookFromFile(file);
      
      // 更新状态
      const book = this._book;
      this._sectionCount = book.sections?.length || 1;
      this._toc = this._loaderHook.convertToc(book.toc || []);
      
      // 首次加载（非缓存恢复）时，sectionCount 可能变化，需更新 totalPages
      if (this._totalPages === 1 && this._sectionCount > 1) {
         this._totalPages = this._sectionCount;
      }

      logError(`[EpubRenderer] 书籍后台加载完成: ${bookId}`).catch(() => {});

      // 缓存元数据（排除 coverImage，它可能是 Blob 无法序列化）
      const bookInfoForCache: BookInfo = {
        title: book.metadata?.title,
        author: Array.isArray(book.metadata?.author) ? book.metadata?.author.join(', ') : book.metadata?.author,
        publisher: book.metadata?.publisher,
        language: book.metadata?.language,
        description: book.metadata?.description,
        pageCount: this._totalPages,
        format: 'epub',
        // coverImage 不存储，它可能是 Blob 无法序列化到 IndexedDB
      };

      await epubCacheService.saveMetadata(bookId, {
         bookInfo: bookInfoForCache,
         toc: this._toc,
         sectionCount: this._sectionCount,
      });

    } catch (e) {
      logError(`[EpubRenderer] 书籍加载失败: ${e}`).catch(() => {});
      throw e;
    } finally {
      // 标记 promise 完成（虽然没置空，但后续 await 会立即 resolve）
      // this._bookLoadPromise = null; // 可选，保留作为状态指示
    }
  }

  /**
   * 确保书籍已加载
   */
  private async _ensureBookLoaded(): Promise<void> {
    if (this._book) return;
    if (this._bookLoadPromise) {
      await this._bookLoadPromise;
    }
  }

  /**
   * 为横向模式注入外部资源缓存到 foliate-js
   * 加速已缓存资源的加载，避免重复解析
   */
  private _injectResourceCacheToBook(): void {
    if (!this._book || !this._resourceCache || !this._bookId) return;

    const bookId = this._bookId;
    const resourceCache = this._resourceCache;
    const book = this._book as any;

    // 检查 book 是否支持 setResourceCache 方法
    if (typeof book.setResourceCache !== 'function') {
      return;
    }

    // 创建外部缓存适配器
    const externalCache = {
      /**
       * 从缓存获取资源
       * @param href - 资源路径（相对于 EPUB 根目录）
       * @param mediaType - 资源 MIME 类型
       * @returns 缓存命中时返回 { url: blobUrl }，否则返回 null
       */
      get: async (href: string, mediaType?: string): Promise<{ url: string } | null> => {
        try {
          const cachedData = resourceCache.get(bookId, href);
          if (!cachedData) return null;

          // 确定 MIME 类型
          const mimeType = mediaType || getMimeType(href);
          
          // 创建 Blob URL
          const blob = new Blob([cachedData], { type: mimeType });
          const url = URL.createObjectURL(blob);
          
          // 记录 Blob URL 以便后续清理
          this._blobUrls.add(url);
          
          return { url };
        } catch {
          return null;
        }
      },
    };

    // 注入缓存到 book 对象
    try {
      book.setResourceCache(externalCache);
      logError(`[EpubRenderer] 横向模式缓存注入成功: ${bookId}`).catch(() => {});
    } catch (e) {
      logError(`[EpubRenderer] 横向模式缓存注入失败: ${e}`).catch(() => {});
    }
  }

  /**
   * 获取目录
   */
  async getToc(): Promise<TocItem[]> {
    return this._toc;
  }

  /**
   * 获取总页数（章节数）
   */
  getPageCount(): number {
    return this._totalPages;
  }

  /**
   * 获取当前页码（章节索引）
   */
  getCurrentPage(): number {
    return this._currentPage;
  }

  /**
   * 获取当前精确阅读进度
   * 返回浮点数：整数部分为章节序号（1-based），小数部分为章节内偏移比例
   */
  getPreciseProgress(): number {
    return this._currentPreciseProgress;
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
    
    // 纵向模式：允许缓存优先渲染，不强制等待 _book
    // 如果章节已缓存，renderSection 会直接从缓存渲染，无需 _book
    // 只有在缓存未命中时，renderSection 内部会调用 ensureBookLoaded
    if (readingMode === 'vertical') {
      // 纵向模式只需要 _isReady（元数据已加载）
      if (!this._isReady) {
        throw new Error('Document not loaded');
      }
      
      const theme = options?.theme || this._currentTheme || 'light';
      this._currentTheme = theme as ReaderTheme;
      this._currentContainer = container;
      this._readingMode = 'vertical';
      
      return this.renderVerticalContinuous(container, {
        ...options,
        theme,
      });
    }
    
    // 横向模式：必须等待 _book 加载完成（foliate-js View 需要完整 book 对象）
    if (!this._book && this._bookLoadPromise) {
      logError('[EpubRenderer] renderPage (horizontal): 等待懒加载完成...').catch(() => {});
      await this._ensureBookLoaded();
    }

    if (!this._isReady || !this._book) {
      throw new Error('Document not loaded');
    }

    const theme = options?.theme || this._currentTheme || 'light';
    this._currentTheme = theme as ReaderTheme;
    this._currentContainer = container;
    this._readingMode = 'horizontal';

    // 检查是否可以复用现有视图（同一容器且 view 仍然有效）
    const canReuseView = this._view 
      && this._lastRenderContainer === container
      && container.contains(this._view);

    if (canReuseView) {
      // 复用现有视图，仅更新阅读模式和位置
      this._applyFlowSafely();
      
      // 跳转到指定位置
      const initialProgress = options?.initialVirtualPage;
      const targetPage = initialProgress && initialProgress > 0
        ? Math.floor(initialProgress)
        : page;
      const clampedTarget = Math.min(this._sectionCount, Math.max(1, targetPage));

      if (clampedTarget !== this._currentPage) {
        await this.goToPage(clampedTarget);
      }
      return;
    }

    // 清空容器
    container.innerHTML = '';
    this._lastRenderContainer = container;

    // 创建 foliate-view 元素
    // 先确保自定义元素已注册
    // @ts-ignore - foliate-js
    await import('../../../lib/foliate-js/view.js');

    const view = document.createElement('foliate-view') as FoliateView;
    view.style.cssText = `
      width: 100%;
      height: 100%;
      display: block;
    `;

    const containerWidth = container.clientWidth;

    this._readingMode = options?.readingMode || 'horizontal';

    this._applyTheme(view, {
      ...options,
      theme,
    });

    container.appendChild(view);
    this._view = view;

    // 监听位置变化事件
    view.addEventListener('relocate', (e: any) => {
      this._handleRelocate(e.detail);
    });

    // 禁用 foliate-view 内部 iframe 的触摸事件，让 App 控件系统接管
    view.addEventListener('load', () => {
      this._disableFoliateTouch();
      this._applyFlowSafely();
    });

    // 打开书籍
    await view.open(this._book);

    // 横向模式缓存加速：注入外部资源缓存到 foliate-js
    this._injectResourceCacheToBook();

    
    const r: any = view.renderer;
    if (r?.setAttribute) {
      const effectiveWidth = containerWidth > 0
        ? Math.max(280, containerWidth - 32)
        : 360;
      r.setAttribute('max-inline-size', `${effectiveWidth}px`);
      r.setAttribute('max-column-count', '1');
      r.setAttribute('margin', '24px');
    }

    
    try {
      if (this._resizeObserver) {
        this._resizeObserver.disconnect();
        this._resizeObserver = null;
      }
      this._resizeObserver = new ResizeObserver((entries) => {
        const width = entries[0]?.contentRect?.width || 0;
        if (width > 0 && this._view?.renderer?.setAttribute) {
          const effectiveWidth = Math.max(280, width - 32);
          this._view!.renderer.setAttribute('max-inline-size', `${effectiveWidth}px`);
        }
      });
      this._resizeObserver.observe(container);
    } catch {}

    this._applyFlowSafely();
    
    // 初始化到指定位置
    const initialProgress = options?.initialVirtualPage;
    const initialPage = initialProgress && initialProgress > 0
      ? Math.floor(initialProgress)
      : page;
    const clampedInitialPage = Math.min(this._sectionCount, Math.max(1, initialPage));

    if (clampedInitialPage > 1) {
      await view.init({ lastLocation: clampedInitialPage - 1 });
      this._currentPage = clampedInitialPage;
    } else {
      await view.init({ showTextStart: true });
      this._currentPage = 1;
    }
    this._currentPreciseProgress = initialProgress && initialProgress > 0
      ? initialProgress
      : this._currentPage;

    // 等待下一帧渲染完成，确保 foliate-js 内部布局计算正确
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
    });

    // 重新应用滚动模式，确保初始化后属性生效
    this._applyFlowSafely();

    // 回流兜底：重新设置关键属性触发内部重排，避免重进白屏
    try {
      const r: any = this._view?.renderer;
      if (r?.setAttribute) {
        const containerWidth2 = this._currentContainer?.clientWidth || 0;
        const effectiveWidth2 = containerWidth2 > 0
          ? Math.max(280, containerWidth2 - 32)
          : 360;
        // 通过轻微修改再还原触发 attributeChanged 重渲染
        const tweak = Math.max(200, effectiveWidth2 - 1);
        r.setAttribute('max-inline-size', `${tweak}px`);
        r.setAttribute('max-inline-size', `${effectiveWidth2}px`);
        r.setAttribute('flow', 'scrolled');
        r.setAttribute('max-column-count', '1');
      }
    } catch {}

    const isReady = () => {
      try {
        const r: any = this._view?.renderer;
        const doc = r?.getContents?.()[0]?.doc;
        if (!doc) return false;
        const h = Math.max(doc.body?.scrollHeight || 0, doc.documentElement?.scrollHeight || 0);
        const w = Math.max(doc.body?.scrollWidth || 0, doc.documentElement?.scrollWidth || 0);
        return h > 0 || w > 0;
      } catch { return false; }
    };

    const waitFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

    if (!isReady()) {
      await waitFrame();
      this._applyFlowSafely();
    }
    if (!isReady()) {
      await this._view!.init({ showTextStart: true });
      await waitFrame();
      this._applyFlowSafely();
    }
    if (!isReady()) {
      try {
        const old = this._view!;
        old.close();
        container.removeChild(old);
      } catch {}
      const view2 = document.createElement('foliate-view') as FoliateView;
      view2.style.cssText = `
        width: 100%;
        height: 100%;
        display: block;
      `;
      this._applyTheme(view2, {
        ...options,
        theme,
      });
      container.appendChild(view2);
      this._view = view2;
      view2.addEventListener('relocate', (e: any) => this._handleRelocate(e.detail));
      view2.addEventListener('load', () => { this._disableFoliateTouch(); this._applyFlowSafely(); });
      await view2.open(this._book);
      // 备用视图也需要注入缓存
      this._injectResourceCacheToBook();
      const r2: any = view2.renderer;
      if (r2?.setAttribute) {
        const w2 = container.clientWidth;
        const eff2 = w2 > 0 ? Math.max(280, w2 - 32) : 360;
        r2.setAttribute('max-inline-size', `${eff2}px`);
        r2.setAttribute('max-column-count', '1');
        r2.setAttribute('margin', '24px');
      }
      await view2.init({ showTextStart: true });
      await waitFrame();
      this._applyFlowSafely();
    }
  }

  /**
   * 应用主题样式
   */
  private _applyTheme(view: FoliateView, options?: RenderOptions): void {
    this._themeHook.applyTheme(view, options);
  }

  /**
   * 处理位置变化事件
   */
  private _handleRelocate(detail: any): void {
    // 兼容不同的事件数据结构：优先使用 index，否则尝试从 section.current 获取
    let pageIndex: number | undefined;
    if (typeof detail?.index === 'number') {
      pageIndex = detail.index;
    } else if (typeof detail?.section?.current === 'number') {
      pageIndex = detail.section.current;
    }

    if (typeof pageIndex === 'number') {
      this._currentPage = pageIndex + 1;
      this._currentPreciseProgress = this._currentPage;
    }

    // 更新当前目录项 href（用于高亮）
    if (detail?.tocItem?.href) {
      this._currentTocHref = detail.tocItem.href;
    }

    // 触发页面变化回调
    if (this.onPageChange) {
      this.onPageChange(this._currentPage);
    }

    // 触发目录变化回调
    if (this.onTocChange && this._currentTocHref) {
      this.onTocChange(this._currentTocHref);
    }
  }

  /**
   * 纵向连续渲染模式
   * 将所有章节渲染到一个可滚动容器中，章节之间有分割线
   */
  async renderVerticalContinuous(container: HTMLElement, options?: RenderOptions): Promise<void> {
    if (!this._verticalRenderHook) {
      throw new Error('Vertical render hook not initialized');
    }

    const theme = options?.theme || this._currentTheme || 'light';
    this._currentTheme = theme as ReaderTheme;
    this._currentPageGap = options?.pageGap ?? this._currentPageGap;

    await this._verticalRenderHook.renderVerticalContinuous(container, {
      ...options,
      theme,
      pageGap: this._currentPageGap,
    });

    // 同步状态
    this._currentPage = this._verticalRenderHook.state.currentPage;
    this._currentPreciseProgress = this._verticalRenderHook.state.currentPreciseProgress;
  }
  

  /**
   * 清理生成的 Blob URL
   */
  private _clearBlobUrls(): void {
    this._blobUrls.forEach(url => URL.revokeObjectURL(url));
    this._blobUrls.clear();
  }

  /**
   * 跳转到指定页面（章节）
   */
  async goToPage(page: number): Promise<void> {
    // 纵向连续模式下的跳转
    if (this._verticalRenderHook?.state.verticalContinuousMode) {
      await this._verticalRenderHook.goToPage(page);
      this._currentPage = this._verticalRenderHook.state.currentPage;
      this._currentPreciseProgress = this._verticalRenderHook.state.currentPreciseProgress;
      return;
    }

    // 横向模式：使用 foliate-view 的 goTo
    if (!this._view || page < 1 || page > this._totalPages) return;

    const sectionIndex = page - 1;
    try {
      await this._view.goTo(sectionIndex);
      this._currentPage = page;
      this._currentPreciseProgress = page;

      // 延迟触发回调，确保跳转完成
      setTimeout(() => {
        if (this.onPageChange) {
          this.onPageChange(page);
        }
      }, 300);
    } catch (e) {
      logError('[EpubRenderer] 跳转失败:', e).catch(() => {});
    }
  }

  /**
   * 跳转到目录项（href）
   */
  async goToHref(href: string): Promise<void> {
    // 纵向连续模式下，根据 href 找到对应章节并跳转
    if (this._verticalRenderHook?.state.verticalContinuousMode) {
      // 规范化 href（移除锚点）
      const normalizeHref = (h: string) => h?.split('#')[0] || '';
      const hrefBase = normalizeHref(href);
      
      // 查找匹配的章节索引
      const findSectionIndex = (): number => {
        if (!this._book) return -1;
        
        return this._book.sections.findIndex((section: any) => {
          const sectionId = normalizeHref(section.id || '');
          // 完整匹配或基础路径匹配
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
    
    // 横向模式：使用 foliate-view 的 goTo
    if (!this._view) return;
    try {
      await this._view.goTo(href);
    } catch (e) {
      logError('[EpubRenderer] 跳转到 href 失败:', e).catch(() => {});
    }
  }

  /**
   * 下一页
   */
  async nextPage(): Promise<void> {
    if (this._verticalRenderHook?.state.verticalContinuousMode) {
      const nextPage = Math.min(this._currentPage + 1, this._totalPages);
      await this.goToPage(nextPage);
      return;
    }
    
    if (!this._view) return;
    await this._view.next();
  }

  /**
   * 上一页
   */
  async prevPage(): Promise<void> {
    if (this._verticalRenderHook?.state.verticalContinuousMode) {
      const prevPage = Math.max(this._currentPage - 1, 1);
      await this.goToPage(prevPage);
      return;
    }
    
    if (!this._view) return;
    await this._view.prev();
  }

  /**
   * 搜索文本
   */
  async searchText(
    query: string,
    options?: { caseSensitive?: boolean }
  ): Promise<SearchResult[]> {
    if (!this._view || !this._book) return [];

    const results: SearchResult[] = [];

    try {
      // 使用 foliate-view 的搜索功能
      const searchGen = (this._view as any).search?.({
        query,
        matchCase: options?.caseSensitive,
      });

      if (searchGen) {
        for await (const result of searchGen) {
          if (result === 'done') break;
          if (result.subitems) {
            for (const item of result.subitems) {
              results.push({
                page: 1, // EPUB 使用 CFI 定位，页码仅供参考
                text: item.excerpt?.text || '',
                context: item.excerpt?.text || '',
                position: {
                  cfi: item.cfi,
                },
              });
            }
          }
        }
      }
    } catch (e) {
      logError('[EpubRenderer] 搜索失败:', e).catch(() => {});
    }

    return results;
  }

  /**
   * 提取指定章节的文本
   */
  async extractText(page: number): Promise<string> {
    if (!this._book) return '';

    const sectionIndex = page - 1;
    if (sectionIndex < 0 || sectionIndex >= this._sectionCount) return '';

    try {
      const section = this._book.sections[sectionIndex];
      if (section?.createDocument) {
        const doc = await section.createDocument();
        return doc.body?.textContent || '';
      }
    } catch (e) {
      logError('[EpubRenderer] 提取文本失败:', e).catch(() => {});
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
    if (!this._view) return;
    this.goToHref(anchor).catch((e) => {
      logError('[EpubRenderer] 滚动到锚点失败:', e).catch(() => {});
    });
  }

  /**
   * 获取滚动容器
   */
  getScrollContainer(): HTMLElement | null {
    // 纵向连续模式下，容器本身就是滚动容器
    if (this._verticalRenderHook?.state.verticalContinuousMode) {
      return this._currentContainer;
    }
    return this._currentContainer;
  }

  /**
   * 计算虚拟页数
   */
  calculateVirtualPages(_viewportHeight: number): number {
    return this._totalPages;
  }

  /**
   * 获取当前虚拟页码
   */
  getCurrentVirtualPage(_scrollTop: number, _viewportHeight: number): number {
    return this._currentPage;
  }

  /**
   * 滚动到指定虚拟页
   */
  scrollToVirtualPage(page: number, _viewportHeight: number): void {
    this.goToPage(page).catch(() => {});
  }

  /**
   * 关闭并释放资源
   */
  async close(): Promise<void> {
    this._clearBlobUrls();
    if (this._resizeObserver) {
      try { this._resizeObserver.disconnect(); } catch {}
      this._resizeObserver = null;
    }
    
    // 清理纵向连续模式的 hook 资源
    if (this._verticalRenderHook) {
      this._verticalRenderHook.cleanup();
    }

    // 注意：不在 close() 时清空缓存
    // 缓存由 LRU + 空闲过期策略管理，与 PDF 缓存行为一致
    // 用户可通过设置页的缓存配置来管理缓存
    this._bookId = null;
    
    // 关闭视图
    if (this._view) {
      try {
        this._view.close();
      } catch (e) {
        // 忽略关闭错误
      }
      this._view = null;
    }

    // 销毁书籍对象
    if (this._book) {
      try {
        this._book.destroy();
      } catch (e) {
        // 忽略销毁错误
      }
      this._book = null;
    }

    this._isReady = false;
    this._toc = [];
    this._currentContainer = null;
    this._lastRenderContainer = null;
    this._currentPage = 1;
    this._totalPages = 1;
    this._sectionCount = 0;
    this._currentPageGap = 4;
    
    // 清理 hooks 引用
    this._resourceHook = null;
    this._navigationHook = null;
    this._verticalRenderHook = null;
  }

  /** 页面变更回调 */
  onPageChange?: (page: number) => void;

  /** 目录变化回调（返回当前 href） */
  onTocChange?: (href: string) => void;

  /** 滚动活跃回调（用于更新阅读时长统计的活跃时间） */
  onScrollActivity?: () => void;

  /** 首屏渲染完成回调（EPUB 纵向模式专用，用于提前隐藏 loading） */
  onFirstScreenReady?: () => void;

  /**
   * 获取当前目录项 href
   */
  getCurrentTocHref(): string | null {
    return this._currentTocHref;
  }

  updatePageGap(pageGap: number): void {
    if (!this._verticalRenderHook?.state.verticalContinuousMode) return;
    
    if (pageGap === this._currentPageGap) return;
    
    this._currentPageGap = pageGap;
    this._verticalRenderHook.updatePageGap(pageGap);
  }

  /**
   * 设置阅读模式
   * 切换模式时会保存当前位置并在切换后恢复
   */
  async setReadingMode(mode: 'horizontal' | 'vertical'): Promise<void> {
    if (this._readingMode === mode) return;
    
    const savedProgress = this._currentPreciseProgress > 0 ? this._currentPreciseProgress : this._currentPage;
    const savedPage = Math.max(1, Math.floor(savedProgress) || this._currentPage || 1);
    
    const isCurrentlyVertical = this._verticalRenderHook?.state.verticalContinuousMode;
    
    if (isCurrentlyVertical && mode === 'horizontal') {
      this._readingMode = mode;
      
      // 清理纵向模式状态，重置 verticalContinuousMode
      if (this._verticalRenderHook) {
        this._verticalRenderHook.cleanup();
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
    
    if (!isCurrentlyVertical && mode === 'vertical') {
      this._readingMode = mode;
      
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
    
    // 横向模式内的切换（使用 foliate-view）
    const savedLocation = this._view?.lastLocation;
    const contents = this._view?.renderer?.getContents?.();
    const currentIndex = Array.isArray(contents) && typeof contents[0]?.index === 'number' ? contents[0].index : null;
    
    this._readingMode = mode;
    this._applyFlowSafely();
    
    // 等待布局重新计算
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve());
      });
    });
    
    // 恢复到之前的位置
    if (!this._view) return;
    if (savedLocation) {
      try { await this._view.goTo(savedLocation); return; } catch {}
    }
    if (currentIndex != null) {
      try { await this.goToPage(currentIndex + 1); return; } catch {}
    }
    if (savedPage > 1) {
      try { await this.goToPage(savedPage); } catch {}
    }
  }

  scrollBy(deltaY: number): void {
    // 纵向连续模式下，直接滚动容器
    if (this._verticalRenderHook?.state.verticalContinuousMode && this._currentContainer) {
      this._currentContainer.scrollBy({ top: deltaY, behavior: 'smooth' });
      return;
    }
    
    const r = this._view?.renderer;
    if (!r || typeof r.scrollBy !== 'function') return;
    try {
      // 适配水平书写或垂直书写两种情况
      r.scrollBy(deltaY, deltaY);
    } catch {}
  }

  /**
   * 禁用 foliate-view 内部的触摸交互，让 App 控件系统接管
   */
  private _disableFoliateTouch(): void {
    try {
      // 保留默认指针事件，避免滚动与滚轮被屏蔽
      // foliate-js 的触摸翻页由内部处理，我们通过外层控件进行点击翻页即可
    } catch (e) {
      logError('[EpubRenderer] 禁用触摸事件失败:', e).catch(() => {});
    }
  }

  private _applyFlowSafely(): void {
    const r: any = this._view?.renderer;
    if (!r) return;
    const hasContents = typeof r.getContents === 'function'
      && Array.isArray(r.getContents())
      && r.getContents().length > 0
      && r.getContents()[0]?.doc;
    const apply = () => {
      try {
        // 始终使用滚动模式，以确保内容完整显示并支持滚动
        r.setAttribute('flow', 'scrolled');
      } catch {}
    };
    if (hasContents) {
      apply();
    } else if (typeof r.addEventListener === 'function') {
      const once = () => {
        apply();
        try { r.removeEventListener('load', once as any); } catch {}
      };
      r.addEventListener('load', once as any);
    }
  }
}

// 注册 EPUB 渲染器
registerRenderer({
  format: 'epub',
  extensions: ['.epub'],
  factory: () => new EpubRenderer(),
  displayName: 'EPUB',
});

/**
 * MOBI 渲染器
 * 使用 foliate-js 解析 MOBI/AZW3 电子书并渲染
 */

import {
  IBookRenderer,
  BookFormat,
  BookInfo,
  TocItem,
  RendererCapabilities,
  RenderOptions,
  SearchResult,
} from '../types';
import { registerRenderer } from '../registry';

// Hooks
import {
  useMobiLifecycle,
  useMobiRender,
  useMobiNavigation,
  useMobiTheme,
  MobiLifecycleHook,
  MobiRenderHook,
  MobiNavigationHook,
  MobiThemeHook,
} from './hooks';

/**
 * MOBI 渲染器实现
 * 支持纵向滚动的 DOM 渲染模式
 */
export class MobiRenderer implements IBookRenderer {
  readonly format: BookFormat = 'mobi';

  /** MOBI 渲染器能力配置 */
  readonly capabilities: RendererCapabilities = {
    supportsBitmap: false,
    supportsDomRender: true,
    supportsPagination: false, // 首版仅支持单页滚动
    supportsSearch: false, // 暂不支持搜索
  };

  private _lifecycleHook: MobiLifecycleHook;
  private _themeHook: MobiThemeHook;
  private _renderHook: MobiRenderHook | null = null;
  private _navigationHook: MobiNavigationHook | null = null;
  private _currentHideDivider: boolean = false;

  // Blob URL 管理
  // 资源清理主要由 Hooks 处理，此处保留扩展能力

  constructor() {
    this._lifecycleHook = useMobiLifecycle();
    this._themeHook = useMobiTheme();
  }

  private _initHooks(): void {
    // 初始化渲染 Hook
    const lifecycleHook = this._lifecycleHook;
    const renderContext = {
      // 通过闭包访问生命周期状态
      get book() { return lifecycleHook.state.book; },
      get bookId() { return lifecycleHook.state.bookId; },
      get sectionCount() { return lifecycleHook.state.sectionCount; },
      ensureBookLoaded: lifecycleHook.ensureBookLoaded,
      themeHook: this._themeHook,
      onPageChange: (page: number) => {
        if (this.onPageChange) this.onPageChange(page);
      },
      onTocChange: (anchor: string) => {
        if (this.onTocChange) this.onTocChange(anchor);
      },
      onPositionRestored: () => {
        if (this.onPositionRestored) this.onPositionRestored();
      },
      onScrollActivity: () => {
        if (this.onScrollActivity) this.onScrollActivity();
      }
    };
    
    // @ts-ignore
    this._renderHook = useMobiRender(renderContext);

    // 初始化导航 Hook
    const navContext = {
      get book() { return lifecycleHook.state.book; },
      getRenderState: () => {
         if (!this._renderHook) throw new Error("Render hook not initialized");
         return this._renderHook.state; 
      },
      onPageChange: (page: number) => {
        if (this.onPageChange) this.onPageChange(page);
      }
    };
    
    // @ts-ignore
    this._navigationHook = useMobiNavigation(navContext);
  }

  get isReady(): boolean {
    return this._lifecycleHook.state.isReady;
  }

  /**
   * 加载 MOBI 文档
   * @param filePath 文件路径
   * @param options 加载选项（可选，用于大文件导入等场景）
   */
  async loadDocument(filePath: string, options?: { skipPreloaderCache?: boolean }): Promise<BookInfo> {
    const info = await this._lifecycleHook.loadDocument(filePath, {
      skipPreloaderCache: options?.skipPreloaderCache,
    });
    this._initHooks();
    return info;
  }

  /**
   * 获取目录
   */
  async getToc(): Promise<TocItem[]> {
    return this._lifecycleHook.state.toc;
  }

  /**
   * 获取总页数（返回章节总数）
   */
  getPageCount(): number {
    return this._lifecycleHook.state.sectionCount || 1;
  }

  /**
   * 获取当前精确阅读进度
   */
  getPreciseProgress(): number {
    return this._renderHook?.state.currentPreciseProgress || 1;
  }

  /**
   * 渲染页面到容器
   */
  async renderPage(
    page: number,
    container: HTMLElement,
    options?: RenderOptions
  ): Promise<void> {
    if (!this._renderHook) {
        // Defensive init if needed? Or throw?
        // Usually loadDocument is called first.
        throw new Error('Render hook not initialized');
    }
    const finalOptions = options ? { ...options } : undefined;
    if (finalOptions) {
      if (typeof finalOptions.hideDivider === 'boolean') {
        this._currentHideDivider = finalOptions.hideDivider;
      } else {
        finalOptions.hideDivider = this._currentHideDivider;
      }
    }
    return this._renderHook.renderPage(page, container, finalOptions);
  }

  /**
   * 获取当前页码
   */
  getCurrentPage(): number {
    return this._renderHook?.state.currentVirtualPage || 1;
  }

  /**
   * 跳转到指定页面 (章节)
   */
  async goToPage(page: number): Promise<void> {
    return this._navigationHook?.goToPage(page);
  }

  /**
   * 搜索文本（暂不支持）
   */
  async searchText(
    _query: string,
    _options?: { caseSensitive?: boolean }
  ): Promise<SearchResult[]> {
    // 首版暂不支持搜索
    return [];
  }

  /**
   * 提取页面文本
   */
  async extractText(_page: number): Promise<string> {
    const shadowRoot = this._renderHook?.state.shadowRoot;
    if (!shadowRoot) return '';
    
    const bodyEl = shadowRoot.querySelector('.mobi-body');
    return bodyEl?.textContent || '';
  }

  getScrollContainer(): HTMLElement | null {
    return this._renderHook?.state.scrollContainer || null;
  }

  calculateVirtualPages(_viewportHeight: number): number {
    return this.getPageCount();
  }

  getCurrentVirtualPage(_scrollTop: number, _viewportHeight: number): number {
    return this.getCurrentPage();
  }

  scrollToVirtualPage(page: number, _viewportHeight: number): void {
    this.goToPage(page).catch(() => {});
  }

  /**
   * 滚动到锚点
   */
  async scrollToAnchor(anchor: string): Promise<void> {
      return this._navigationHook?.scrollToAnchor(anchor);
  }

  /**
   * 关闭并释放资源
   */
  async close(): Promise<void> {
    this._renderHook?.reset();
    await this._lifecycleHook.reset();
    
    this._renderHook = null;
    this._navigationHook = null;
    // _themeHook is stateless
  }

  updateDividerVisibility(hidden: boolean): void {
    this._currentHideDivider = hidden;
    if (this._renderHook) {
      this._renderHook.updateDividerVisibility(hidden);
    }
  }

  /** 页面变化回调 */
  onPageChange?: (page: number) => void;
  onTocChange?: (anchor: string) => void;
  onPositionRestored?: () => void;
  onScrollActivity?: () => void;
}

// 注册 MOBI 渲染器
registerRenderer({
  format: 'mobi',
  extensions: ['.mobi', '.azw3', '.azw'],
  factory: () => new MobiRenderer(),
  displayName: 'MOBI',
});

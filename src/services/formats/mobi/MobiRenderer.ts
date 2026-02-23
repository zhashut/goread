/**
 * MOBI 渲染器
 * 通过 Rust 后端解析 MOBI/AZW3 电子书，前端负责渲染
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
 */
export class MobiRenderer implements IBookRenderer {
  readonly format: BookFormat = 'mobi';

  readonly capabilities: RendererCapabilities = {
    supportsBitmap: false,
    supportsDomRender: true,
    supportsPagination: false,
    supportsSearch: false,
  };

  private _lifecycleHook: MobiLifecycleHook;
  private _themeHook: MobiThemeHook;
  private _renderHook: MobiRenderHook | null = null;
  private _navigationHook: MobiNavigationHook | null = null;
  private _currentHideDivider: boolean = false;

  constructor() {
    this._lifecycleHook = useMobiLifecycle();
    this._themeHook = useMobiTheme();
  }

  private _initHooks(): void {
    const lifecycleHook = this._lifecycleHook;
    const renderContext = {
      get book() { return null as null; },
      get bookId() { return lifecycleHook.state.bookId; },
      get sectionCount() { return lifecycleHook.state.sectionCount; },
      ensureBookLoaded: lifecycleHook.ensureBookLoaded,
      themeHook: this._themeHook,
      onPageChange: (page: number) => { this.onPageChange?.(page); },
      onTocChange: (anchor: string) => { this.onTocChange?.(anchor); },
      onPositionRestored: () => { this.onPositionRestored?.(); },
      onScrollActivity: () => { this.onScrollActivity?.(); },
    };

    this._renderHook = useMobiRender(renderContext);

    const navContext = {
      getRenderState: () => {
        if (!this._renderHook) throw new Error('Render hook not initialized');
        return this._renderHook.state;
      },
      onPageChange: (page: number) => { this.onPageChange?.(page); },
    };

    this._navigationHook = useMobiNavigation(navContext);
  }

  get isReady(): boolean {
    return this._lifecycleHook.state.isReady;
  }

  async loadDocument(filePath: string, options?: { skipPreloaderCache?: boolean }): Promise<BookInfo> {
    const info = await this._lifecycleHook.loadDocument(filePath, {
      skipPreloaderCache: options?.skipPreloaderCache,
    });
    this._initHooks();
    return info;
  }

  async getToc(): Promise<TocItem[]> {
    return this._lifecycleHook.state.toc;
  }

  getPageCount(): number {
    return this._lifecycleHook.state.sectionCount || 1;
  }

  getPreciseProgress(): number {
    return this._renderHook?.state.currentPreciseProgress || 1;
  }

  async renderPage(page: number, container: HTMLElement, options?: RenderOptions): Promise<void> {
    if (!this._renderHook) throw new Error('Render hook not initialized');
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

  getCurrentPage(): number {
    return this._renderHook?.state.currentVirtualPage || 1;
  }

  async goToPage(page: number): Promise<void> {
    return this._navigationHook?.goToPage(page);
  }

  async searchText(_query: string, _options?: { caseSensitive?: boolean }): Promise<SearchResult[]> {
    return [];
  }

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
    this.goToPage(page).catch(() => { });
  }

  async scrollToAnchor(anchor: string): Promise<void> {
    return this._navigationHook?.scrollToAnchor(anchor);
  }

  async close(): Promise<void> {
    this._renderHook?.reset();
    await this._lifecycleHook.reset();
    this._renderHook = null;
    this._navigationHook = null;
  }

  updateDividerVisibility(hidden: boolean): void {
    this._currentHideDivider = hidden;
    this._renderHook?.updateDividerVisibility(hidden);
  }

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

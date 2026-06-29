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
import type {
  TTSContentProvider,
  TTSReadingPosition,
} from '../../tts/providers/TTSContentProvider';
import { MobiContentProvider } from '../../tts/providers/MobiContentProvider';
import { findFirstVisibleTextRange, rangeToTextQuote } from '../../../utils/ttsDOM';

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

  /**
   * 创建 MOBI TTS 内容供给方
   * 内容拉取统一走 Rust 端 tts_get_segments
   */
  createTTSContentProvider(): TTSContentProvider {
    return new MobiContentProvider({
      getBookId: () => this._lifecycleHook.state.bookId,
      getFilePath: () => this._lifecycleHook.state.filePath,
      getSectionCount: () => this._lifecycleHook.state.sectionCount,
      getShadowRoot: () => this._renderHook?.state.shadowRoot || null,
      getScrollContainer: () => this._renderHook?.state.scrollContainer || null,
      getVisibleStartPosition: () => this.getVisibleStartPositionForTTS(),
    });
  }

  /**
   * 计算"当前视口顶部"对应的 .mobi-section 索引和文本 anchor
   * 找到中心点所在的 section 后，在该 section 内用 findFirstVisibleTextRange 取顶部
   */
  private getVisibleStartPositionForTTS(): TTSReadingPosition | null {
    const shadowRoot = this._renderHook?.state.shadowRoot;
    const scrollContainer = this._renderHook?.state.scrollContainer;
    if (!shadowRoot || !scrollContainer) return null;

    const sections = Array.from(
      shadowRoot.querySelectorAll('.mobi-section'),
    ) as HTMLElement[];
    if (sections.length === 0) return null;

    const center = scrollContainer.scrollTop + scrollContainer.clientHeight / 2;
    let visibleIndex = 0;
    for (let i = 0; i < sections.length; i++) {
      const el = sections[i]!;
      const top = el.offsetTop;
      const bottom = top + el.offsetHeight;
      if (center >= top && center < bottom) {
        visibleIndex = i;
        break;
      }
    }

    const sectionEl = sections[visibleIndex];
    if (!sectionEl) return { sectionIndex: visibleIndex, anchor: null };

    const range = findFirstVisibleTextRange(sectionEl, scrollContainer, 'vertical');
    if (!range) return { sectionIndex: visibleIndex, anchor: null };

    const quote = rangeToTextQuote(range, {
      quoteLength: 24,
      contextLength: 24,
      searchRoot: sectionEl,
    });
    if (!quote) return { sectionIndex: visibleIndex, anchor: null };

    return {
      sectionIndex: visibleIndex,
      anchor: { quote: quote.quote, prefix: quote.prefix, suffix: quote.suffix },
    };
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


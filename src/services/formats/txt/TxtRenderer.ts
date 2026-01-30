/**
 * TXT 渲染器
 * 实现纯文本文件的阅读渲染与虚拟分页
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
import { logError, getInvoke } from '../../index';
import {
  useTxtRendererCore,
  type PageRange,
  type TxtRendererCore,
} from './hooks';

/** 后端目录项格式 */
interface BackendTocItem {
  title: string;
  location: number;
  level: number;
  children: BackendTocItem[];
}

/** 后端加载结果 */
interface TxtLoadResult {
  content: string;
  encoding: string;
  title: string | null;
  toc: BackendTocItem[];
  metadata: {
    title: string | null;
    page_count: number;
    format: string | null;
  };
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
  // 精确进度（浮点数），用于撤回跳转等场景的精确定位
  private _currentPreciseProgress: number = 1;

  // 目录更新回调，分页完成后触发，用于通知 UI 层刷新目录数据
  onTocUpdated?: (toc: TocItem[]) => void;

  constructor() {
    this._core = useTxtRendererCore();
  }

  get isReady(): boolean {
    return this._isReady;
  }

  /** 加载 TXT 文档 */
  async loadDocument(filePath: string): Promise<BookInfo> {
    try {
      const invoke = await getInvoke();
      const result: TxtLoadResult = await invoke('txt_load_document', {
        filePath,
      });

      this._content = result.content;
      this._encoding = result.encoding;
      this._toc = this._convertToc(result.toc);
      this._isReady = true;

      return {
        title: result.title || this._extractFileName(filePath),
        pageCount: 1,
        format: 'txt',
      };
    } catch (err) {
      logError('[TxtRenderer] loadDocument failed', { error: err, filePath });
      throw err;
    }
  }

  /** 转换后端目录格式 */
  private _convertToc(items: BackendTocItem[]): TocItem[] {
    return items.map((item) => ({
      title: item.title,
      location: item.location,
      level: item.level,
      children: item.children ? this._convertToc(item.children) : undefined,
    }));
  }

  /** 从路径提取文件名 */
  private _extractFileName(filePath: string): string {
    const parts = filePath.replace(/\\/g, '/').split('/');
    const fileName = parts[parts.length - 1] || 'Unknown';
    return fileName.replace(/\.[^/.]+$/, '');
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
    return this._currentPreciseProgress;
  }

  /** 更新精确进度，由滚动监听调用 */
  updatePreciseProgress(progress: number): void {
    const total = this.getPageCount() || 1;
    this._currentPreciseProgress = Math.max(1, Math.min(progress, total));
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
    this._lastRenderOptions = options || {};
    this._isVerticalMode = false;

    // 如果还没有分页，先进行分页计算
    if (this._pages.length === 0) {
      await this._calculatePages(container, options);
    }

    // 确保页码有效
    const validPage = Math.min(Math.max(1, page), this._pages.length);
    this._currentPage = validPage;

    // 获取当前页内容
    const pageInfo = this._pages[validPage - 1];
    const pageContent = this._content.slice(pageInfo.startOffset, pageInfo.endOffset);

    // 渲染内容
    this._renderContent(container, pageContent, options, false);
  }

  /** 渲染全部内容（纵向模式） */
  async renderFullContent(container: HTMLElement, options?: RenderOptions): Promise<void> {
    if (!this._isReady) {
      throw new Error('Document not loaded');
    }

    this._container = container;
    this._lastRenderOptions = options || {};
    this._isVerticalMode = true;

    if (this._pages.length === 0) {
      await this._calculatePages(container, options);
    }

    // 渲染全部内容
    this._renderContent(container, this._content, options, true);

    // 等待布局完成后记录滚动高度
    await new Promise<void>(resolve => {
      requestAnimationFrame(() => {
        this._scrollHeight = container.scrollHeight;
        resolve();
      });
    });
  }

  /** 计算虚拟页数（纵向模式） */
  calculateVirtualPages(viewportHeight: number): number {
    if (this._scrollHeight <= 0 || viewportHeight <= 0) {
      return 1;
    }
    return Math.max(1, Math.ceil(this._scrollHeight / viewportHeight));
  }

  /** 获取当前虚拟页（纵向模式） */
  getCurrentVirtualPage(scrollTop: number, viewportHeight: number): number {
    if (viewportHeight <= 0) {
      return 1;
    }
    const page = Math.floor(scrollTop / viewportHeight) + 1;
    return Math.max(1, page);
  }

  /** 滚动到虚拟页（纵向模式，支持浮点数精确进度） */
  scrollToVirtualPage(page: number, viewportHeight: number): void {
    // 记录精确进度
    this._currentPreciseProgress = page;

    if (!this._container || !this._isVerticalMode) {
      // 横向模式走 goToPage
      this.goToPage(page);
      return;
    }
    const container = this._container;
    if (viewportHeight <= 0) {
      container.scrollTop = 0;
      this._currentPage = 1;
      this._currentPreciseProgress = 1;
      return;
    }

    const totalPages = this.getPageCount() || 1;
    const validTotalPages = Math.max(1, totalPages);
    const clampedPage = Math.min(Math.max(1, page), validTotalPages);

    // 提取整数页码和页内偏移
    const pageIndex = Math.floor(clampedPage) - 1;  // 转为 0-based
    const offsetRatio = Math.max(0, Math.min(1, clampedPage - Math.floor(clampedPage)));

    // 查找对应的页面 wrapper
    const pageWrapper = container.querySelector(`[data-page-index="${pageIndex}"]`) as HTMLElement;

    if (pageWrapper) {
      // 基于 wrapper 位置 + 偏移计算目标滚动位置
      const wrapperTop = pageWrapper.offsetTop;
      const wrapperHeight = pageWrapper.scrollHeight;
      const targetScrollTop = wrapperTop + wrapperHeight * offsetRatio;
      
      container.scrollTop = targetScrollTop;
    } else {
      // 降级：使用原有的全局比例计算
      const maxScrollTop = Math.max(0, container.scrollHeight - viewportHeight);
      if (maxScrollTop > 0 && validTotalPages > 1) {
        const ratio = (clampedPage - 1) / (validTotalPages - 1);
        const clampedRatio = Math.max(0, Math.min(1, ratio));
        container.scrollTop = clampedRatio * maxScrollTop;
      }
    }

    this._currentPage = Math.floor(clampedPage);
    this._currentPreciseProgress = clampedPage;
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
      options
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

  /** 获取全文内容 */
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
    this._lastRenderOptions = options || {};

    if (this._pages.length === 0) {
      await this._calculatePages(container, options);
      // 分页完成后，通知 UI 层更新目录（此时目录页码已从字符偏移量转换为真实页码）
      this.onTocUpdated?.(this._toc);
    }
  }

  /** 是否为纵向模式 */
  isVerticalMode(): boolean {
    return this._isVerticalMode;
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

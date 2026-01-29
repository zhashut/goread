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

/** Get Tauri invoke function */
async function getInvoke() {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke;
}

export class HtmlRenderer implements IBookRenderer {
  readonly format: BookFormat = 'html';

  readonly capabilities: RendererCapabilities = {
    supportsBitmap: false,
    supportsDomRender: true,
    supportsPagination: false, // 虚拟分页通过滚动实现
    supportsSearch: true,
  };

  private _isReady = false;
  private _content = '';
  private _title = '';
  private _toc: TocItem[] = [];
  private _currentContainer: HTMLElement | null = null;
  
  // 虚拟分页相关
  private _currentPreciseProgress: number = 1;
  private _shadowRoot: ShadowRoot | null = null;
  private _scrollHost: HTMLElement | null = null;

  /** 位置恢复完成回调 */
  onPositionRestored?: () => void;
  
  /** 目录变更回调（用于高亮当前章节） */
  onTocChange?: (anchor: string) => void;

  get isReady(): boolean {
    return this._isReady;
  }

  async loadDocument(filePath: string): Promise<BookInfo> {
    const invoke = await getInvoke();
    const result = await invoke<{ content: string; encoding: string; title?: string }>(
      'html_load_document',
      { filePath }
    );

    this._content = result.content;
    this._title = result.title || this.extractFileName(filePath);
    this._isReady = true;

    // 解析目录
    this._toc = this.parseToc(this._content);

    return {
      title: this._title,
      pageCount: 1,
      format: 'html',
    };
  }

  async getToc(): Promise<TocItem[]> {
    return this._toc;
  }

  getPageCount(): number {
    return 1;
  }

  async renderPage(page: number, container: HTMLElement, options?: RenderOptions): Promise<void> {
    if (!this._isReady) throw new Error('Document not loaded');
    if (page !== 1) throw new Error('HTML only supports page 1');

    this._currentContainer = container;

    // 清空容器
    container.innerHTML = '';
    
    // 创建 Shadow DOM 宿主
    const host = document.createElement('div');
    host.className = 'html-renderer-host';
    host.style.width = '100%';
    host.style.height = '100%';
    host.style.display = 'block';
    container.appendChild(host);

    // 创建 Shadow DOM 隔离样式
    const shadow = host.attachShadow({ mode: 'open' });

    // 解析 HTML 内容
    const parser = new DOMParser();
    const doc = parser.parseFromString(this._content, 'text/html');

    // 提取并处理样式
    let styleContent = '';
    const styleNodes = doc.querySelectorAll('style');
    styleNodes.forEach(style => {
      let css = style.textContent || '';
      css = css.replace(/(^|[\s,])html(?=[\s,{:])/gi, '$1:host');
      css = css.replace(/(^|[\s,])body(?=[\s,{:])/gi, '$1.html-body');
      styleContent += css + '\n';
    });

    // 默认样式（GitHub 风格）
    const defaultStyles = `
      :host {
        display: block;
        width: 100%;
        height: 100%;
        overflow-y: auto;
        overflow-x: hidden;
        contain: content;
        position: relative;
        background-color: #ffffff;
        color: #24292f;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji";
        line-height: 1.5;
        word-wrap: break-word;
        scrollbar-width: none !important;
        -ms-overflow-style: none;
      }
      :host::-webkit-scrollbar {
        width: 0 !important;
        height: 0 !important;
      }
      .html-body {
        min-height: 100%;
        padding: 32px;
        box-sizing: border-box;
        max-width: 1012px;
        margin: 0 auto;
      }
      /* Ensure images don't overflow */
      img {
        max-width: 100%;
        height: auto;
        box-sizing: content-box;
        background-color: #ffffff;
      }
      
      /* GitHub Theme Styles */
      a {
        color: #0969da;
        text-decoration: none;
      }
      a:hover {
        text-decoration: underline;
      }
      
      h1, h2, h3, h4, h5, h6 {
        margin-top: 24px;
        margin-bottom: 16px;
        font-weight: 600;
        line-height: 1.25;
      }
      
      h1 {
        font-size: 2em;
        padding-bottom: 0.3em;
        border-bottom: 1px solid #d0d7de;
      }
      
      h2 {
        font-size: 1.5em;
        padding-bottom: 0.3em;
        border-bottom: 1px solid #d0d7de;
      }
      
      h3 { font-size: 1.25em; }
      h4 { font-size: 1em; }
      h5 { font-size: 0.875em; }
      h6 { font-size: 0.85em; color: #656d76; }
      
      p {
        margin-top: 0;
        margin-bottom: 16px;
      }
      
      blockquote {
        margin: 0 0 16px;
        padding: 0 1em;
        color: #656d76;
        border-left: 0.25em solid #d0d7de;
      }
      
      ul, ol {
        margin-top: 0;
        margin-bottom: 16px;
        padding-left: 2em;
      }
      
      hr {
        height: 0.25em;
        padding: 0;
        margin: 24px 0;
        background-color: #d0d7de;
        border: 0;
      }
      
      table {
        border-spacing: 0;
        border-collapse: collapse;
        margin-top: 0;
        margin-bottom: 16px;
        display: block;
        width: max-content;
        max-width: 100%;
        overflow: auto;
      }
      
      tr {
        background-color: #ffffff;
        border-top: 1px solid #d8dee4;
      }
      
      tr:nth-child(2n) {
        background-color: #f6f8fa;
      }
      
      th, td {
        padding: 6px 13px;
        border: 1px solid #d0d7de;
      }
      
      th {
        font-weight: 600;
      }
      
      code, kbd, pre {
        font-family: ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace;
        font-size: 85%;
      }
      
      code {
        padding: 0.2em 0.4em;
        margin: 0;
        background-color: #afb8c133;
        border-radius: 6px;
      }
      
      pre {
        padding: 16px;
        overflow: auto;
        font-size: 85%;
        line-height: 1.45;
        background-color: #f6f8fa;
        border-radius: 6px;
      }
      
      pre code {
        background-color: transparent;
        padding: 0;
        margin: 0;
        border-radius: 0;
      }
    `;

    // 构建 Shadow DOM 内容
    shadow.innerHTML = `
      <style>
        ${defaultStyles}
        ${styleContent}
      </style>
      <div class="html-body">
        ${doc.body.innerHTML}
      </div>
    `;

    // 为标题元素添加唯一 ID（用于目录定位）
    const headings = shadow.querySelectorAll('h1, h2, h3, h4, h5, h6');
    headings.forEach((heading, index) => {
      heading.id = `html-heading-${index}`;
    });

    // 保存引用
    this._shadowRoot = shadow;
    this._scrollHost = host;

    // 容器禁用滚动，由 Shadow Host 内部滚动
    container.style.overflow = 'hidden';

    if (options?.fontSize) {
      host.style.fontSize = `${options.fontSize}px`;
    }

    // 位置恢复逻辑
    const initialProgress = options?.initialVirtualPage;
    if (typeof initialProgress === 'number' && initialProgress > 1) {
      this._restorePosition(initialProgress, host);
    } else {
      requestAnimationFrame(() => {
        this.onPositionRestored?.();
      });
    }
  }

  /**
   * 获取滚动容器
   */
  getScrollContainer(): HTMLElement | null {
    return this._scrollHost;
  }

  /**
   * 计算虚拟页数
   */
  calculateVirtualPages(viewportHeight: number): number {
    const scrollContainer = this.getScrollContainer();
    if (!scrollContainer || !this._shadowRoot) return 1;
    
    const contentHeight = scrollContainer.scrollHeight;
    return Math.max(1, Math.ceil(contentHeight / viewportHeight));
  }

  /**
   * 获取当前虚拟页码
   */
  getCurrentVirtualPage(scrollTop: number, viewportHeight: number): number {
    const scrollContainer = this.getScrollContainer();
    if (!scrollContainer) return 1;
    
    const contentHeight = scrollContainer.scrollHeight;
    const totalPages = Math.max(1, Math.ceil(contentHeight / viewportHeight));
    const maxScrollTop = Math.max(0, contentHeight - viewportHeight);
    
    // 计算精确进度
    if (maxScrollTop > 0 && totalPages > 1) {
      const scrollRatio = Math.max(0, Math.min(1, scrollTop / maxScrollTop));
      this._currentPreciseProgress = 1 + scrollRatio * (totalPages - 1);
    } else {
      this._currentPreciseProgress = 1;
    }
    
    // 接近底部时返回最后一页
    if (maxScrollTop > 0 && scrollTop >= maxScrollTop - 10) {
      return totalPages;
    }
    
    return Math.min(totalPages, Math.floor(scrollTop / viewportHeight) + 1);
  }

  /**
   * 获取精确进度（浮点数）
   */
  getPreciseProgress(): number {
    return this._currentPreciseProgress;
  }

  /**
   * 滚动到指定虚拟页
   */
  scrollToVirtualPage(page: number, viewportHeight: number): void {
    const scrollContainer = this.getScrollContainer();
    if (!scrollContainer) return;
    
    const scrollHeight = scrollContainer.scrollHeight;
    const maxScrollTop = Math.max(0, scrollHeight - viewportHeight);
    
    if (maxScrollTop <= 0) {
      scrollContainer.scrollTo({ top: 0, behavior: 'auto' });
      this._currentPreciseProgress = 1;
      return;
    }
    
    const totalPages = Math.max(1, Math.ceil(scrollHeight / viewportHeight));
    const clampedPage = Math.max(1, Math.min(page, totalPages));
    
    const scrollRatio = (clampedPage - 1) / (totalPages - 1);
    const targetScroll = scrollRatio * maxScrollTop;
    
    scrollContainer.scrollTo({ top: targetScroll, behavior: 'auto' });
    this._currentPreciseProgress = clampedPage;
  }

  /**
   * 跳转到指定锚点（目录点击）
   */
  scrollToAnchor(anchor: string): void {
    const scrollContainer = this.getScrollContainer();
    if (!scrollContainer || !this._shadowRoot) return;
    
    const heading = this._shadowRoot.getElementById(anchor);
    if (heading) {
      // 预留顶部空间（TopBar 约 60px + 20px 间距）
      const top = heading.offsetTop - 80;
      
      const originalBehavior = scrollContainer.style.scrollBehavior;
      scrollContainer.style.scrollBehavior = 'auto';
      scrollContainer.scrollTop = Math.max(0, top);
      scrollContainer.style.scrollBehavior = originalBehavior;
    }
  }

  getCurrentPage(): number {
    return 1;
  }

  async goToPage(page: number): Promise<void> {
    if (page !== 1) return;
  }

  async searchText(query: string, _options?: { caseSensitive?: boolean }): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    if (!query || query.length < 2) return results;
    return [];
  }

  async extractText(page: number): Promise<string> {
    if (page !== 1) return '';
    const tmp = document.createElement('div');
    tmp.innerHTML = this._content;
    return tmp.textContent || tmp.innerText || '';
  }

  async close(): Promise<void> {
    if (this._currentContainer) {
      this._currentContainer.innerHTML = '';
      this._currentContainer = null;
    }
    this._content = '';
    this._isReady = false;
    this._shadowRoot = null;
    this._scrollHost = null;
    this._currentPreciseProgress = 1;
  }

  onPageChange?: (page: number) => void;

  private extractFileName(path: string): string {
    const parts = path.split(/[/\\]/);
    return parts[parts.length - 1];
  }

  /**
   * 解析目录，为标题生成唯一锚点 ID
   */
  private parseToc(content: string): TocItem[] {
    const parser = new DOMParser();
    const doc = parser.parseFromString(content, 'text/html');
    const headers = doc.querySelectorAll('h1, h2, h3, h4, h5, h6');
    const toc: TocItem[] = [];
    
    headers.forEach((header, index) => {
      // 生成唯一 ID 作为锚点
      const headingId = `html-heading-${index}`;

      toc.push({
        title: header.textContent || '',
        level: parseInt(header.tagName.substring(1)),
        location: headingId, // 使用锚点字符串作为 location
      });
    });
    
    return toc;
  }

  /**
   * 位置恢复辅助方法
   */
  private _restorePosition(progress: number, _container: HTMLElement): void {
    let attempts = 0;
    const maxAttempts = 50;
    
    const tryRestore = () => {
      const scrollContainer = this.getScrollContainer();
      if (scrollContainer) {
        const vh = scrollContainer.clientHeight;
        const sh = scrollContainer.scrollHeight;
        if (vh > 0 && sh > vh) {
          this.scrollToVirtualPage(progress, vh);
          this.onPositionRestored?.();
          return;
        }
      }
      attempts++;
      if (attempts < maxAttempts) {
        setTimeout(tryRestore, 100);
      } else {
        this.onPositionRestored?.();
      }
    };
    setTimeout(tryRestore, 150);
  }
}

// 注册 HTML 渲染器
registerRenderer({
  format: 'html',
  extensions: ['.html', '.htm'],
  factory: () => new HtmlRenderer(),
  displayName: 'HTML',
});

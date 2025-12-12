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
} from '../types';
import { registerRenderer } from '../registry';

/** 获取 Tauri invoke 函数 */
async function getInvoke() {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke;
}

/** foliate-js 的 View 元素类型 */
interface FoliateView extends HTMLElement {
  open(book: any): Promise<void>;
  close(): void;
  goTo(target: any): Promise<any>;
  goToFraction(frac: number): Promise<void>;
  prev(distance?: number): Promise<void>;
  next(distance?: number): Promise<void>;
  init(options: { lastLocation?: any; showTextStart?: boolean }): Promise<void>;
  book: any;
  renderer: any;
  lastLocation: any;
  history: any;
  // 设置 flow 属性以控制滚动模式
  setAttribute(name: string, value: string): void;
}

/** EPUB 书籍对象类型 */
interface EpubBook {
  metadata: {
    title?: string;
    author?: string | string[];
    publisher?: string;
    language?: string;
    description?: string;
  };
  toc?: EpubTocItem[];
  sections: any[];
  getCover(): Promise<Blob | null>;
  destroy(): void;
}

/** EPUB 目录项类型 */
interface EpubTocItem {
  label?: string;
  href?: string;
  subitems?: EpubTocItem[];
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
  private _view: FoliateView | null = null;
  private _toc: TocItem[] = [];
  private _currentContainer: HTMLElement | null = null;
  private _currentPage = 1;
  private _totalPages = 1;
  private _sectionCount = 0;
  private _currentTocHref: string | null = null;
  private _readingMode: 'horizontal' | 'vertical' = 'horizontal';
  private _resizeObserver: ResizeObserver | null = null;
  private _lastRenderContainer: HTMLElement | null = null;

  get isReady(): boolean {
    return this._isReady;
  }

  /**
   * 加载 EPUB 文档
   */
  async loadDocument(filePath: string): Promise<BookInfo> {
    // 通过 Tauri 读取文件为 ArrayBuffer
    const invoke = await getInvoke();
    const bytes = await invoke<number[]>('read_file_bytes', { path: filePath });
    const arrayBuffer = new Uint8Array(bytes).buffer;

    // 创建 File 对象（foliate-js 需要 File 或 Blob）
    const fileName = this._extractFileName(filePath);
    const file = new File([arrayBuffer], fileName + '.epub', {
      type: 'application/epub+zip',
    });

    // 动态导入 foliate-js 的 makeBook 函数
    // @ts-ignore - foliate-js
    const { makeBook } = await import('../../../lib/foliate-js/view.js');
    this._book = await makeBook(file) as EpubBook;

    // 提取元数据
    const book = this._book!;
    const metadata = book.metadata || {};
    const author = Array.isArray(metadata.author)
      ? metadata.author.join(', ')
      : metadata.author;

    // 计算总节数作为页数
    this._sectionCount = book.sections?.length || 1;
    this._totalPages = this._sectionCount;

    // 解析目录
    this._toc = this._convertToc(book.toc || []);

    this._isReady = true;

    return {
      title: metadata.title,
      author,
      publisher: metadata.publisher,
      language: metadata.language,
      description: metadata.description,
      pageCount: this._totalPages,
      format: 'epub',
      coverImage: await this._getCoverImage(),
    };
  }

  /**
   * 将 EPUB 目录转换为通用格式
   */
  private _convertToc(items: EpubTocItem[], level = 0): TocItem[] {
    return items.map((item) => ({
      title: item.label || '未命名章节',
      location: item.href || '',
      level,
      children: item.subitems ? this._convertToc(item.subitems, level + 1) : undefined,
    }));
  }

  /**
   * 获取封面图片
   */
  private async _getCoverImage(): Promise<string | undefined> {
    if (!this._book) return undefined;
    try {
      const coverBlob = await this._book.getCover();
      if (coverBlob) {
        return new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => resolve(undefined);
          reader.readAsDataURL(coverBlob);
        });
      }
    } catch (e) {
      console.warn('[EpubRenderer] 获取封面失败:', e);
    }
    return undefined;
  }

  /**
   * 从文件路径提取文件名
   */
  private _extractFileName(filePath: string): string {
    const parts = filePath.replace(/\\/g, '/').split('/');
    const fileName = parts[parts.length - 1];
    return fileName.replace(/\.epub$/i, '');
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
   * 渲染 EPUB 到容器
   */
  async renderPage(
    page: number,
    container: HTMLElement,
    options?: RenderOptions
  ): Promise<void> {
    if (!this._isReady || !this._book) {
      throw new Error('Document not loaded');
    }

    this._currentContainer = container;

    // 检查是否可以复用现有视图（同一容器且 view 仍然有效）
    const canReuseView = this._view 
      && this._lastRenderContainer === container
      && container.contains(this._view);

    if (canReuseView) {
      // 复用现有视图，仅更新阅读模式和位置
      this._readingMode = options?.readingMode || 'horizontal';
      this._applyFlowSafely();
      
      // 跳转到指定位置
      const targetPage = options?.initialVirtualPage || page;
      if (targetPage !== this._currentPage && targetPage >= 1 && targetPage <= this._sectionCount) {
        await this.goToPage(targetPage);
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

    // 应用主题样式
    this._applyTheme(view, options);

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
    const initialPage = options?.initialVirtualPage || page;
    if (initialPage > 1 && initialPage <= this._sectionCount) {
      // 跳转到指定章节
      await view.init({ lastLocation: initialPage - 1 });
    } else {
      await view.init({ showTextStart: true });
    }

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
      this._applyTheme(view2, options);
      container.appendChild(view2);
      this._view = view2;
      view2.addEventListener('relocate', (e: any) => this._handleRelocate(e.detail));
      view2.addEventListener('load', () => { this._disableFoliateTouch(); this._applyFlowSafely(); });
      await view2.open(this._book);
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
    const theme = options?.theme || 'light';
    const fontSize = options?.fontSize || 16;
    const lineHeight = options?.lineHeight || 1.6;
    const fontFamily = options?.fontFamily || 'serif';

    // 根据主题计算颜色
    let bgColor = '#ffffff';
    let textColor = '#24292e';

    if (theme === 'dark') {
      bgColor = '#1a1a1a';
      textColor = '#e0e0e0';
    } else if (theme === 'sepia') {
      bgColor = '#f4ecd8';
      textColor = '#5b4636';
    }

    // 设置外层容器背景色
    view.style.backgroundColor = bgColor;

    // 监听 load 事件，在每个 section 加载时注入样式
    view.addEventListener('load', (e: any) => {
      const { doc } = e.detail;
      if (!doc) return;

      // 转发点击事件到外部容器，以便 Reader 组件处理菜单显示
      doc.addEventListener('click', (ev: MouseEvent) => {
        // 如果点击的是链接，不转发（或者根据需求决定）
        // 这里简单转发，让上层决定
        const rect = view.getBoundingClientRect();
        const newEvent = new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          view: window,
          detail: ev.detail,
          screenX: ev.screenX,
          screenY: ev.screenY,
          clientX: ev.clientX + rect.left,
          clientY: ev.clientY + rect.top,
          ctrlKey: ev.ctrlKey,
          altKey: ev.altKey,
          shiftKey: ev.shiftKey,
          metaKey: ev.metaKey,
          button: ev.button,
          buttons: ev.buttons,
        });
        view.dispatchEvent(newEvent);
      });

      // 创建样式元素注入到 iframe 文档
      const style = doc.createElement('style');
      style.textContent = `
        html, body {
          background-color: ${bgColor} !important;
          color: ${textColor} !important;
          font-size: ${fontSize}px !important;
          line-height: ${lineHeight} !important;
          font-family: ${fontFamily} !important;
          /* 确保内容可以撑开 */
          height: auto !important;
          min-height: 100% !important;
          overflow: visible !important;
          /* 隐藏滚动条 */
          scrollbar-width: none; /* Firefox */
          -ms-overflow-style: none; /* IE/Edge */
        }
        /* 章节开篇标题换行，避免长标题溢出 - 仅保留基础换行规则，避免干扰垂直排版 */
        h1, h2, h3, h4, h5, h6 {
          white-space: normal !important;
          word-break: break-word !important;
          overflow-wrap: anywhere !important;
        }
        /* 隐藏滚动条 Chrome/Safari/Webkit */
        ::-webkit-scrollbar {
          display: none;
          width: 0;
          height: 0;
        }
        * {
          color: inherit !important;
        }
        a {
          color: #58a6ff !important;
        }
        img {
          max-width: 100% !important;
          height: auto !important;
        }
      `;
      doc.head.appendChild(style);

      // 章节开篇页特殊兼容：移除视口锁定布局
      try {
        const win = doc.defaultView;
        const rootRect = doc.documentElement.getBoundingClientRect();
        const viewportH = Math.max(0, rootRect.height);
        const contentH = Math.max(doc.body.scrollHeight, doc.documentElement.scrollHeight);
        const children = Array.from(doc.body.children) as HTMLElement[];
        const hasHeading = !!doc.body.querySelector('h1, h2, h3');
        const likelyOpening = hasHeading && children.length <= 3 && contentH <= viewportH + 4;
        if (likelyOpening) {
          for (const el of children) {
            const cs = win.getComputedStyle(el);
            const hasViewportLock = /vh/.test(`${cs.height}${cs.minHeight}${cs.maxHeight}`)
              || cs.position === 'absolute' || cs.position === 'fixed'
              || cs.overflow === 'hidden'
              || cs.display === 'grid' || cs.display === 'flex';
            if (hasViewportLock) {
              // 仅解除溢出限制，保留原有布局（如 flex/grid 居中）
              el.style.setProperty('overflow', 'visible', 'important');
              el.style.setProperty('max-height', 'none', 'important');
            }
          }
        }
      } catch {}
    });
  }

  /**
   * 处理位置变化事件
   */
  private _handleRelocate(detail: any): void {
    if (typeof detail?.index === 'number') {
      this._currentPage = detail.index + 1;
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
   * 跳转到指定页面（章节）
   */
  async goToPage(page: number): Promise<void> {
    if (!this._view || page < 1 || page > this._totalPages) return;

    const sectionIndex = page - 1;
    try {
      await this._view.goTo(sectionIndex);
      this._currentPage = page;
    } catch (e) {
      console.warn('[EpubRenderer] 跳转失败:', e);
    }
  }

  /**
   * 跳转到目录项（href）
   */
  async goToHref(href: string): Promise<void> {
    if (!this._view) return;
    try {
      await this._view.goTo(href);
    } catch (e) {
      console.warn('[EpubRenderer] 跳转到 href 失败:', e);
    }
  }

  /**
   * 下一页
   */
  async nextPage(): Promise<void> {
    if (!this._view) return;
    await this._view.next();
  }

  /**
   * 上一页
   */
  async prevPage(): Promise<void> {
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
      console.warn('[EpubRenderer] 搜索失败:', e);
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
      console.warn('[EpubRenderer] 提取文本失败:', e);
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
      console.warn('[EpubRenderer] 滚动到锚点失败:', e);
    });
  }

  /**
   * 获取滚动容器
   */
  getScrollContainer(): HTMLElement | null {
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
    if (this._resizeObserver) {
      try { this._resizeObserver.disconnect(); } catch {}
      this._resizeObserver = null;
    }
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
  }

  /** 页面变更回调 */
  onPageChange?: (page: number) => void;

  /** 目录变化回调（返回当前 href） */
  onTocChange?: (href: string) => void;

  /**
   * 获取当前目录项 href
   */
  getCurrentTocHref(): string | null {
    return this._currentTocHref;
  }

  /**
   * 设置阅读模式
   * 切换模式时会保存当前位置并在切换后恢复
   */
  async setReadingMode(mode: 'horizontal' | 'vertical'): Promise<void> {
    if (this._readingMode === mode) return;
    
    // 保存当前位置信息
    const savedLocation = this._view?.lastLocation;
    const savedPage = this._currentPage;
    
    this._readingMode = mode;
    this._applyFlowSafely();
    
    // 等待布局重新计算
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve());
      });
    });
    
    // 恢复到之前的位置
    if (this._view && savedLocation) {
      try {
        await this._view.goTo(savedLocation);
      } catch {
        // 回退到页码跳转
        if (savedPage > 0) {
          await this.goToPage(savedPage);
        }
      }
    }
  }

  scrollBy(deltaY: number): void {
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
      console.warn('[EpubRenderer] 禁用触摸事件失败:', e);
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

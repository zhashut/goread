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
  loadBlob?(path: string): Promise<Blob | null>;
  loadText?(path: string): Promise<string | null>;
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
  
  // 纵向连续模式相关属性
  private _verticalContinuousMode: boolean = false;
  private _sectionContainers: Map<number, HTMLElement> = new Map();
  private _sectionObserver: IntersectionObserver | null = null;
  private _renderedSections: Set<number> = new Set();
  private _scrollContainer: HTMLElement | null = null;
  private _scrollRafId: number | null = null;
  private _dividerElements: HTMLElement[] = [];
  private _currentPageGap: number = 4;
  private _isNavigating: boolean = false;
  private _blobUrls: Set<string> = new Set();

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
      anchor: item.href || '',
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
    this._readingMode = options?.readingMode || 'horizontal';

    // 纵向模式使用连续滚动渲染
    if (this._readingMode === 'vertical') {
      return this.renderVerticalContinuous(container, options);
    }

    // 检查是否可以复用现有视图（同一容器且 view 仍然有效）
    const canReuseView = this._view 
      && this._lastRenderContainer === container
      && container.contains(this._view);

    if (canReuseView) {
      // 复用现有视图，仅更新阅读模式和位置
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
      this._currentPage = initialPage;
    } else {
      await view.init({ showTextStart: true });
      this._currentPage = 1;
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
    // 兼容不同的事件数据结构：优先使用 index，否则尝试从 section.current 获取
    let pageIndex: number | undefined;
    if (typeof detail?.index === 'number') {
      pageIndex = detail.index;
    } else if (typeof detail?.section?.current === 'number') {
      pageIndex = detail.section.current;
    }

    if (typeof pageIndex === 'number') {
      this._currentPage = pageIndex + 1;
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
    console.log('[EpubRenderer] 开始纵向连续渲染模式');
    
    // 清理之前的资源
    this._clearBlobUrls();

    // 标记为纵向连续模式
    this._verticalContinuousMode = true;
    
    // 清理旧的观察器
    if (this._sectionObserver) {
      this._sectionObserver.disconnect();
      this._sectionObserver = null;
    }
    
    // 保存滚动容器引用
    this._scrollContainer = container;
    
    // 清空容器
    container.innerHTML = '';
    container.style.cssText = `
      overflow-y: auto;
      overflow-x: hidden;
      height: 100%;
      width: 100%;
      position: relative;
    `;
    
    // 清空之前的容器映射
    this._sectionContainers.clear();
    this._renderedSections.clear();
    this._dividerElements = [];
    
    // 获取页面间隙配置，默认为 4px
    const pageGap = options?.pageGap ?? 4;
    this._currentPageGap = pageGap;
    
    // 为每个章节创建容器
    for (let i = 0; i < this._sectionCount; i++) {
      // 添加分割线（非首章节）
      if (i > 0) {
        const divider = document.createElement('div');
        divider.className = 'epub-section-divider';
        divider.style.cssText = `
          height: 1px;
          background: linear-gradient(to right, transparent, #666, transparent);
          margin: ${pageGap}px auto;
          width: 80%;
          opacity: 0.3;
        `;
        container.appendChild(divider);
        this._dividerElements.push(divider);
      }
      
      // 创建章节容器
      const wrapper = document.createElement('div');
      wrapper.className = 'epub-section-wrapper';
      wrapper.dataset.sectionIndex = String(i);
      wrapper.style.cssText = `
        min-height: 200px;
        padding: 0 16px;
        box-sizing: border-box;
      `;
      
      container.appendChild(wrapper);
      this._sectionContainers.set(i, wrapper);
    }
    
    // 设置 IntersectionObserver 进行懒加载
    this._setupSectionObserver(container, options);
    
    // 设置滚动监听，用于更新目录高亮和进度
    this._setupScrollListener(container);
    
    // 初始渲染当前章节及前后各1章
    const initialPage = options?.initialVirtualPage || 1;
    this._currentPage = initialPage;
    
    const sectionsToRender = [
      initialPage - 1,
      Math.max(0, initialPage - 2),
      Math.min(this._sectionCount - 1, initialPage),
    ].filter(i => i >= 0 && i < this._sectionCount);
    
    for (const index of sectionsToRender) {
      await this._renderSection(index, options);
    }
    
    // 滚动到当前章节
    if (initialPage > 1) {
      const targetWrapper = this._sectionContainers.get(initialPage - 1);
      if (targetWrapper) {
        // 延迟滚动，确保内容已渲染
        setTimeout(() => {
          targetWrapper.scrollIntoView({ behavior: 'auto', block: 'start' });
        }, 100);
      }
    }
    
    console.log('[EpubRenderer] 纵向连续渲染模式初始化完成');
  }
  
  /**
   * 设置章节可见性观察器，实现懒加载
   */
  private _setupSectionObserver(container: HTMLElement, options?: RenderOptions): void {
    this._sectionObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const wrapper = entry.target as HTMLElement;
            const index = parseInt(wrapper.dataset.sectionIndex || '-1', 10);
            
            if (index >= 0 && !this._renderedSections.has(index)) {
              // 渲染当前章节
              this._renderSection(index, options).catch(console.error);
              
              // 预加载相邻章节
              const prevIndex = index - 1;
              const nextIndex = index + 1;
              
              if (prevIndex >= 0 && !this._renderedSections.has(prevIndex)) {
                this._renderSection(prevIndex, options).catch(console.error);
              }
              
              if (nextIndex < this._sectionCount && !this._renderedSections.has(nextIndex)) {
                this._renderSection(nextIndex, options).catch(console.error);
              }
            }
            
            // 更新当前页码（当章节进入视口时）
            // 注意：页码更新由滚动监听器处理，这里只标记章节可见
            if (entry.intersectionRatio > 0.1) {
              // 章节可见，可以在这里做一些额外处理
            }
          }
        });
      },
      {
        root: container,
        rootMargin: '200px 0px', // 提前200px开始加载
        threshold: [0, 0.3, 0.5, 1.0],
      }
    );
    
    // 观察所有章节容器
    this._sectionContainers.forEach((wrapper) => {
      this._sectionObserver!.observe(wrapper);
    });
  }
  
  /**
   * 渲染单个章节
   */
  private async _renderSection(index: number, options?: RenderOptions): Promise<void> {
    if (this._renderedSections.has(index)) {
      return;
    }
    
    const wrapper = this._sectionContainers.get(index);
    if (!wrapper || !this._book) {
      return;
    }
    
    console.log(`[EpubRenderer] 开始渲染章节 ${index + 1}`);
    
    try {
      const section = this._book.sections[index];
      if (!section || !section.createDocument) {
        console.warn(`[EpubRenderer] 章节 ${index + 1} 无效`);
        return;
      }
      
      const doc = await section.createDocument();
      
      // 创建临时容器，在注入 Shadow DOM 之前处理资源路径
      const tempContent = document.createElement('div');
      tempContent.innerHTML = doc.body.innerHTML;
      
      // 在原始文档上下文中解析资源路径
      await this._fixResourcePaths(tempContent, section);
      
      // 使用 shadow DOM 隔离样式
      const shadow = wrapper.attachShadow({ mode: 'open' });
      
      // 注入样式
      const style = document.createElement('style');
      style.textContent = this._getThemeStyles(options);
      shadow.appendChild(style);

      // 注入原文档样式（包括外部 CSS）
      const originalStyles = await this._loadAndProcessStyles(doc, section);
      if (originalStyles) {
        const originalStyleEl = document.createElement('style');
        originalStyleEl.textContent = originalStyles;
        shadow.appendChild(originalStyleEl);
      }
      
      // 注入已处理的内容
      const content = document.createElement('div');
      content.className = 'epub-section-content';
      content.innerHTML = tempContent.innerHTML;
      shadow.appendChild(content);
      
      // 处理链接点击事件
      this._setupLinkHandlers(content, index);
      
      // 标记已渲染
      this._renderedSections.add(index);
      wrapper.dataset.rendered = 'true';
      
      console.log(`[EpubRenderer] 章节 ${index + 1} 渲染完成`);
    } catch (e) {
      console.error(`[EpubRenderer] 渲染章节 ${index + 1} 失败:`, e);
    }
  }
  
  /**
   * 设置滚动监听器，用于更新目录高亮和进度
   */
  private _setupScrollListener(container: HTMLElement): void {
    const handleScroll = () => {
      if (this._scrollRafId !== null) return;
      
      this._scrollRafId = requestAnimationFrame(() => {
        this._scrollRafId = null;
        this._updateScrollProgress();
      });
    };
    
    container.addEventListener('scroll', handleScroll, { passive: true });
  }
  
  /**
   * 更新滚动进度和目录高亮
   */
  private _updateScrollProgress(): void {
    if (!this._scrollContainer || !this._verticalContinuousMode) return;
    
    // 跳转期间不更新页码，避免冲突
    if (this._isNavigating) return;
    
    const container = this._scrollContainer;
    const scrollTop = container.scrollTop;
    const viewportHeight = container.clientHeight;
    const centerY = scrollTop + viewportHeight / 2;
    
    // 查找视口中心所在的章节
    let currentSectionIndex = -1;
    
    this._sectionContainers.forEach((wrapper, index) => {
      const rect = wrapper.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const relativeTop = rect.top - containerRect.top + scrollTop;
      const relativeBottom = relativeTop + rect.height;
      
      // 检查视口中心是否在这个章节内
      if (centerY >= relativeTop && centerY < relativeBottom) {
        currentSectionIndex = index;
      }
    });
    
    if (currentSectionIndex >= 0) {
      const newPage = currentSectionIndex + 1;
      
      // 更新当前页码
      if (newPage !== this._currentPage) {
        this._currentPage = newPage;
        if (this.onPageChange) {
          this.onPageChange(newPage);
        }
      }
      
      // 更新目录高亮（通过 href）
      if (this.onTocChange && this._book) {
        const section = this._book.sections[currentSectionIndex];
        if (section && section.id) {
          // 使用章节的 href 作为目录定位
          this.onTocChange(section.id);
        }
      }
    }
  }
  
  /**
   * 清理生成的 Blob URL
   */
  private _clearBlobUrls(): void {
    this._blobUrls.forEach(url => URL.revokeObjectURL(url));
    this._blobUrls.clear();
  }

  /**
   * 解析并加载资源
   */
  private async _resolveAndLoad(url: string, section: any): Promise<string | null> {
    if (!url || !this._book) return null;

    // 跳过绝对路径和 data URL
    if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:') || url.startsWith('blob:')) {
      return url;
    }

    try {
      // 1. 解析路径
      let path = url;
      if (section && typeof section.resolveHref === 'function') {
        // section.resolveHref 返回的是 EPUB 内部的绝对路径字符串
        path = section.resolveHref(url);
      } else if (section && typeof section.resolve === 'function') {
        // 兼容旧版或不同的接口
        const resolved = section.resolve(url);
        if (typeof resolved === 'string') {
          path = resolved;
        }
      }

      if (!path) return null;

      // 2. 加载资源为 Blob
      // loadBlob 是 EPUB 实例的方法（来自 Loader）
      if (this._book.loadBlob) {
        const blob = await this._book.loadBlob(path);
        if (blob) {
          const blobUrl = URL.createObjectURL(blob);
          this._blobUrls.add(blobUrl);
          return blobUrl;
        }
      }
    } catch (e) {
      console.warn(`[EpubRenderer] 加载资源失败: ${url}`, e);
    }
    
    return null;
  }

  /**
   * 加载并处理样式（包括外部 CSS 和内联样式）
   */
  private async _loadAndProcessStyles(doc: Document, section: any): Promise<string> {
    let cssText = '';
    const sectionHref = section?.id || '';
    
    // 1. 处理外部 CSS 文件 <link rel="stylesheet">
    const links = Array.from(doc.querySelectorAll('link[rel="stylesheet"]'));
    for (const link of links) {
      const href = link.getAttribute('href');
      if (!href) continue;

      try {
        // 解析 CSS 文件的绝对路径
        let cssPath = href;
        if (section && typeof section.resolveHref === 'function') {
          cssPath = section.resolveHref(href);
        }

        if (this._book && this._book.loadText && cssPath) {
          const cssContent = await this._book.loadText(cssPath);
          if (cssContent) {
            // 处理 CSS 文件中的相对路径（相对于 CSS 文件本身）
            const processedCss = await this._processCssUrls(cssContent, cssPath);
            cssText += `/* ${href} */\n${processedCss}\n`;
          }
        }
      } catch (e) {
        console.warn(`[EpubRenderer] 加载外部 CSS 失败: ${href}`, e);
      }
    }

    // 2. 处理内联样式 <style>
    const styles = Array.from(doc.querySelectorAll('style'));
    for (const style of styles) {
      const content = style.textContent || '';
      if (content) {
        // 内联样式的相对路径是相对于当前章节文件的
        const processedCss = await this._processCssUrls(content, sectionHref);
        cssText += `/* Inline Style */\n${processedCss}\n`;
      }
    }

    return cssText;
  }

  /**
   * 处理 CSS 中的 URL 路径
   */
  private async _processCssUrls(css: string, basePath: string): Promise<string> {
    const urlRegex = /url\(['"]?([^'"()]+)['"]?\)/g;
    let match;
    let newCss = css;
    const replacements: { old: string, new: string }[] = [];

    // 计算基准目录
    const baseDir = basePath.includes('/') ? basePath.substring(0, basePath.lastIndexOf('/') + 1) : '';

    while ((match = urlRegex.exec(css)) !== null) {
      const url = match[1];
      if (url.startsWith('data:') || url.startsWith('http')) continue;

      try {
        // 解析绝对路径
        // 简单处理：拼接 baseDir + url，然后处理 ../
        // 这里使用 URL API 来处理路径解析
        const dummyBase = 'http://dummy/';
        const absoluteUrlObj = new URL(url, dummyBase + baseDir);
        const absolutePath = absoluteUrlObj.pathname.substring(1); // 去掉开头的 /

        // 加载资源
        const blobUrl = await this._resolveAndLoad(absolutePath, null);
        if (blobUrl) {
          replacements.push({ old: url, new: blobUrl });
        }
      } catch (e) {
        // console.warn(`[EpubRenderer] 解析 CSS URL 失败: ${url}`, e);
      }
    }

    // 替换 URL
    // 注意：倒序替换或者使用 replaceAll (split/join)
    // 为避免替换错误（如部分匹配），使用 split/join 比较安全，但要注意转义
    if (replacements.length > 0) {
        replacements.forEach(({ old, new: newUrl }) => {
            newCss = newCss.split(old).join(newUrl);
        });
    }

    return newCss;
  }

  /**
   * 修复资源路径（图片、字体等）
   */
  private async _fixResourcePaths(content: HTMLElement, section: any): Promise<void> {
    // 处理图片路径
    const images = content.querySelectorAll('img[src]');
    const imgPromises = Array.from(images).map(async (img) => {
      const src = img.getAttribute('src');
      if (!src) return;
      
      const resolvedUrl = await this._resolveAndLoad(src, section);
      if (resolvedUrl && resolvedUrl !== src) {
        img.setAttribute('src', resolvedUrl);
        // console.log(`[EpubRenderer] 图片路径解析成功: ${src} -> ${resolvedUrl.substring(0, 50)}...`);
      }
    });
    
    // 处理 CSS 背景图片
    const elementsWithStyle = content.querySelectorAll('[style*="background"]');
    const stylePromises = Array.from(elementsWithStyle).map(async (el) => {
      const style = el.getAttribute('style');
      if (!style) return;
      
      // 匹配 url(...) 中的路径
      const urlRegex = /url\(['"]?([^'"()]+)['"]?\)/g;
      let match;
      let newStyle = style;
      const replacements: { old: string, new: string }[] = [];
      
      // 收集所有需要替换的 URL
      // 注意：exec 是有状态的，需要循环调用
      while ((match = urlRegex.exec(style)) !== null) {
        const url = match[1];
        // 避免重复处理
        if (url.startsWith('blob:') || url.startsWith('data:') || url.startsWith('http')) continue;

        const resolvedUrl = await this._resolveAndLoad(url, section);
        if (resolvedUrl && resolvedUrl !== url) {
            replacements.push({ old: url, new: resolvedUrl });
        }
      }
      
      if (replacements.length > 0) {
        replacements.forEach(({ old, new: newUrl }) => {
            // 使用 split/join 替换所有出现的该 URL
            newStyle = newStyle.split(old).join(newUrl);
        });
        el.setAttribute('style', newStyle);
      }
    });

    // 处理 SVG <image> 标签
    const svgImages = content.querySelectorAll('image');
    const svgPromises = Array.from(svgImages).map(async (img) => {
      // 尝试获取 href 或 xlink:href
      const href = img.getAttribute('href') || img.getAttribute('xlink:href');
      if (!href) return;
      
      const resolvedUrl = await this._resolveAndLoad(href, section);
      if (resolvedUrl && resolvedUrl !== href) {
        // 同时设置 href 和 xlink:href 以确保兼容性
        img.setAttribute('href', resolvedUrl);
        if (img.hasAttribute('xlink:href')) {
            img.setAttribute('xlink:href', resolvedUrl);
        }
      }
    });

    await Promise.all([...imgPromises, ...stylePromises, ...svgPromises]);
  }
  
  /**
   * 设置链接点击处理
   */
  private _setupLinkHandlers(content: HTMLElement, sectionIndex: number): void {
    const links = content.querySelectorAll('a[href]');
    
    links.forEach((link) => {
      const href = link.getAttribute('href');
      if (!href) return;
      
      link.addEventListener('click', (e) => {
        e.preventDefault();
        
        // 处理锚点链接（#开头）
        if (href.startsWith('#')) {
          const anchor = href.substring(1);
          this._scrollToAnchor(anchor, sectionIndex);
          return;
        }
        
        // 处理相对路径链接（跨章节）
        if (!href.startsWith('http://') && !href.startsWith('https://')) {
          this._navigateToHref(href);
          return;
        }
        
        // 外部链接：在浏览器中打开
        window.open(href, '_blank');
      });
    });
  }
  
  /**
   * 滚动到锚点
   */
  private _scrollToAnchor(anchor: string, currentSectionIndex: number): void {
    if (!this._scrollContainer) return;
    
    // 在当前章节中查找锚点
    const wrapper = this._sectionContainers.get(currentSectionIndex);
    if (!wrapper || !wrapper.shadowRoot) return;
    
    const target = wrapper.shadowRoot.getElementById(anchor) || 
                   wrapper.shadowRoot.querySelector(`[name="${anchor}"]`);
    
    if (target) {
      // 计算目标元素相对于滚动容器的位置
      const containerRect = this._scrollContainer.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      
      const scrollTop = this._scrollContainer.scrollTop;
      const targetTop = targetRect.top - containerRect.top + scrollTop;
      
      this._scrollContainer.scrollTo({
        top: targetTop,
        behavior: 'smooth',
      });
    }
  }
  
  /**
   * 导航到指定 href（跨章节）
   */
  private _navigateToHref(href: string): void {
    // 解析 href，找到对应的章节
    const [path, anchor] = href.split('#');
    
    // 查找匹配的章节
    if (this._book) {
      const sectionIndex = this._book.sections.findIndex((section: any) => {
        return section.id === path || section.id.endsWith(path);
      });
      
      if (sectionIndex >= 0) {
        // 跳转到目标章节
        this.goToPage(sectionIndex + 1).then(() => {
          // 如果有锚点，滚动到锚点
          if (anchor) {
            setTimeout(() => {
              this._scrollToAnchor(anchor, sectionIndex);
            }, 300);
          }
        });
      }
    }
  }
  
  /**
   * 获取主题样式
   */
  private _getThemeStyles(options?: RenderOptions): string {
    const theme = options?.theme || 'light';
    const fontSize = options?.fontSize || 16;
    const lineHeight = options?.lineHeight || 1.6;
    const fontFamily = options?.fontFamily || 'serif';
    
    let bgColor = '#ffffff';
    let textColor = '#24292e';
    
    if (theme === 'dark') {
      bgColor = '#1a1a1a';
      textColor = '#e0e0e0';
    } else if (theme === 'sepia') {
      bgColor = '#f4ecd8';
      textColor = '#5b4636';
    }
    
    return `
      :host {
        display: block;
        background-color: ${bgColor};
        color: ${textColor};
      }
      
      .epub-section-content {
        background-color: ${bgColor};
        color: ${textColor};
        font-size: ${fontSize}px;
        line-height: ${lineHeight};
        font-family: ${fontFamily};
        padding: 16px;
        max-width: 800px;
        margin: 0 auto;
      }
      
      .epub-section-content * {
        color: inherit;
      }
      
      .epub-section-content h1,
      .epub-section-content h2,
      .epub-section-content h3,
      .epub-section-content h4,
      .epub-section-content h5,
      .epub-section-content h6 {
        white-space: normal;
        word-break: break-word;
        overflow-wrap: anywhere;
        margin-top: 1.5em;
        margin-bottom: 0.5em;
      }
      
      .epub-section-content p {
        margin: 0.8em 0;
        text-indent: 2em;
      }
      
      .epub-section-content a {
        color: #58a6ff;
        text-decoration: none;
      }
      
      .epub-section-content a:hover {
        text-decoration: underline;
      }
      
      .epub-section-content img {
        max-width: 100%;
        height: auto;
      }
      
      .epub-section-content a {
        cursor: pointer;
      }
      
      .epub-section-content pre {
        background-color: rgba(128, 128, 128, 0.1);
        padding: 1em;
        overflow-x: auto;
        border-radius: 4px;
      }
      
      .epub-section-content code {
        font-family: 'Courier New', monospace;
        background-color: rgba(128, 128, 128, 0.1);
        padding: 0.2em 0.4em;
        border-radius: 3px;
      }
      
      .epub-section-content blockquote {
        border-left: 4px solid #666;
        padding-left: 1em;
        margin-left: 0;
        font-style: italic;
        opacity: 0.8;
      }
    `;
  }

  /**
   * 跳转到指定页面（章节）
   */
  async goToPage(page: number): Promise<void> {
    // 纵向连续模式下的跳转
    if (this._verticalContinuousMode) {
      if (page < 1 || page > this._totalPages) return;
      
      const targetWrapper = this._sectionContainers.get(page - 1);
      if (targetWrapper) {
        // 标记正在跳转，避免滚动监听器干扰
        this._isNavigating = true;
        
        targetWrapper.scrollIntoView({ behavior: 'smooth', block: 'start' });
        this._currentPage = page;
        
        // 延迟触发回调，等待滚动完成
        setTimeout(() => {
          this._isNavigating = false;
          if (this.onPageChange) {
            this.onPageChange(page);
          }
        }, 500);
      }
      return;
    }
    
    // 横向模式：使用 foliate-view 的 goTo
    if (!this._view || page < 1 || page > this._totalPages) return;

    // 标记正在跳转
    this._isNavigating = true;
    
    const sectionIndex = page - 1;
    try {
      await this._view.goTo(sectionIndex);
      this._currentPage = page;
      
      // 延迟触发回调，确保跳转完成
      setTimeout(() => {
        this._isNavigating = false;
        if (this.onPageChange) {
          this.onPageChange(page);
        }
      }, 300);
    } catch (e) {
      this._isNavigating = false;
      console.warn('[EpubRenderer] 跳转失败:', e);
    }
  }

  /**
   * 跳转到目录项（href）
   */
  async goToHref(href: string): Promise<void> {
    // 纵向连续模式下，根据 href 找到对应章节并跳转
    if (this._verticalContinuousMode) {
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
        console.warn(`[EpubRenderer] 未找到匹配的章节: ${href}`);
      }
      return;
    }
    
    // 横向模式：使用 foliate-view 的 goTo
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
    if (this._verticalContinuousMode) {
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
    if (this._verticalContinuousMode) {
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
    // 纵向连续模式下，容器本身就是滚动容器
    if (this._verticalContinuousMode) {
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
    
    // 清理纵向连续模式的观察器和监听器
    if (this._sectionObserver) {
      try { this._sectionObserver.disconnect(); } catch {}
      this._sectionObserver = null;
    }
    
    if (this._scrollRafId !== null) {
      try { cancelAnimationFrame(this._scrollRafId); } catch {}
      this._scrollRafId = null;
    }
    
    this._scrollContainer = null;
    
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
    this._verticalContinuousMode = false;
    this._sectionContainers.clear();
    this._renderedSections.clear();
    this._dividerElements = [];
    this._currentPageGap = 4;
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
   * 更新页面间隙（仅在纵向连续模式下生效）
   */
  updatePageGap(pageGap: number): void {
    if (!this._verticalContinuousMode) return;
    
    if (pageGap === this._currentPageGap) return;
    
    this._currentPageGap = pageGap;
    
    // 更新所有分割线的间距
    this._dividerElements.forEach((divider) => {
      divider.style.margin = `${pageGap}px auto`;
    });
  }

  /**
   * 设置阅读模式
   * 切换模式时会保存当前位置并在切换后恢复
   */
  async setReadingMode(mode: 'horizontal' | 'vertical'): Promise<void> {
    if (this._readingMode === mode) return;
    
    // 保存当前位置信息
    const savedPage = this._currentPage;
    
    // 如果从纵向连续模式切换到其他模式，需要重新渲染
    if (this._verticalContinuousMode && mode === 'horizontal') {
      this._readingMode = mode;
      this._verticalContinuousMode = false;
      
      // 需要重新调用 renderPage 以使用 foliate-view
      if (this._currentContainer) {
        await this.renderPage(savedPage, this._currentContainer, {
          initialVirtualPage: savedPage,
          readingMode: mode,
        });
      }
      return;
    }
    
    // 如果从横向模式切换到纵向模式，需要重新渲染
    if (!this._verticalContinuousMode && mode === 'vertical') {
      this._readingMode = mode;
      
      // 需要重新调用 renderPage 以使用纵向连续模式
      if (this._currentContainer) {
        await this.renderPage(savedPage, this._currentContainer, {
          initialVirtualPage: savedPage,
          readingMode: mode,
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
    if (this._verticalContinuousMode && this._currentContainer) {
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

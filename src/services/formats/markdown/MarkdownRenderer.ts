/**
 * Markdown 渲染器
 * 使用 md-editor-rt 渲染 Markdown 内容
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
import { logError } from '../../index';

/** 获取 Tauri invoke 函数 */
async function getInvoke() {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke;
}

/** 后端目录项格式（使用 serde untagged，location 直接是 string 或 number） */
interface BackendTocItem {
  title: string;
  location: string | number;
  level: number;
  children: BackendTocItem[];
}

/** 后端加载结果 */
interface MarkdownLoadResult {
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

/** 后端搜索结果 */
interface BackendSearchResult {
  line_number: number;
  text: string;
  context: string;
}

/**
 * Markdown 渲染器实现
 * 优先使用 md-editor-rt 渲染，如果不可用则降级为简单 HTML
 */
export class MarkdownRenderer implements IBookRenderer {
  readonly format: BookFormat = 'markdown';
  
  /** Markdown 支持 DOM 渲染，不支持位图和分页 */
  readonly capabilities: RendererCapabilities = {
    supportsBitmap: false,
    supportsDomRender: true,
    supportsPagination: false, // 单页滚动
    supportsSearch: true,
  };
  
  private _isReady = false;
  private _filePath = '';
  private _content = '';
  private _title = '';
  private _encoding = '';
  private _toc: TocItem[] = [];
  private _currentContainer: HTMLElement | null = null;
  private _reactRoot: any = null;
  private _previewId = `md-preview-${Date.now()}`;
  private _editorId = `md-editor-${Date.now()}`;
  
  /** 位置恢复完成回调 */
  onPositionRestored?: () => void;

  get isReady(): boolean {
    return this._isReady;
  }

  /**
   * 加载 Markdown 文档
   */
  async loadDocument(filePath: string): Promise<BookInfo> {
    const invoke = await getInvoke();
    
    this._filePath = filePath;
    
    const result = await invoke<MarkdownLoadResult>('markdown_load_document', { filePath });
    
    this._content = result.content;
    this._title = result.title || this._extractFileName(filePath);
    this._encoding = result.encoding;
    this._toc = this._convertToc(result.toc);
    this._isReady = true;
    
    return {
      title: this._title,
      author: undefined,
      publisher: undefined,
      language: undefined,
      description: undefined,
      pageCount: 1, // Markdown 视为单页滚动
      format: 'markdown',
      coverImage: undefined,
    };
  }

  /**
   * 将后端目录格式转换为前端格式
   */
  private _convertToc(items: BackendTocItem[]): TocItem[] {
    const flat = (items || []).map((item) => ({
      title: item.title,
      location: item.location,
      level: item.level,
    }));
    return this._buildTocHierarchy(flat);
  }

  private _buildTocHierarchy(
    flat: Array<{ title: string; location: string | number; level: number }>
  ): TocItem[] {
    const root: TocItem[] = [];
    const stack: Array<TocItem & { children: TocItem[] }> = [];
    for (const it of flat) {
      const node: TocItem & { children: TocItem[] } = {
        title: it.title,
        location: it.location,
        level: it.level,
        children: [],
      };
      while (stack.length && stack[stack.length - 1].level >= node.level) {
        stack.pop();
      }
      if (stack.length === 0) {
        root.push(node);
      } else {
        stack[stack.length - 1].children.push(node);
      }
      stack.push(node);
    }
    return root;
  }

  /**
   * 从路径提取文件名
   */
  private _extractFileName(filePath: string): string {
    const parts = filePath.replace(/\\/g, '/').split('/');
    const fileName = parts[parts.length - 1];
    return fileName.replace(/\.(md|markdown)$/i, '');
  }

  /**
   * 获取目录
   */
  async getToc(): Promise<TocItem[]> {
    return this._toc;
  }

  /**
   * 获取总页数（Markdown 始终为 1）
   */
  getPageCount(): number {
    return 1;
  }

  /**
   * 获取当前页（Markdown 始终为 1）
   */
  getCurrentPage(): number {
    return 1;
  }

  /**
   * 跳转页码（Markdown 为单页，无操作）
   */
  async goToPage(_page: number): Promise<void> {
    // Markdown 是单页应用，无需分页逻辑
  }

  /**
   * 渲染 Markdown 到容器
   * 优先使用 md-editor-rt，否则降级为简单 HTML
   */
  async renderPage(
    _page: number,
    container: HTMLElement,
    options?: RenderOptions
  ): Promise<void> {
    if (!this._isReady) {
      throw new Error('Document not loaded');
    }

    this._currentContainer = container;
    
    // 清空容器
    container.innerHTML = '';
    
    // 尝试使用 md-editor-rt，失败则降级
    try {
      await this._renderWithMdEditor(container, options);
    } catch (e) {
      await logError('[MarkdownRenderer] md-editor-rt not available, using fallback', { error: String(e) });
      this._renderFallback(container, options);
    }
  }

  /**
   * 使用 md-editor-rt 渲染
   */
  private async _renderWithMdEditor(
    container: HTMLElement,
    options?: RenderOptions
  ): Promise<void> {
    // 创建 React 根元素
    const root = document.createElement('div');
    root.id = this._previewId;
    root.style.cssText = `
      width: 100%;
      height: 100%;
      position: relative;
      overflow-y: auto;
      scrollbar-width: none;
      -ms-overflow-style: none;
    `;
    // 隐藏 WebKit 浏览器滚动条
    const style = document.createElement('style');
    style.textContent = `#${this._previewId}::-webkit-scrollbar { display: none; }`;
    root.appendChild(style);
    container.appendChild(root);

    // 动态导入 md-editor-rt 和 React
    const [{ MdPreview, MdCatalog }, React, ReactDOM] = await Promise.all([
      // @ts-ignore:
      import('md-editor-rt'),
      import('react'),
      import('react-dom/client'),
    ]);

    // 导入样式
    await import('md-editor-rt/lib/preview.css');

    // 使用 GitHub 主题，白色背景，黑色字体
    const previewTheme = 'github';
    const codeTheme = 'github';

    // 创建 React root 并渲染
    const reactRoot = ReactDOM.createRoot(root);
    this._reactRoot = reactRoot;

    // 计算字体大小
    const fontSize = options?.fontSize || 16;

    // 组合渲染 MdPreview 与 MdCatalog（目录用于提取标题和滚动高亮）
    const Wrapper = () => {
      const [_, forceUpdate] = (React as any).useState(0);
      (React as any).useEffect(() => {
        forceUpdate((x: number) => x + 1);
      }, []);
      return (
        (React as any).createElement(React.Fragment, null,
          (React as any).createElement(MdPreview as any, {
            editorId: this._editorId,
            modelValue: this._content,
            previewTheme,
            codeTheme,
            theme: 'light',
            style: {
              backgroundColor: '#ffffff',
              color: '#24292e',
              fontSize: `${fontSize}px`,
              lineHeight: options?.lineHeight || 1.6,
              fontFamily: options?.fontFamily || 'inherit',
              padding: '16px',
            },
          }),
          (React as any).createElement(MdCatalog as any, {
            editorId: this._editorId,
            scrollElement: root,
            style: { display: 'none' },
            onGetCatalog: (list: any[]) => {
              try {
                const flat = (list || []).map((item: any) => ({
                  title: String(item?.text || ''),
                  location: `heading-${Number(item?.index ?? 0)}`,
                  level: Number(item?.level ?? 0),
                }));
                this._toc = this._buildTocHierarchy(flat);
              } catch {}
            },
          })
        )
      );
    };

    reactRoot.render((React as any).createElement(Wrapper));

    const initialPage = options?.initialVirtualPage;
    if (typeof initialPage === 'number' && initialPage > 1) {
      let attempts = 0;
      const maxAttempts = 50;
      const tryRestore = () => {
        const scrollContainer = this.getScrollContainer();
        if (scrollContainer) {
          const vh = scrollContainer.clientHeight;
          const sh = scrollContainer.scrollHeight;
          const target = (initialPage - 1) * vh;
          if (vh > 0 && sh >= target) {
            scrollContainer.scrollTo({ top: target, behavior: 'auto' });
            // 位置恢复成功，通知调用方
            this.onPositionRestored?.();
            return;
          }
        }
        attempts++;
        if (attempts < maxAttempts) {
          setTimeout(tryRestore, 100);
        } else {
          // 达到最大尝试次数，也触发回调避免阻塞
          this.onPositionRestored?.();
        }
      };
      setTimeout(tryRestore, 150);
    } else {
      // 不需要恢复位置（初始页为1），延迟一帧后通知
      requestAnimationFrame(() => {
        this.onPositionRestored?.();
      });
    }
  }

  /**
   * 使用简单 HTML 的降级渲染
   */
  private _renderFallback(container: HTMLElement, options?: RenderOptions): void {
    const wrapper = document.createElement('div');
    const wrapperId = `md-fallback-${Date.now()}`;
    wrapper.id = wrapperId;
    // 默认使用白色背景、黑色字体（GitHub 风格），隐藏滚动条
    wrapper.style.cssText = `
      width: 100%;
      height: 100%;
      overflow-y: auto;
      padding: 16px;
      box-sizing: border-box;
      font-size: ${options?.fontSize || 16}px;
      line-height: ${options?.lineHeight || 1.6};
      font-family: ${options?.fontFamily || '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif'};
      background-color: #ffffff;
      color: #24292e;
      scrollbar-width: none;
      -ms-overflow-style: none;
    `;
    // 隐藏 WebKit 浏览器滚动条
    const style = document.createElement('style');
    style.textContent = `#${wrapperId}::-webkit-scrollbar { display: none; }`;
    wrapper.appendChild(style);

    // 简单的 Markdown 转 HTML
    const html = this._simpleMarkdownToHtml(this._content);
    wrapper.innerHTML = html;

    container.appendChild(wrapper);
  }

  /**
   * 简单的 Markdown 转 HTML 转换器（降级方案）
   */
  private _simpleMarkdownToHtml(markdown: string): string {
    let html = this._escapeHtml(markdown);

    // 标题
    html = html.replace(/^###### (.+)$/gm, '<h6>$1</h6>');
    html = html.replace(/^##### (.+)$/gm, '<h5>$1</h5>');
    html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

    // 加粗和斜体
    html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // 代码块
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="language-$1">$2</code></pre>');
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // 链接
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');

    // 列表
    html = html.replace(/^\- (.+)$/gm, '<li>$1</li>');
    html = html.replace(/^\* (.+)$/gm, '<li>$1</li>');
    html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

    // 段落
    html = html.replace(/\n\n/g, '</p><p>');
    html = '<p>' + html + '</p>';

    // 分割线
    html = html.replace(/^---$/gm, '<hr>');
    html = html.replace(/^\*\*\*$/gm, '<hr>');

    return html;
  }

  /**
   * 转义 HTML 特殊字符
   */
  private _escapeHtml(text: string): string {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;',
    };
    return text.replace(/[&<>"']/g, (m) => map[m]);
  }

  /**
   * 在 Markdown 内容中搜索文本
   */
  async searchText(
    query: string,
    options?: { caseSensitive?: boolean }
  ): Promise<SearchResult[]> {
    const invoke = await getInvoke();
    
    const results = await invoke<BackendSearchResult[]>('markdown_search_text', {
      filePath: this._filePath,
      query,
      caseSensitive: options?.caseSensitive || false,
    });

    return results.map((r) => ({
      page: 1,
      text: r.text,
      context: r.context,
      position: undefined,
    }));
  }

  /**
   * 提取页面文本（Markdown 返回完整内容）
   */
  async extractText(_page: number): Promise<string> {
    return this._content;
  }

  /**
   * 获取页面内容
   */
  async getPageContent(_page: number, _options?: RenderOptions): Promise<PageContent> {
    return {
      type: 'text',
      content: this._content,
      encoding: this._encoding,
    };
  }

  /**
   * 滚动到渲染内容中的锚点/标题
   */
  scrollToAnchor(anchor: string): void {
    // 获取实际的滚动容器（md-editor-rt 内部 preview 元素）
    const scrollContainer = this.getScrollContainer();
    if (!scrollContainer) return;

    // 在滚动容器内查找标题元素
    const headings = scrollContainer.querySelectorAll('h1, h2, h3, h4, h5, h6');
    const index = parseInt(anchor.replace('heading-', ''), 10);
    
    if (!isNaN(index) && headings[index]) {
      const heading = headings[index] as HTMLElement;
      // 使用 offsetTop 计算位置，并预留顶部空间（TopBar 高度约 60px + 20px 间距）
      const top = heading.offsetTop - 80;
      scrollContainer.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    }
  }

  /**
   * 获取滚动容器元素
   * 内部查找实际可滚动的子元素
   */
  getScrollContainer(): HTMLElement | null {
    if (!this._currentContainer) return null;
    // md-editor-rt 渲染后，实际内容在 id 为 _previewId 的元素中
    const preview = this._currentContainer.querySelector(`#${this._previewId}`) as HTMLElement;
    return preview || this._currentContainer;
  }

  /**
   * 根据容器计算虚拟页数
   * @param viewportHeight 视口高度
   */
  calculateVirtualPages(viewportHeight: number): number {
    const scrollContainer = this.getScrollContainer();
    if (!scrollContainer) return 1;
    const contentHeight = scrollContainer.scrollHeight;
    return Math.max(1, Math.ceil(contentHeight / viewportHeight));
  }

  /**
   * 获取当前虚拟页码
   * @param scrollTop 当前滚动位置
   * @param viewportHeight 视口高度
   */
  getCurrentVirtualPage(scrollTop: number, viewportHeight: number): number {
    const scrollContainer = this.getScrollContainer();
    if (!scrollContainer) return 1;
    const contentHeight = scrollContainer.scrollHeight;
    const totalPages = Math.max(1, Math.ceil(contentHeight / viewportHeight));
    const currentPage = Math.min(totalPages, Math.floor(scrollTop / viewportHeight) + 1);
    return currentPage;
  }

  /**
   * 滚动到指定虚拟页
   * @param page 虚拟页码
   * @param viewportHeight 视口高度
   */
  scrollToVirtualPage(page: number, viewportHeight: number): void {
    const scrollContainer = this.getScrollContainer();
    if (!scrollContainer) return;
    const targetScroll = (page - 1) * viewportHeight;
    scrollContainer.scrollTo({ top: targetScroll, behavior: 'auto' });
  }

  /**
   * 获取 Markdown 内容
   */
  getContent(): string {
    return this._content;
  }

  /**
   * 获取编码
   */
  getEncoding(): string {
    return this._encoding;
  }

  /**
   * 关闭并释放资源
   */
  async close(): Promise<void> {
    // 如果存在 React root 则卸载
    if (this._reactRoot) {
      try {
        this._reactRoot.unmount();
      } catch (e) {
        // 忽略卸载错误
      }
      this._reactRoot = null;
    }

    this._isReady = false;
    this._filePath = '';
    this._content = '';
    this._title = '';
    this._encoding = '';
    this._toc = [];
    this._currentContainer = null;
  }

  /** 页面变更回调 */
  onPageChange?: (page: number) => void;
}

// 注册 Markdown 渲染器
registerRenderer({
  format: 'markdown',
  extensions: ['.md', '.markdown'],
  factory: () => new MarkdownRenderer(),
  displayName: 'Markdown',
});

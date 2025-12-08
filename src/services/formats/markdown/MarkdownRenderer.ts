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
} from '../types';
import { registerRenderer } from '../registry';

/** 获取 Tauri invoke 函数 */
async function getInvoke() {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke;
}

/** 后端目录项格式 */
interface BackendTocItem {
  title: string;
  location: { Href: string } | { Page: number };
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
  
  private _isReady = false;
  private _filePath = '';
  private _content = '';
  private _title = '';
  private _encoding = '';
  private _toc: TocItem[] = [];
  private _currentContainer: HTMLElement | null = null;
  private _reactRoot: any = null;
  private _previewId = `md-preview-${Date.now()}`;

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
    return items.map((item) => ({
      title: item.title,
      location: 'Href' in item.location ? item.location.Href : item.location.Page,
      level: item.level,
      children: item.children ? this._convertToc(item.children) : [],
    }));
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
      console.warn('[MarkdownRenderer] md-editor-rt not available, using fallback:', e);
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
    root.style.cssText = 'width: 100%; height: 100%; overflow-y: auto;';
    container.appendChild(root);

    // 动态导入 md-editor-rt 和 React
    const [{ MdPreview }, React, ReactDOM] = await Promise.all([
      // @ts-ignore:
      import('md-editor-rt'),
      import('react'),
      import('react-dom/client'),
    ]);

    // 导入样式
    await import('md-editor-rt/lib/preview.css');

    // 确定主题
    const theme = options?.theme || 'light';
    const previewTheme = theme === 'dark' ? 'github' : 'default';
    const codeTheme = theme === 'dark' ? 'atom' : 'github';

    // 创建 React root 并渲染
    const reactRoot = ReactDOM.createRoot(root);
    this._reactRoot = reactRoot;

    // 计算字体大小
    const fontSize = options?.fontSize || 16;

    reactRoot.render(
      React.createElement(MdPreview, {
        modelValue: this._content,
        previewTheme,
        codeTheme,
        style: {
          backgroundColor: 'transparent',
          fontSize: `${fontSize}px`,
          lineHeight: options?.lineHeight || 1.6,
          fontFamily: options?.fontFamily || 'inherit',
          padding: '16px',
        },
      })
    );
  }

  /**
   * 使用简单 HTML 的降级渲染
   */
  private _renderFallback(container: HTMLElement, options?: RenderOptions): void {
    const wrapper = document.createElement('div');
    wrapper.style.cssText = `
      width: 100%;
      height: 100%;
      overflow-y: auto;
      padding: 16px;
      box-sizing: border-box;
      font-size: ${options?.fontSize || 16}px;
      line-height: ${options?.lineHeight || 1.6};
      font-family: ${options?.fontFamily || 'inherit'};
    `;

    // 应用主题
    if (options?.theme === 'dark') {
      wrapper.style.backgroundColor = '#1a1a1a';
      wrapper.style.color = '#e0e0e0';
    } else if (options?.theme === 'sepia') {
      wrapper.style.backgroundColor = '#f4ecd8';
      wrapper.style.color = '#5b4636';
    } else {
      wrapper.style.backgroundColor = '#ffffff';
      wrapper.style.color = '#333333';
    }

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
    if (!this._currentContainer) return;

    const headings = this._currentContainer.querySelectorAll('h1, h2, h3, h4, h5, h6');
    const index = parseInt(anchor.replace('heading-', ''), 10);
    
    if (!isNaN(index) && headings[index]) {
      headings[index].scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
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
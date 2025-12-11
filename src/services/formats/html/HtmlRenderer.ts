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
    supportsPagination: false, // Single page scroll
    supportsSearch: true,
  };

  private _isReady = false;
  private _content = '';
  private _title = '';
  private _toc: TocItem[] = [];
  private _currentContainer: HTMLElement | null = null;

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

    // Parse TOC
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

    // Clear container
    container.innerHTML = '';
    
    // Create host for Shadow DOM
    const host = document.createElement('div');
    host.className = 'html-renderer-host';
    host.style.width = '100%';
    host.style.height = '100%';
    host.style.display = 'block';
    container.appendChild(host);

    // Attach Shadow DOM to isolate styles
    const shadow = host.attachShadow({ mode: 'open' });

    // Parse the HTML content
    const parser = new DOMParser();
    const doc = parser.parseFromString(this._content, 'text/html');

    // Extract and process styles
    let styleContent = '';
    const styleNodes = doc.querySelectorAll('style');
    styleNodes.forEach(style => {
      // Replace 'body' selector with '.html-body' and 'html' with ':host' to ensure styles apply within Shadow DOM
      // We use a regex that looks for 'body'/'html' at the start of string or preceded by whitespace/comma/brace
      // and followed by whitespace/comma/brace/pseudo-class
      let css = style.textContent || '';
      css = css.replace(/(^|[\s,])html(?=[\s,{:])/gi, '$1:host');
      css = css.replace(/(^|[\s,])body(?=[\s,{:])/gi, '$1.html-body');
      styleContent += css + '\n';
    });

    // Default styles for better reading experience (can be overridden by document styles)
    const defaultStyles = `
      :host {
        display: block;
        width: 100%;
        height: 100%;
        overflow-y: auto;
        contain: content;
        position: relative;
        background-color: ${options?.theme === 'dark' ? '#1e1e1e' : '#ffffff'};
        color: ${options?.theme === 'dark' ? '#e0e0e0' : '#333'};
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        line-height: 1.6;
      }
      .html-body {
        min-height: 100%;
        padding: 20px;
        box-sizing: border-box;
      }
      /* Ensure images don't overflow */
      img {
        max-width: 100%;
        height: auto;
      }
    `;

    // Construct Shadow DOM content
    // 1. Default Styles
    // 2. Document Styles (Processed)
    // 3. Document Body Content (Wrapped)
    
    shadow.innerHTML = `
      <style>
        ${defaultStyles}
        ${styleContent}
      </style>
      <div class="html-body">
        ${doc.body.innerHTML}
      </div>
    `;

    // Handle scroll on the host (or let internal overflow handle it)
    // We set overflow-y: auto on :host, so the Shadow Host scrolls.
    // The container should not scroll.
    container.style.overflow = 'hidden';

    if (options?.fontSize) {
      // Apply font size to the host
      host.style.fontSize = `${options.fontSize}px`;
    }
  }

  getCurrentPage(): number {
    return 1;
  }

  async goToPage(page: number): Promise<void> {
    // Single page, nothing to do unless we support anchors
    if (page !== 1) return;
  }

  async searchText(query: string, _options?: { caseSensitive?: boolean }): Promise<SearchResult[]> {
    // Simple text search in content
    const results: SearchResult[] = [];
    if (!query || query.length < 2) return results;

    // Use browser's find capability or manual search?
    // Since we injected HTML, we can search in DOM?
    // But this method might be called when not rendered?
    // Interface says returns SearchResult.
    
    // Naive implementation searching in raw content string (stripping tags would be better)
    // For now return empty as placeholder
    return [];
  }

  async extractText(page: number): Promise<string> {
    if (page !== 1) return '';
    // Strip HTML tags
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
  }

  // Helper for virtual scrolling (used by Reader for "vertical" mode progress)
  // This might be called by Reader.tsx via type assertion
  scrollToVirtualPage(_page: number, _viewportHeight: number): void {
     // HTML is single page, so this logic might depend on how we map "pages" to scroll position
     // For now, do nothing or scroll to top
     if (this._currentContainer) {
       this._currentContainer.scrollTop = 0;
     }
  }

  onPageChange?: (page: number) => void;

  private extractFileName(path: string): string {
    const parts = path.split(/[/\\]/);
    return parts[parts.length - 1];
  }

  private parseToc(content: string): TocItem[] {
    const parser = new DOMParser();
    const doc = parser.parseFromString(content, 'text/html');
    const headers = doc.querySelectorAll('h1, h2, h3, h4, h5, h6');
    const toc: TocItem[] = [];
    
    headers.forEach((header, index) => {
      // Create a unique ID for anchor if not exists
      let id = header.id;
      if (!id) {
        id = `header-${index}`;
        // Note: we are not modifying the source content string here, 
        // so these IDs won't exist in the rendered HTML unless we modify it before render.
        // For now, let's just extract titles.
      }

      toc.push({
        title: header.textContent || '',
        level: parseInt(header.tagName.substring(1)),
        location: 1, // Page 1
      });
    });
    
    return toc;
  }
}

// Register HTML renderer
registerRenderer({
  format: 'html',
  extensions: ['.html', '.htm'],
  factory: () => new HtmlRenderer(),
  displayName: 'HTML',
});

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

    // Default styles for better reading experience (GitHub-like theme)
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

/**
 * 书籍格式渲染器统一接口定义
 */

/** 支持的书籍格式类型 */
export type BookFormat = 'pdf' | 'epub' | 'markdown' | 'mobi' | 'azw3' | 'fb2' | 'html' | 'txt';

/** 书籍元数据 */
export interface BookInfo {
  title?: string;
  author?: string;
  publisher?: string;
  language?: string;
  description?: string;
  pageCount: number;
  format: BookFormat;
  coverImage?: string; // base64 或 URL
}

/** 目录项 */
export interface TocItem {
  title: string;
  /** PDF/TXT 为页码，EPUB 为 href/cfi */
  location: string | number;
  level: number;
  children?: TocItem[];
}

/** 渲染质量选项 */
export type RenderQuality = 'thumbnail' | 'standard' | 'high' | 'best';

/** 阅读主题 */
export type ReaderTheme = 'light' | 'dark' | 'sepia';

/** 渲染配置 */
export interface RenderOptions {
  /** 渲染质量，主要用于 PDF */
  quality?: RenderQuality;
  /** 目标宽度 */
  width?: number;
  /** 目标高度 */
  height?: number;
  /** 主题 */
  theme?: ReaderTheme;
  /** 字体大小 */
  fontSize?: number;
  /** 行高 */
  lineHeight?: number;
  /** 字体 */
  fontFamily?: string;
  /** 初始虚拟页（Markdown 用） */
  initialVirtualPage?: number;
  /** 阅读模式：horizontal=翻页模式, vertical=滚动模式 */
  readingMode?: 'horizontal' | 'vertical';
  /** 页面间隙（纵向模式下的页面/章节间距，单位：px） */
  pageGap?: number;
  /** 是否隐藏页分隔线 */
  hideDivider?: boolean;
}

/** 搜索结果 */
export interface SearchResult {
  /** 页码或章节索引 */
  page: number;
  /** 匹配文本 */
  text: string;
  /** 上下文 */
  context: string;
  /** 位置信息 */
  position?: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    cfi?: string; // EPUB 专用
  };
}

/** 页面内容类型 */
export type PageContent = 
  | { type: 'image'; data: string; width: number; height: number; format: 'png' | 'jpeg' | 'webp' }
  | { type: 'html'; content: string; resources?: Record<string, string> }
  | { type: 'text'; content: string; encoding?: string };

export type BookPageCacheStats = {
  size: number;
  maxSize: number;
  memoryMB: number;
  maxMemoryMB: number;
};

export interface IBookPageCache {
  get(pageNumber: number, scale?: number, theme?: string): any | null;
  set(
    pageNumber: number,
    imageData: ImageData,
    width: number,
    height: number,
    scale?: number,
    theme?: string
  ): void;
  has(pageNumber: number, scale?: number, theme?: string): boolean;
  remove(pageNumber: number, scale?: number, theme?: string): void;
  clear(): void;
  getStats(): BookPageCacheStats;
}

/** 渲染器能力标识 */
export interface RendererCapabilities {
  /** 是否支持位图渲染（Canvas + ImageBitmap，用于 PDF 等固定布局格式） */
  supportsBitmap: boolean;
  /** 是否支持 DOM 渲染（HTML 内容，用于 Markdown/EPUB 等流式布局格式） */
  supportsDomRender: boolean;
  /** 是否支持分页（PDF 有多页，Markdown 通常为单页滚动） */
  supportsPagination: boolean;
  /** 是否支持搜索 */
  supportsSearch: boolean;
}

/**
 * 书籍渲染器统一接口
 */
export interface IBookRenderer {
  /** 格式标识 */
  readonly format: BookFormat;
  
  /** 是否就绪 */
  readonly isReady: boolean;

  /** 渲染器能力标识 */
  readonly capabilities: RendererCapabilities;

  /** 加载文档 */
  loadDocument(filePath: string): Promise<BookInfo>;

  /** 获取目录 */
  getToc(): Promise<TocItem[]>;

  /** 获取总页数 */
  getPageCount(): number;

  /** 渲染指定页面到容器 */
  renderPage(page: number, container: HTMLElement, options?: RenderOptions): Promise<void>;

  /** 获取当前页码 */
  getCurrentPage(): number;

  /** 获取当前精确阅读进度（可选，用于更精准的定位恢复） */
  getPreciseProgress?(): number;

  /** 跳转到指定页 */
  goToPage(page: number): Promise<void>;

  /** 滚动到指定锚点（Markdown/HTML/MOBI 等 anchor 型格式使用） */
  scrollToAnchor?(anchor: string): void | Promise<void>;

  /** 搜索文本 */
  searchText(query: string, options?: { caseSensitive?: boolean }): Promise<SearchResult[]>;

  /** 提取指定页的文本 */
  extractText(page: number): Promise<string>;

  /** 获取页面内容（高级渲染用） */
  getPageContent?(page: number, options?: RenderOptions): Promise<PageContent>;

  /** 加载页面为 ImageBitmap（PDF 等位图格式使用） */
  loadPageBitmap?(page: number, width: number, quality?: string, theme?: ReaderTheme): Promise<ImageBitmap>;

  /** 关闭并释放资源 */
  close(): Promise<void>;

  /** 页面变化回调 */
  onPageChange?: (page: number) => void;
}

/** 渲染器工厂函数类型 */
export type RendererFactory = (format: BookFormat) => IBookRenderer;

/** 渲染器注册信息 */
export interface RendererRegistration {
  format: BookFormat;
  extensions: string[];
  factory: () => IBookRenderer;
  displayName: string;
}

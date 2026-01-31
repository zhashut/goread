/**
 * PDF 渲染器
 * 封装所有 PDF 相关的 Tauri 调用，实现统一的 IBookRenderer 接口
 */

import { convertFileSrc } from '@tauri-apps/api/core';
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
import { logError, getInvoke } from '../../index';


/** 目录节点（后端返回格式） */
interface OutlineNode {
  title: string;
  page_number?: number;
  children?: OutlineNode[];
}

/**
 * PDF 渲染器实现
 */
export class PdfRenderer implements IBookRenderer {
  readonly format: BookFormat = 'pdf';
  
  /** PDF 支持位图渲染和分页 */
  readonly capabilities: RendererCapabilities = {
    supportsBitmap: true,
    supportsDomRender: false,
    supportsPagination: true,
    supportsSearch: false, // 后端暂未实现搜索
  };
  
  private _isReady = false;
  private _filePath = '';
  private _pageCount = 0;
  private _currentPage = 1;
  private _toc: TocItem[] = [];
  private _documentInfo: any = null;
  private _tocLoadPromise: Promise<void> | null = null;

  get isReady(): boolean {
    return this._isReady;
  }

  /**
   * 加载 PDF 文档
   */
  async loadDocument(filePath: string): Promise<BookInfo> {
    const invoke = await getInvoke();
    
    this._filePath = filePath;
    
    // 调用后端加载文档
    const infoResp: any = await invoke('pdf_load_document', { filePath });
    const info = infoResp?.info || {};
    
    this._pageCount = Math.max(1, Number(info.page_count ?? 1));
    this._documentInfo = info;
    this._isReady = true;
    
    // 预加载目录（保存 Promise 以便 getToc 可以等待）
    this._tocLoadPromise = this._loadTocAsync();
    
    return {
      title: info.title || undefined,
      author: info.author || undefined,
      publisher: info.producer || undefined,
      language: undefined,
      description: undefined,
      pageCount: this._pageCount,
      format: 'pdf',
      coverImage: undefined,
    };
  }

  /**
   * 异步加载目录（不阻塞文档加载）
   */
  private async _loadTocAsync(): Promise<void> {
    if (!this._filePath) return;
    
    try {
      const invoke = await getInvoke();
      const outlineResp: any = await invoke('pdf_get_outline', { 
        filePath: this._filePath 
      });
      
      const outline = outlineResp?.outline?.bookmarks || [];
      this._toc = this._convertOutline(outline);
      
      // 无目录时创建默认条目
      if (this._toc.length === 0 && this._pageCount > 0) {
        this._toc = [{ 
          title: '全文', 
          location: 1, 
          level: 0, 
          children: [] 
        }];
      }
    } catch (e) {
      await logError('[PdfRenderer] 加载目录失败', { error: String(e), filePath: this._filePath });
      this._toc = [];
    }
  }

  /**
   * 转换后端目录格式为统一格式
   */
  private _convertOutline(nodes: OutlineNode[], level = 0): TocItem[] {
    return (nodes || []).map((n) => ({
      title: n.title || '无标题',
      location: n.page_number || 1,
      level,
      children: this._convertOutline(n.children || [], level + 1),
    }));
  }

  /**
   * 获取目录
   * 会等待异步加载完成后再返回
   */
  async getToc(): Promise<TocItem[]> {
    // 等待目录加载完成
    if (this._tocLoadPromise) {
      await this._tocLoadPromise;
    }
    return this._toc;
  }

  /**
   * 获取总页数
   */
  getPageCount(): number {
    return this._pageCount;
  }

  /**
   * 获取当前页码
   */
  getCurrentPage(): number {
    return this._currentPage;
  }

  /**
   * 跳转到指定页
   */
  async goToPage(page: number): Promise<void> {
    if (page < 1 || page > this._pageCount) {
      throw new Error(`页码超出范围: ${page}`);
    }
    this._currentPage = page;
    this.onPageChange?.(page);
  }

  /**
   * 渲染页面到目标容器
   */
  async renderPage(
    page: number, 
    container: HTMLElement, 
    options?: RenderOptions
  ): Promise<void> {
    if (!this._isReady || !this._filePath) {
      throw new Error('文档未加载');
    }

    const width = options?.width || container.clientWidth || 800;
    const quality = options?.quality || 'standard';
    const theme = options?.theme;

    const bitmap = await this.loadPageBitmap(page, width, quality, theme);

    // 创建或获取 canvas 元素
    let canvas = container.querySelector('canvas') as HTMLCanvasElement | null;
    if (!canvas) {
      canvas = document.createElement('canvas');
      container.appendChild(canvas);
    }

    // 设置 canvas 尺寸
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.style.width = '100%';
    canvas.style.height = 'auto';

    // 绘制到 canvas
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(bitmap, 0, 0);
    }

    // 释放 bitmap 资源
    bitmap.close();

    // 更新当前页码
    this._currentPage = page;
    this.onPageChange?.(page);
  }

  /**
   * 渲染页面到文件（返回文件路径）
   * 这是主要的渲染方法
   */
  async renderPageToFile(
    page: number,
    width: number,
    quality: string = 'standard',
    theme?: string
  ): Promise<string> {
    if (!this._isReady || !this._filePath) {
      throw new Error('文档未加载');
    }
    
    const invoke = await getInvoke();
    const filePath: string = await invoke('pdf_render_page_to_file', {
      filePath: this._filePath,
      pageNumber: page,
      quality,
      width,
      height: null,
      theme: theme || null,
    });
    
    return filePath;
  }

  /**
   * 渲染页面为 Base64（备选方案）
   */
  async renderPageBase64(
    page: number,
    width: number,
    quality: string = 'standard',
    theme?: string
  ): Promise<string> {
    if (!this._isReady || !this._filePath) {
      throw new Error('文档未加载');
    }
    
    const invoke = await getInvoke();
    const dataUrl: string = await invoke('pdf_render_page_base64', {
      filePath: this._filePath,
      pageNumber: page,
      quality,
      width,
      height: null,
      theme: theme || null,
    });
    
    return dataUrl;
  }

  /**
   * 加载页面为 ImageBitmap（封装文件渲染 + 解码）
   */
  async loadPageBitmap(
    page: number,
    width: number,
    quality: string = 'standard',
    theme?: string
  ): Promise<ImageBitmap> {
    // 尝试文件方式
    try {
      const filePath = await this.renderPageToFile(page, width, quality, theme);
      const imageUrl = convertFileSrc(filePath);
      const response = await fetch(imageUrl);
      const blob = await response.blob();
      return await createImageBitmap(blob);
    } catch (eFile) {
      // 降级到 Base64 方式
      try {
        const dataUrl = await this.renderPageBase64(page, width, quality, theme);
        const response = await fetch(dataUrl);
        const blob = await response.blob();
        return await createImageBitmap(blob);
      } catch (eBase64) {
        // 最后尝试 Image 元素方式
        const filePath = await this.renderPageToFile(page, width, quality, theme);
        const imageUrl = convertFileSrc(filePath);
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
          const im = new Image();
          im.onload = () => resolve(im);
          im.onerror = reject;
          im.src = imageUrl;
        });
        return await createImageBitmap(img);
      }
    }
  }

  /**
   * 获取页面内容
   */
  async getPageContent(page: number, options?: RenderOptions): Promise<PageContent> {
    const width = options?.width || 800;
    const quality = options?.quality || 'standard';
    const theme = options?.theme;
    
    const dataUrl = await this.renderPageBase64(page, width, quality, theme);
    
    return {
      type: 'image',
      data: dataUrl,
      width: width,
      height: 0, // 高度由后端根据比例计算
      format: 'png',
    };
  }

  /**
   * 搜索文本
   * 后端暂未提供搜索接口，返回空结果
   */
  async searchText(
    _query: string, 
    _options?: { caseSensitive?: boolean }
  ): Promise<SearchResult[]> {
    // 后端暂未提供 pdf_search_text 命令
    return [];
  }

  /**
   * 提取页面文本
   * 后端暂未提供文本提取接口，返回空字符串
   */
  async extractText(_page: number): Promise<string> {
    // 后端暂未提供 pdf_extract_text 命令
    return '';
  }

  /**
   * 获取文档信息
   */
  async getDocumentInfo(): Promise<any> {
    if (this._documentInfo) {
      return this._documentInfo;
    }
    
    const invoke = await getInvoke();
    const infoResp: any = await invoke('pdf_get_document_info', { 
      filePath: this._filePath 
    });
    
    this._documentInfo = infoResp?.info || {};
    return this._documentInfo;
  }

  /**
   * 获取文件路径
   */
  getFilePath(): string {
    return this._filePath;
  }

  /**
   * 关闭并释放资源
   */
  async close(): Promise<void> {
    this._isReady = false;
    this._filePath = '';
    this._pageCount = 0;
    this._currentPage = 1;
    this._toc = [];
    this._documentInfo = null;
    this._tocLoadPromise = null;
  }

  /** 页面变化回调 */
  onPageChange?: (page: number) => void;
}

// 注册 PDF 渲染器
registerRenderer({
  format: 'pdf',
  extensions: ['.pdf'],
  factory: () => new PdfRenderer(),
  displayName: 'PDF',
});

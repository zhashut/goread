/**
 * 书籍渲染器 Hook
 * 根据文件格式自动选择渲染器，统一管理渲染器生命周期
 */

import { useRef, useCallback, useEffect } from 'react';
import { IBookRenderer, BookInfo, TocItem } from '../services/formats/types';
import { createRenderer, getBookFormat } from '../services/formats';
import { PdfRenderer } from '../services/formats/pdf/PdfRenderer';

export interface UseBookRendererOptions {
  onPageChange?: (page: number) => void;
}

export interface UseBookRendererResult {
  /** 当前渲染器实例（仅 PDF 格式时返回 PdfRenderer） */
  renderer: IBookRenderer | null;
  /** PDF 渲染器（便于访问 PDF 特有方法） */
  pdfRenderer: PdfRenderer | null;
  /** 初始化渲染器 */
  initRenderer: (filePath: string) => Promise<BookInfo>;
  /** 获取目录 */
  getToc: () => Promise<TocItem[]>;
  /** 关闭渲染器 */
  closeRenderer: () => Promise<void>;
  /** 当前格式 */
  format: string | null;
}

/**
 * 书籍渲染器管理 Hook
 */
export function useBookRenderer(
  options?: UseBookRendererOptions
): UseBookRendererResult {
  const rendererRef = useRef<IBookRenderer | null>(null);
  const formatRef = useRef<string | null>(null);

  // 初始化渲染器
  const initRenderer = useCallback(async (filePath: string): Promise<BookInfo> => {
    // 关闭旧渲染器
    if (rendererRef.current) {
      await rendererRef.current.close();
    }

    // 获取格式并创建渲染器
    const format = getBookFormat(filePath);
    if (!format) {
      throw new Error(`不支持的文件格式: ${filePath}`);
    }

    formatRef.current = format;
    const renderer = createRenderer(filePath);
    rendererRef.current = renderer;

    // 设置页面变化回调
    if (options?.onPageChange) {
      renderer.onPageChange = options.onPageChange;
    }

    // 加载文档
    const info = await renderer.loadDocument(filePath);
    return info;
  }, [options?.onPageChange]);

  // 获取目录
  const getToc = useCallback(async (): Promise<TocItem[]> => {
    if (!rendererRef.current) {
      return [];
    }
    return rendererRef.current.getToc();
  }, []);

  // 关闭渲染器
  const closeRenderer = useCallback(async (): Promise<void> => {
    if (rendererRef.current) {
      await rendererRef.current.close();
      rendererRef.current = null;
      formatRef.current = null;
    }
  }, []);

  // 组件卸载时清理
  useEffect(() => {
    return () => {
      if (rendererRef.current) {
        rendererRef.current.close();
      }
    };
  }, []);

  return {
    renderer: rendererRef.current,
    pdfRenderer: formatRef.current === 'pdf' 
      ? (rendererRef.current as PdfRenderer) 
      : null,
    initRenderer,
    getToc,
    closeRenderer,
    format: formatRef.current,
  };
}

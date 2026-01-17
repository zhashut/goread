/**
 * EPUB 书籍加载 Hook
 * 处理 EPUB 文件的加载、解析和元数据提取
 */

import { TocItem } from '../../types';
import { logError } from '../../../index';

/** EPUB 书籍对象类型 */
export interface EpubBook {
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
export interface EpubTocItem {
  label?: string;
  href?: string;
  subitems?: EpubTocItem[];
}

/** 书籍加载 Hook 返回接口 */
export interface EpubLoaderHook {
  /** 从 File 对象创建 EPUB 书籍 */
  createBookFromFile: (file: File) => Promise<EpubBook>;
  /** 获取封面图片 */
  getCoverImage: (book: EpubBook) => Promise<string | undefined>;
  /** 从文件路径提取文件名 */
  extractFileName: (filePath: string) => string;
  /** 将 EPUB 目录转换为通用格式 */
  convertToc: (items: EpubTocItem[], level?: number) => TocItem[];
}

/**
 * EPUB 书籍加载 Hook
 * 提供书籍文件加载、元数据提取、目录转换等功能
 */
export function useEpubLoader(): EpubLoaderHook {
  /**
   * 从 File 对象创建 EPUB 书籍
   */
  const createBookFromFile = async (file: File): Promise<EpubBook> => {
    // @ts-ignore - foliate-js
    const zipModule: any = await import('../../../../lib/foliate-js/vendor/zip.js');
    // @ts-ignore - foliate-js
    const epubModule: any = await import('../../../../lib/foliate-js/epub.js');

    const {
      configure: configureZip,
      ZipReader,
      BlobReader,
      TextWriter,
      BlobWriter,
    } = zipModule;
    const { EPUB } = epubModule;

    configureZip({ useWebWorkers: false });
    const reader = new ZipReader(new BlobReader(file));
    const entries: any[] = await reader.getEntries();
    const map = new Map(entries.map((entry: any) => [entry.filename, entry]));
    const load = (f: any) => (name: string, ...args: any[]) => {
      const entry = map.get(name);
      return entry ? f(entry, ...args) : null;
    };
    const loadText = load((entry: any) => entry.getData(new TextWriter()));
    const loadBlob = load((entry: any, type: string) => entry.getData(new BlobWriter(type)));
    const getSize = (name: string) => {
      const entry: any = map.get(name);
      return entry && typeof entry.uncompressedSize === 'number'
        ? entry.uncompressedSize
        : 0;
    };
    const loader: any = { entries, loadText, loadBlob, getSize };
    const book = await new (EPUB as any)(loader).init();
    return book as EpubBook;
  };

  /**
   * 获取封面图片
   */
  const getCoverImage = async (book: EpubBook): Promise<string | undefined> => {
    if (!book) return undefined;
    try {
      const coverBlob = await book.getCover();
      if (coverBlob) {
        return new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => resolve(undefined);
          reader.readAsDataURL(coverBlob);
        });
      }
    } catch (e) {
      logError('[EpubRenderer] 获取封面失败', {
        error: String(e),
        stack: (e as Error)?.stack,
        step: 'getCoverImage',
      }).catch(() => {});
    }
    return undefined;
  };

  /**
   * 从文件路径提取文件名
   */
  const extractFileName = (filePath: string): string => {
    const parts = filePath.replace(/\\/g, '/').split('/');
    const fileName = parts[parts.length - 1];
    return fileName.replace(/\.epub$/i, '');
  };

  /**
   * 将 EPUB 目录转换为通用格式
   */
  const convertToc = (items: EpubTocItem[], level = 0): TocItem[] => {
    return items.map((item) => ({
      title: item.label || '未命名章节',
      location: item.href || '',
      anchor: item.href || '',
      level,
      children: item.subitems ? convertToc(item.subitems, level + 1) : undefined,
    }));
  };

  return {
    createBookFromFile,
    getCoverImage,
    extractFileName,
    convertToc,
  };
}

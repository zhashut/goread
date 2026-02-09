import { BookInfo, TocItem } from '../../types';
import { logError, getInvoke } from '../../../index';
import { txtPreloader } from '../txtPreloader';
import { TxtBookMeta } from '../txtCacheService';
import { useTxtChapterCache, type TxtChapterCacheHook } from './useTxtChapterCache';

interface BackendTocItem {
  title: string;
  location: number;
  level: number;
  children: BackendTocItem[];
}

interface TxtLoadResult {
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

interface TxtLoadOptions {
  useChapterMode?: boolean;
  skipPreloaderCache?: boolean;
  startProgress?: number;
  /** 直接指定初始章节索引（0-based），优先于 startProgress */
  startChapterIndex?: number;
}

export interface TxtDocumentLoaderContext {
  setUseChapterMode: (value: boolean) => void;
  getUseChapterMode: () => boolean;
  setContent: (value: string) => void;
  setEncoding: (value: string) => void;
  setToc: (value: TocItem[]) => void;
  setIsReady: (value: boolean) => void;
  setChapterCache: (value: TxtChapterCacheHook | null) => void;
  getChapterCache: () => TxtChapterCacheHook | null;
  setBookMeta: (value: TxtBookMeta | null) => void;
  getBookMeta: () => TxtBookMeta | null;
  setCurrentChapterIndex: (value: number) => void;
  getCurrentChapterIndex: () => number;
}

export interface TxtDocumentLoader {
  loadDocument: (filePath: string, options?: TxtLoadOptions) => Promise<BookInfo>;
}

function convertToc(items: BackendTocItem[]): TocItem[] {
  return items.map((item) => ({
    title: item.title,
    location: item.location,
    level: item.level,
    children: item.children ? convertToc(item.children) : undefined,
  }));
}

function convertBackendToc(items: any[]): TocItem[] {
  return items.map((item) => {
    const location =
      typeof item.location === 'object' && item.location?.Page !== undefined
        ? item.location.Page
        : item.location ?? 0;
    return {
      title: item.title,
      location,
      level: item.level ?? 0,
      children: item.children ? convertBackendToc(item.children) : undefined,
    };
  });
}

function extractFileName(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/');
  const fileName = parts[parts.length - 1] || 'Unknown';
  return fileName.replace(/\.[^/.]+$/, '');
}

function findChapterByProgress(bookMeta: TxtBookMeta, progress: number): number {
  if (!bookMeta || bookMeta.chapters.length === 0) {
    return 0;
  }
  const totalChars = bookMeta.total_chars || 1;
  const targetCharOffset = progress * totalChars;
  for (let i = 0; i < bookMeta.chapters.length; i++) {
    const chapter = bookMeta.chapters[i];
    if (targetCharOffset >= chapter.char_start && targetCharOffset < chapter.char_end) {
      return i;
    }
  }
  return bookMeta.chapters.length - 1;
}

async function loadDocumentFullMode(
  filePath: string,
  ctx: TxtDocumentLoaderContext
): Promise<BookInfo> {
  try {
    const preloadedMeta = await txtPreloader.get(filePath);
    if (preloadedMeta) {
      logError('[TxtRenderer] 元数据预加载命中，但仍需加载全文内容').catch(() => {});
    }
    const invoke = await getInvoke();
    const result: TxtLoadResult = await invoke('txt_load_document', {
      filePath,
    });
    ctx.setContent(result.content);
    ctx.setEncoding(result.encoding);
    ctx.setToc(convertToc(result.toc));
    ctx.setIsReady(true);
    logError(`[TxtRenderer] 全量加载完成: ${result.content.length} 字符`).catch(() => {});
    return {
      title: result.title || extractFileName(filePath),
      pageCount: 1,
      format: 'txt',
    };
  } catch (err) {
    logError('[TxtRenderer] loadDocument failed', { error: err, filePath });
    throw err;
  }
}

async function loadDocumentChapterMode(
  filePath: string,
  options: TxtLoadOptions | undefined,
  ctx: TxtDocumentLoaderContext
): Promise<BookInfo> {
  try {
    const chapterCache = useTxtChapterCache({
      filePath,
      onChapterLoaded: (chapter) => {
        logError(`[TxtRenderer] 章节 ${chapter.index} 加载完成`).catch(() => {});
      },
    });
    ctx.setChapterCache(chapterCache);
    const bookMeta = await chapterCache.getOrLoadMetadata();
    ctx.setBookMeta(bookMeta);
    ctx.setToc(convertBackendToc(bookMeta.toc));
    ctx.setEncoding(bookMeta.encoding);
    const startProgress = options?.startProgress ?? 0;
    // 优先使用直接指定的章节索引
    const chapterIndex = typeof options?.startChapterIndex === 'number'
      ? Math.min(Math.max(0, options.startChapterIndex), bookMeta.chapters.length - 1)
      : findChapterByProgress(bookMeta, startProgress);
    ctx.setCurrentChapterIndex(chapterIndex);
    const currentChapter = await chapterCache.getChapter(chapterIndex);
    ctx.setContent(currentChapter.content);
    ctx.setIsReady(true);
    logError(
      `[TxtRenderer] 章节模式加载完成: ${bookMeta.chapters.length} 章，当前章节 ${chapterIndex}`
    ).catch(() => {});
    chapterCache
      .preloadAdjacentChapters(chapterIndex, bookMeta.chapters.length)
      .catch(() => {});
    return {
      title: bookMeta.title || extractFileName(filePath),
      pageCount: bookMeta.chapters.length,
      format: 'txt',
    };
  } catch (err) {
    logError('[TxtRenderer] 章节模式加载失败，回退到全量模式', { error: err, filePath });
    ctx.setUseChapterMode(false);
    return await loadDocumentFullMode(filePath, ctx);
  }
}
export function useTxtDocumentLoader(ctx: TxtDocumentLoaderContext): TxtDocumentLoader {
  const loadDocument = async (
    filePath: string,
    options?: TxtLoadOptions
  ): Promise<BookInfo> => {
    const useChapterMode = options?.useChapterMode ?? false;
    ctx.setUseChapterMode(useChapterMode);
    if (useChapterMode) {
      return await loadDocumentChapterMode(filePath, options, ctx);
    }
    return await loadDocumentFullMode(filePath, ctx);
  };
  return {
    loadDocument,
  };
}


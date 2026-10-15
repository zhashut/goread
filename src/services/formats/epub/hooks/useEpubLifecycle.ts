/**
 * EPUB 生命周期管理 Hook
 * 现在统一走 Rust 后端解析与缓存管道，横向/纵向模式共享同一套数据来源
 */
import { BookInfo, TocItem } from '../../types';
import { logError, getInvoke } from '../../../index';
import { generateContentAwareBookId } from '../../../../utils/bookId';
import { epubCacheService } from '../epubCacheService';
import {
  createEpubReadingOrder,
  mayContainNavigationDocument,
  type EpubReadingOrder,
} from './readingOrder';

export interface EpubLifecycleState {
  isReady: boolean;
  book: null;
  toc: TocItem[];
  totalPages: number;
  sectionCount: number;
  bookId: string | null;
  spine: string[];
  filePath: string;
  /** 不参与阅读顺序的章节下标（EPUB3 导航文档等） */
  hiddenSections: number[];
  /** 阅读顺序视图，隐藏集合为空时为恒等映射 */
  readingOrder: EpubReadingOrder;
}

export interface LoadDocumentOptions {
  expectedReadingMode?: string | null;
  skipPreloaderCache?: boolean;
}

export interface EpubLifecycleHook {
  state: EpubLifecycleState;
  loadDocument: (filePath: string, options?: LoadDocumentOptions | string | null) => Promise<BookInfo>;
  ensureBookLoaded: () => Promise<void>;
  reloadBook: () => Promise<void>;
  reset: () => void;
}

export function useEpubLifecycle(): EpubLifecycleHook {
  const state: EpubLifecycleState = {
    isReady: false,
    book: null,
    toc: [],
    totalPages: 1,
    sectionCount: 0,
    bookId: null,
    spine: [],
    filePath: '',
    hiddenSections: [],
    readingOrder: createEpubReadingOrder([]),
  };

  /**
   * 解析隐藏章节（EPUB3 导航文档）：
   * - 元数据已含该字段（已由 prepare 写入或此前补算过）时直接使用；
   * - 旧缓存（字段缺失）且 spine 中存在疑似导航文档时，调用后端轻量命令补算并回写元数据；
   * - 其余情况返回空，保证 EPUB2 及常规 EPUB3 书籍完全不受影响、无需额外解析。
   */
  const resolveHiddenSections = async (
    filePath: string,
    bookId: string,
    metadata: Awaited<ReturnType<typeof epubCacheService.getMetadata>>,
  ): Promise<number[]> => {
    const cached = metadata?.hiddenSections;
    if (Array.isArray(cached)) {
      return cached;
    }
    if (!mayContainNavigationDocument(metadata?.spine)) {
      return [];
    }
    try {
      const invoke = await getInvoke();
      const result = await invoke<{ hidden_sections: number[] }>(
        'epub_resolve_hidden_sections',
        { filePath, bookId },
      );
      return result?.hidden_sections ?? [];
    } catch (e) {
      // 补算失败不影响阅读，退化为「无隐藏章节」
      logError(`[EpubLifecycle] 隐藏章节补算失败: ${bookId}`).catch(() => {});
      return [];
    }
  };

  const loadFromBackend = async (filePath: string, bookId: string): Promise<BookInfo> => {
    const metadata = await epubCacheService.getMetadata(bookId);

    if (metadata) {
      logError(`[EpubLifecycle] 命中后端元数据缓存（Rust），启用缓存渲染: ${bookId}`).catch(() => { });

      state.toc = metadata.toc;
      state.sectionCount = metadata.sectionCount;
      state.spine = metadata.spine;
      state.totalPages = state.sectionCount;
      state.isReady = true;
      state.book = null;

      const hiddenSections = await resolveHiddenSections(filePath, bookId, metadata);
      state.hiddenSections = hiddenSections;
      state.readingOrder = createEpubReadingOrder(hiddenSections, state.sectionCount);

      return {
        ...metadata.bookInfo,
        format: 'epub',
      };
    }

    logError(`[EpubLifecycle] 后端元数据缓存未命中，即将调用 epub_prepare_book: ${bookId}`).catch(() => { });

    interface BackendPrepareResult {
      book_info: {
        title: string | null;
        author: string | null;
        description: string | null;
        publisher: string | null;
        language: string | null;
        page_count: number;
        format: string;
        cover_image: string | null;
      };
      toc: TocItem[];
      section_count: number;
      spine: string[];
      hidden_sections?: number[];
    }

    const invoke = await getInvoke();
    const prepareStart = Date.now();
    logError(`[EpubLifecycle] 调用 epub_prepare_book 开始解析: ${bookId}`).catch(() => { });

    const result = await invoke<BackendPrepareResult>('epub_prepare_book', {
      filePath,
      bookId,
    });

    const duration = Date.now() - prepareStart;
    logError(
      `[EpubLifecycle] epub_prepare_book 完成: ${bookId}, sectionCount=${result.section_count}, 耗时=${duration}ms`,
    ).catch(() => { });

    const bookInfoFromBackend = result.book_info;

    state.sectionCount = result.section_count;
    state.totalPages = state.sectionCount || Math.max(1, bookInfoFromBackend.page_count || 1);
    state.toc = result.toc;
    state.spine = result.spine;
    state.isReady = true;
    state.book = null;

    state.hiddenSections = result.hidden_sections ?? [];
    state.readingOrder = createEpubReadingOrder(state.hiddenSections, state.sectionCount);

    const bookInfo: BookInfo = {
      title: bookInfoFromBackend.title ?? undefined,
      author: bookInfoFromBackend.author ?? undefined,
      description: bookInfoFromBackend.description ?? undefined,
      publisher: bookInfoFromBackend.publisher ?? undefined,
      language: bookInfoFromBackend.language ?? undefined,
      pageCount: state.totalPages,
      format: 'epub',
      coverImage: bookInfoFromBackend.cover_image ?? undefined,
    };

    return bookInfo;
  };

  const loadDocument = async (filePath: string, _options?: LoadDocumentOptions | string | null): Promise<BookInfo> => {
    state.filePath = filePath;
    state.bookId = await generateContentAwareBookId(filePath);
    const bookId = state.bookId;

    const bookInfo = await loadFromBackend(filePath, bookId);

    return {
      ...bookInfo,
      format: 'epub',
    };
  };

  const ensureBookLoaded = async (): Promise<void> => { };

  const reloadBook = async (): Promise<void> => {
    if (!state.filePath || !state.bookId) {
      return;
    }
    state.isReady = false;
    await loadFromBackend(state.filePath, state.bookId);
  };

  const reset = (): void => {
    state.isReady = false;
    state.book = null;
    state.toc = [];
    state.totalPages = 1;
    state.sectionCount = 0;
    state.bookId = null;
    state.filePath = '';
    state.hiddenSections = [];
    state.readingOrder = createEpubReadingOrder([]);
  };

  return {
    state,
    loadDocument,
    ensureBookLoaded,
    reloadBook,
    reset,
  };
}

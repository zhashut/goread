/**
 * Mobi 生命周期 Hook
 * 统一走 Rust 后端解析与缓存管道，与 EPUB 对齐
 */
import { BookInfo, TocItem } from '../../types';
import { log, getInvoke } from '../../../index';
import { generateQuickBookId } from '../../../../utils/bookId';
import { mobiCacheService } from '../mobiCacheService';

export interface MobiLifecycleState {
    isReady: boolean;
    book: null;
    bookInfo: BookInfo | null;
    toc: TocItem[];
    sectionCount: number;
    bookId: string | null;
    filePath: string | null;
}

/** 加载文档选项 */
export interface MobiLoadDocumentOptions {
    skipPreloaderCache?: boolean;
}

export interface MobiLifecycleHook {
    state: MobiLifecycleState;
    loadDocument: (filePath: string, options?: MobiLoadDocumentOptions) => Promise<BookInfo>;
    ensureBookLoaded: () => Promise<void>;
    reset: () => Promise<void>;
}

/** 后端 mobi_prepare_book 返回结构 */
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
}

export function useMobiLifecycle(): MobiLifecycleHook {
    const state: MobiLifecycleState = {
        isReady: false,
        book: null,
        bookInfo: null,
        toc: [],
        sectionCount: 0,
        bookId: null,
        filePath: null,
    };

    /**
     * 从 Rust 后端加载（缓存优先 → prepare_book）
     */
    const loadFromBackend = async (filePath: string, bookId: string): Promise<BookInfo> => {
        // 1. 优先检查元数据缓存（sectionCount<=1 视为旧缓存，强制重新解析）
        const metadata = await mobiCacheService.getMetadata(bookId);
        if (metadata && metadata.sectionCount > 1) {
            log(`[MobiLifecycle] 命中后端元数据缓存: ${bookId}`, 'info').catch(() => { });

            state.toc = metadata.toc;
            state.sectionCount = metadata.sectionCount;
            state.isReady = true;

            // 用 sectionCount 确保 pageCount 正确
            return {
                ...metadata.bookInfo,
                pageCount: Math.max(1, metadata.sectionCount),
            };
        }

        // 2. 缓存未命中，调用 Rust 解析引擎
        log(`[MobiLifecycle] 元数据缓存未命中，调用 mobi_prepare_book: ${bookId}`, 'info').catch(() => { });

        const invoke = await getInvoke();
        const prepareStart = Date.now();
        const result = await invoke<BackendPrepareResult>('mobi_prepare_book', {
            filePath,
            bookId,
        });

        const duration = Date.now() - prepareStart;
        log(`[MobiLifecycle] mobi_prepare_book 完成: ${bookId}, sections=${result.section_count}, 耗时=${duration}ms`, 'info').catch(() => { });

        const bi = result.book_info;
        state.sectionCount = result.section_count;
        state.toc = result.toc;
        state.isReady = true;

        const bookInfo: BookInfo = {
            title: bi.title ?? undefined,
            author: bi.author ?? undefined,
            description: bi.description ?? undefined,
            publisher: bi.publisher ?? undefined,
            language: bi.language ?? undefined,
            pageCount: Math.max(1, result.section_count),
            format: 'mobi',
            coverImage: bi.cover_image ?? undefined,
        };

        return bookInfo;
    };

    /**
     * 加载 MOBI 文档
     */
    const loadDocument = async (filePath: string, _options?: MobiLoadDocumentOptions): Promise<BookInfo> => {
        state.filePath = filePath;
        state.bookId = generateQuickBookId(filePath);

        const bookInfo = await loadFromBackend(filePath, state.bookId);
        state.bookInfo = bookInfo;

        return bookInfo;
    };

    /** 无操作：所有数据已在 prepare_book 中写入磁盘缓存 */
    const ensureBookLoaded = async (): Promise<void> => { };

    /** 重置/销毁 */
    const reset = async () => {
        state.isReady = false;
        state.book = null;
        state.bookInfo = null;
        state.toc = [];
        state.sectionCount = 0;
        state.bookId = null;
        state.filePath = null;
    };

    return {
        state,
        loadDocument,
        ensureBookLoaded,
        reset,
    };
}

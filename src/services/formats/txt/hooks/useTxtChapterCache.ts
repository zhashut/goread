/**
 * TXT 章节缓存 Hook
 * 封装章节的加载、缓存和预加载逻辑
 */

import { logError, getInvoke } from '../../../index';
import { txtCacheService, TxtBookMeta, TxtChapterContent } from '../txtCacheService';
import { generateTxtBookId, txtPreloader } from '../txtPreloader';

export interface UseTxtChapterCacheOptions {
    filePath: string;
    onChapterLoaded?: (chapter: TxtChapterContent) => void;
}

export interface TxtChapterCacheHook {
    /** 获取书籍 ID */
    getBookId: () => string;

    /** 获取或加载元数据 */
    getOrLoadMetadata: () => Promise<TxtBookMeta>;

    /** 获取章节内容（优先从缓存） */
    getChapter: (index: number) => Promise<TxtChapterContent>;

    /** 检查章节是否已缓存 */
    hasChapter: (index: number) => boolean;

    /** 预加载相邻章节 */
    preloadAdjacentChapters: (currentIndex: number, totalChapters: number) => Promise<void>;

    /** 获取缓存统计 */
    getCacheStats: () => { cachedCount: number; memoryMB: number };

    /** 清理缓存 */
    clearCache: () => void;
}

/**
 * 创建 TXT 章节缓存 Hook
 */
export function useTxtChapterCache(options: UseTxtChapterCacheOptions): TxtChapterCacheHook {
    const { filePath, onChapterLoaded } = options;
    const bookId = generateTxtBookId(filePath);

    /**
     * 获取书籍 ID
     */
    const getBookId = (): string => bookId;

    /**
     * 获取或加载元数据
     */
    const getOrLoadMetadata = async (): Promise<TxtBookMeta> => {
        return await txtPreloader.getOrLoad(filePath);
    };

    /**
     * 获取章节内容
     */
    const getChapter = async (index: number): Promise<TxtChapterContent> => {
        // 先检查缓存
        const cached = txtCacheService.getChapter(bookId, index);
        if (cached) {
            logError(`[useTxtChapterCache] 章节 ${index} 缓存命中`).catch(() => { });
            return cached;
        }

        // 从后端加载
        logError(`[useTxtChapterCache] 加载章节 ${index}`).catch(() => { });
        const invoke = await getInvoke();
        const chapters = await invoke<TxtChapterContent[]>('txt_load_chapter', {
            filePath,
            chapterIndex: index,
            extraChapters: null,
        });

        if (chapters.length === 0) {
            throw new Error(`章节 ${index} 加载失败`);
        }

        const chapter = chapters[0];

        // 存入缓存
        txtCacheService.setChapter(bookId, chapter);

        // 回调
        onChapterLoaded?.(chapter);

        return chapter;
    };

    /**
     * 检查章节是否已缓存
     */
    const hasChapter = (index: number): boolean => {
        return txtCacheService.hasChapter(bookId, index);
    };

    /**
     * 预加载相邻章节
     */
    const preloadAdjacentChapters = async (
        currentIndex: number,
        totalChapters: number
    ): Promise<void> => {
        await txtPreloader.preloadChapters(filePath, currentIndex, totalChapters);
    };

    /**
     * 获取缓存统计
     */
    const getCacheStats = (): { cachedCount: number; memoryMB: number } => {
        const stats = txtCacheService.getStats();
        return {
            cachedCount: txtCacheService.getCachedChapterCount(bookId),
            memoryMB: stats.memoryMB,
        };
    };

    /**
     * 清理缓存
     */
    const clearCache = (): void => {
        txtCacheService.clearBook(bookId);
    };

    return {
        getBookId,
        getOrLoadMetadata,
        getChapter,
        hasChapter,
        preloadAdjacentChapters,
        getCacheStats,
        clearCache,
    };
}

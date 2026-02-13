/**
 * TXT 缓存服务
 * 提供章节内容和元数据的内存缓存与 IndexedDB 持久化
 */

import { logError } from '../../index';
import {
  TXT_MAX_CHAPTERS_PER_BOOK,
  TXT_CACHE_MAX_MEMORY_MB,
  TXT_PRELOAD_RANGE,
  TXT_CACHE_TIME_TO_IDLE_SECS,
} from '../../../constants/cache';

/** 章节元信息（与后端对应） */
export interface TxtChapterMeta {
    index: number;
    title: string;
    level: number;
    byte_start: number;
    byte_end: number;
    char_start: number;
    char_end: number;
}

/** 章节内容（与后端对应） */
export interface TxtChapterContent {
    index: number;
    content: string;
    char_start: number;
    char_end: number;
}

/** TXT 书籍元数据（与后端对应） */
export interface TxtBookMeta {
    title: string;
    encoding: string;
    total_bytes: number;
    total_chars: number;
    chapters: TxtChapterMeta[];
    toc: any[];
}

/** 章节缓存条目 */
interface ChapterCacheEntry {
    index: number;
    content: string;
    charStart: number;
    charEnd: number;
    loadedAt: number;
    lastAccessTime: number;
    sizeBytes: number;
}

/** 元数据缓存条目 */
interface MetadataCacheEntry {
    bookId: string;
    meta: TxtBookMeta;
    createdAt: number;
    lastAccessTime: number;
}

/** 缓存配置 */
export interface TxtCacheConfig {
    maxChaptersPerBook: number;
    maxTotalMemoryMB: number;
    preloadRange: number;
    timeToIdleSecs: number;
}

const DEFAULT_CONFIG: TxtCacheConfig = {
    maxChaptersPerBook: TXT_MAX_CHAPTERS_PER_BOOK,
    maxTotalMemoryMB: TXT_CACHE_MAX_MEMORY_MB,
    preloadRange: TXT_PRELOAD_RANGE,
    timeToIdleSecs: TXT_CACHE_TIME_TO_IDLE_SECS,
};

/**
 * TXT 缓存服务（单例）
 */
class TxtCacheService {
    // 元数据缓存：bookId -> MetadataCacheEntry
    private _metadataCache = new Map<string, MetadataCacheEntry>();

    // 章节缓存：bookId -> Map<chapterIndex, ChapterCacheEntry>
    private _chapterCache = new Map<string, Map<number, ChapterCacheEntry>>();

    // 配置
    private _config: TxtCacheConfig = { ...DEFAULT_CONFIG };

    // 当前内存占用（估算，MB）
    private _currentMemoryMB = 0;

    /**
     * 更新配置
     */
    setConfig(config: Partial<TxtCacheConfig>): void {
        this._config = { ...this._config, ...config };
        logError(`[TxtCacheService] 配置更新: maxChapters=${this._config.maxChaptersPerBook}, preload=${this._config.preloadRange}`).catch(() => { });
    }

    /**
     * 获取配置
     */
    getConfig(): TxtCacheConfig {
        return { ...this._config };
    }

    // ======================== 元数据缓存 ========================

    /**
     * 获取元数据
     */
    getMetadata(bookId: string): TxtBookMeta | null {
        this._evictExpired();
        const entry = this._metadataCache.get(bookId);
        if (entry) {
            entry.lastAccessTime = Date.now();
            return entry.meta;
        }
        return null;
    }

    /**
     * 设置元数据
     */
    setMetadata(bookId: string, meta: TxtBookMeta): void {
        const now = Date.now();
        this._metadataCache.set(bookId, {
            bookId,
            meta,
            createdAt: now,
            lastAccessTime: now,
        });
        logError(`[TxtCacheService] 元数据已缓存: ${bookId}, ${meta.chapters.length} 章`).catch(() => { });
    }

    /**
     * 检查元数据是否已缓存
     */
    hasMetadata(bookId: string): boolean {
        return this._metadataCache.has(bookId);
    }

    // ======================== 章节缓存 ========================

    /**
     * 获取章节内容
     */
    getChapter(bookId: string, index: number): TxtChapterContent | null {
        this._evictExpired();
        const bookCache = this._chapterCache.get(bookId);
        if (!bookCache) return null;

        const entry = bookCache.get(index);
        if (entry) {
            entry.lastAccessTime = Date.now();
            return {
                index: entry.index,
                content: entry.content,
                char_start: entry.charStart,
                char_end: entry.charEnd,
            };
        }
        return null;
    }

    /**
     * 设置章节内容
     */
    setChapter(bookId: string, chapter: TxtChapterContent): void {
        let bookCache = this._chapterCache.get(bookId);
        if (!bookCache) {
            bookCache = new Map();
            this._chapterCache.set(bookId, bookCache);
        }

        // 计算大小
        const sizeBytes = chapter.content.length * 2; // UTF-16
        const sizeMB = sizeBytes / (1024 * 1024);

        const now = Date.now();
        const entry: ChapterCacheEntry = {
            index: chapter.index,
            content: chapter.content,
            charStart: chapter.char_start,
            charEnd: chapter.char_end,
            loadedAt: now,
            lastAccessTime: now,
            sizeBytes,
        };

        // 检查是否需要淘汰
        if (bookCache.size >= this._config.maxChaptersPerBook) {
            this._evictLRUChapter(bookId);
        }

        // 检查内存限制
        while (this._currentMemoryMB + sizeMB > this._config.maxTotalMemoryMB && this._currentMemoryMB > 0) {
            this._evictGlobalLRU();
        }

        bookCache.set(chapter.index, entry);
        this._currentMemoryMB += sizeMB;
    }

    /**
     * 批量设置章节
     */
    setChapters(bookId: string, chapters: TxtChapterContent[]): void {
        for (const chapter of chapters) {
            this.setChapter(bookId, chapter);
        }
    }

    /**
     * 检查章节是否已缓存
     */
    hasChapter(bookId: string, index: number): boolean {
        const bookCache = this._chapterCache.get(bookId);
        return bookCache?.has(index) ?? false;
    }

    /**
     * 获取指定书籍的缓存章节数量
     */
    getCachedChapterCount(bookId: string): number {
        return this._chapterCache.get(bookId)?.size ?? 0;
    }

    // ======================== 淘汰策略 ========================

    /**
     * 淘汰指定书籍中最久未访问的章节
     */
    private _evictLRUChapter(bookId: string): void {
        const bookCache = this._chapterCache.get(bookId);
        if (!bookCache || bookCache.size === 0) return;

        // 找到最久未访问的章节
        let oldest: ChapterCacheEntry | null = null;
        let oldestIndex = -1;

        for (const [index, entry] of bookCache) {
            if (!oldest || entry.lastAccessTime < oldest.lastAccessTime) {
                oldest = entry;
                oldestIndex = index;
            }
        }

        if (oldest && oldestIndex >= 0) {
            bookCache.delete(oldestIndex);
            this._currentMemoryMB -= oldest.sizeBytes / (1024 * 1024);
            if (this._currentMemoryMB < 0) this._currentMemoryMB = 0;
        }
    }

    /**
     * 淘汰全局最久未访问的章节
     */
    private _evictGlobalLRU(): void {
        let oldest: ChapterCacheEntry | null = null;
        let oldestBookId: string | null = null;
        let oldestIndex = -1;

        for (const [bookId, bookCache] of this._chapterCache) {
            for (const [index, entry] of bookCache) {
                if (!oldest || entry.lastAccessTime < oldest.lastAccessTime) {
                    oldest = entry;
                    oldestBookId = bookId;
                    oldestIndex = index;
                }
            }
        }

        if (oldest && oldestBookId && oldestIndex >= 0) {
            const bookCache = this._chapterCache.get(oldestBookId);
            if (bookCache) {
                bookCache.delete(oldestIndex);
                this._currentMemoryMB -= oldest.sizeBytes / (1024 * 1024);
                if (this._currentMemoryMB < 0) this._currentMemoryMB = 0;

                // 如果书籍缓存为空，移除整个 Map
                if (bookCache.size === 0) {
                    this._chapterCache.delete(oldestBookId);
                }
            }
        }
    }

    private _evictExpired(): void {
        const ttl = this._config.timeToIdleSecs;
        if (!ttl || ttl <= 0) return;
        const now = Date.now();
        const expireBefore = now - ttl * 1000;

        for (const [bookId, entry] of this._metadataCache) {
            if (entry.lastAccessTime < expireBefore) {
                this._metadataCache.delete(bookId);
            }
        }

        for (const [bookId, bookCache] of this._chapterCache) {
            for (const [index, entry] of bookCache) {
                if (entry.lastAccessTime < expireBefore) {
                    bookCache.delete(index);
                    this._currentMemoryMB -= entry.sizeBytes / (1024 * 1024);
                    if (this._currentMemoryMB < 0) this._currentMemoryMB = 0;
                }
            }
            if (bookCache.size === 0) {
                this._chapterCache.delete(bookId);
            }
        }
    }

    // ======================== 清理操作 ========================

    /**
     * 清除指定书籍的所有缓存
     */
    clearBook(bookId: string): void {
        // 清除章节缓存
        const bookCache = this._chapterCache.get(bookId);
        if (bookCache) {
            for (const entry of bookCache.values()) {
                this._currentMemoryMB -= entry.sizeBytes / (1024 * 1024);
            }
            this._chapterCache.delete(bookId);
        }

        // 清除元数据缓存
        this._metadataCache.delete(bookId);

        if (this._currentMemoryMB < 0) this._currentMemoryMB = 0;
        logError(`[TxtCacheService] 书籍缓存已清除: ${bookId}`).catch(() => { });
    }

    /**
     * 清除所有缓存
     */
    clearAll(): void {
        this._metadataCache.clear();
        this._chapterCache.clear();
        this._currentMemoryMB = 0;
        logError('[TxtCacheService] 所有缓存已清除').catch(() => { });
    }

    /**
     * 获取缓存统计信息
     */
    getStats(): {
        metadataCount: number;
        totalChapters: number;
        memoryMB: number;
        bookIds: string[];
    } {
        let totalChapters = 0;
        for (const bookCache of this._chapterCache.values()) {
            totalChapters += bookCache.size;
        }

        return {
            metadataCount: this._metadataCache.size,
            totalChapters,
            memoryMB: Math.round(this._currentMemoryMB * 100) / 100,
            bookIds: Array.from(this._chapterCache.keys()),
        };
    }
}

// 全局单例
export const txtCacheService = new TxtCacheService();

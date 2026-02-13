/**
 * PDF页面缓存管理器
 * 使用LRU（Least Recently Used）策略管理已渲染的页面
 */

export interface CachedPage {
    pageNumber: number;
    imageData: ImageData;
    width: number;
    height: number;
    scale: number;
    timestamp: number;
}

export class PageCacheManager {
    private cache: Map<string, CachedPage>;
    private maxMemoryMB: number; // 最大内存占用（MB）
    private currentMemoryMB: number;

    constructor(maxMemoryMB: number = 256) {
        this.cache = new Map();
        this.maxMemoryMB = maxMemoryMB;
        this.currentMemoryMB = 0;
    }

    /**
     * 生成缓存键
     */
    private getCacheKey(pageNumber: number, scale?: number, theme?: string): string {
        const s = typeof scale === 'number' ? scale : 1.0;
        const themeKey = theme || 'light';
        return `${pageNumber}_${s.toFixed(2)}_${themeKey}`;
    }

    /**
     * 计算ImageData的内存占用（MB）
     */
    private calculateMemoryMB(imageData: ImageData): number {
        return (imageData.data.length / (1024 * 1024));
    }

    /**
     * 获取缓存的页面
     */
    get(pageNumber: number, scale?: number, theme?: string): CachedPage | null {
        const key = this.getCacheKey(pageNumber, scale, theme);
        const cached = this.cache.get(key);

        if (cached) {
            // 更新访问时间（LRU）
            cached.timestamp = Date.now();
            // 将该项移到Map的末尾（最近使用）
            this.cache.delete(key);
            this.cache.set(key, cached);
            return cached;
        }

        return null;
    }

    /**
     * 添加页面到缓存
     */
    set(pageNumber: number, imageData: ImageData, width: number, height: number, scale?: number, theme?: string): void {
        const key = this.getCacheKey(pageNumber, scale, theme);
        const memoryMB = this.calculateMemoryMB(imageData);

        if (this.cache.has(key)) {
            const old = this.cache.get(key)!;
            this.currentMemoryMB -= this.calculateMemoryMB(old.imageData);
            this.cache.delete(key);
        }

        // 检查是否需要淘汰旧页面
        while (
            this.currentMemoryMB + memoryMB > this.maxMemoryMB &&
            this.cache.size > 0
        ) {
            this.evictOldest();
        }

        // 添加新页面
        const cached: CachedPage = {
            pageNumber,
            imageData,
            width,
            height,
            scale : 1.0,
            timestamp: Date.now(),
        };

        this.cache.set(key, cached);
        this.currentMemoryMB += memoryMB;
    }

    /**
     * 淘汰最久未使用的页面
     */
    private evictOldest(): void {
        if (this.cache.size === 0) return;
        const it = this.cache.keys();
        const next = it.next();
        if (next.done || typeof next.value !== 'string') return;
        const firstKey = next.value as string;
        const cached = this.cache.get(firstKey);
        if (cached) {
            this.currentMemoryMB -= this.calculateMemoryMB(cached.imageData);
            this.cache.delete(firstKey);
        }
    }

    /**
     * 清除指定页面的缓存
     */
    remove(pageNumber: number, scale?: number, theme?: string): void {
        if (scale !== undefined && theme !== undefined) {
            const key = this.getCacheKey(pageNumber, scale, theme);
            const cached = this.cache.get(key);
            if (cached) {
                this.currentMemoryMB -= this.calculateMemoryMB(cached.imageData);
                this.cache.delete(key);
            }
        } else {
            // 删除该页面所有scale/theme的缓存
            const keysToDelete: string[] = [];
            this.cache.forEach((cached, key) => {
                if (cached.pageNumber === pageNumber) {
                    keysToDelete.push(key);
                }
            });
            keysToDelete.forEach(key => {
                const cached = this.cache.get(key)!;
                this.currentMemoryMB -= this.calculateMemoryMB(cached.imageData);
                this.cache.delete(key);
            });
        }
    }

    /**
     * 清空所有缓存
     */
    clear(): void {
        this.cache.clear();
        this.currentMemoryMB = 0;
    }

    /**
     * 获取缓存统计信息
     */
    getStats(): {
        size: number;
        maxSize: number;
        memoryMB: number;
        maxMemoryMB: number;
    } {
        const mem = typeof this.currentMemoryMB === 'number' ? this.currentMemoryMB : 0;
        return {
            size: this.cache.size,
            maxSize: 0, // 不按数量限制，仅靠内存上限控制
            memoryMB: parseFloat(mem.toFixed(2)),
            maxMemoryMB: this.maxMemoryMB,
        };
    }

    /**
     * 检查是否有缓存
     */
    has(pageNumber: number, scale?: number, theme?: string): boolean {
        const key = this.getCacheKey(pageNumber, scale, theme);
        return this.cache.has(key);
    }

    /**
     * 预加载页面范围
     */
    getPreloadRange(currentPage: number, totalPages: number, range: number = 2): number[] {
        const pages: number[] = [];
        const start = Math.max(1, currentPage - range);
        const end = Math.min(totalPages, currentPage + range);

        for (let i = start; i <= end; i++) {
            if (i !== currentPage) {
                pages.push(i);
            }
        }

        return pages;
    }
}

import type { IBookPageCache, BookPageCacheStats } from "../services/formats/types";

/**
 * PDF 页面缓存适配器，封装 PageCacheManager 为统一缓存接口
 */
export class PdfPageCache implements IBookPageCache {
    private readonly inner: PageCacheManager;

    constructor(inner: PageCacheManager) {
        this.inner = inner;
    }

    get(pageNumber: number, scale?: number, theme?: string): CachedPage | null {
        return this.inner.get(pageNumber, scale, theme);
    }

    set(
        pageNumber: number,
        imageData: ImageData,
        width: number,
        height: number,
        scale?: number,
        theme?: string
    ): void {
        this.inner.set(pageNumber, imageData, width, height, scale, theme);
    }

    has(pageNumber: number, scale?: number, theme?: string): boolean {
        return this.inner.has(pageNumber, scale, theme);
    }

    remove(pageNumber: number, scale?: number, theme?: string): void {
        this.inner.remove(pageNumber, scale, theme);
    }

    clear(): void {
        this.inner.clear();
    }

    getStats(): BookPageCacheStats {
        return this.inner.getStats();
    }
}

/**
 * MOBI 资源缓存管理器
 * 使用引用计数 + LRU 混合策略管理二进制资源缓存
 */

import type {
  MobiResourceCacheEntry,
  IMobiResourceCache,
} from './types';
import type { BookPageCacheStats } from '../../types';
import { logError } from '../../../index';
import { isIdleExpired, evictOldestEntry } from '../../../../utils/lruCacheUtils';

/**
 * MOBI 资源缓存管理器
 * 存储 MOBI 内的二进制资源（图片、字体等），支持跨章节复用
 */
export class MobiResourceCacheManager implements IMobiResourceCache {
  /** 缓存容器 */
  private cache: Map<string, MobiResourceCacheEntry>;
  /** 最大内存占用（MB） */
  private maxMemoryMB: number;
  /** 当前内存占用（MB） */
  private currentMemoryMB: number;
  /** 空闲过期时间（秒），0 表示不过期 */
  private timeToIdleSecs: number;

  constructor(maxMemoryMB: number = 150) {
    this.cache = new Map();
    this.maxMemoryMB = maxMemoryMB;
    this.currentMemoryMB = 0;
    this.timeToIdleSecs = 0;
  }

  /**
   * 生成缓存键
   */
  private getCacheKey(bookId: string, resourceId: string): string {
    return `${bookId}:${resourceId}`;
  }

  /**
   * 计算 ArrayBuffer 的内存占用（MB）
   */
  private calculateMemoryMB(data: ArrayBuffer): number {
    return data.byteLength / (1024 * 1024);
  }

  /**
   * 淘汰最久未使用且引用计数为 0 的条目
   */
  private evictUnusedOldest(): boolean {
    return evictOldestEntry(this.cache, {
      canEvict: (entry) => entry.refCount === 0,
      onEvict: (entry, key) => {
        this.currentMemoryMB -= this.calculateMemoryMB(entry.data);
        if (this.currentMemoryMB < 0) {
          this.currentMemoryMB = 0;
        }
        logError(`[MobiResourceCache] 淘汰资源: ${String(key)}`).catch(() => {});
      },
    });
  }

  /**
   * 设置空闲过期时间
   */
  setTimeToIdleSecs(secs: number): void {
    this.timeToIdleSecs = secs >= 0 ? secs : 0;
  }

  /**
   * 获取资源数据
   */
  get(bookId: string, resourceId: string): ArrayBuffer | null {
    const key = this.getCacheKey(bookId, resourceId);
    const entry = this.cache.get(key);

    if (!entry) return null;

    if (
      entry.refCount === 0 &&
      isIdleExpired(entry.lastAccessTime, this.timeToIdleSecs)
    ) {
      this.currentMemoryMB -= this.calculateMemoryMB(entry.data);
      this.cache.delete(key);
      return null;
    }

    // 更新访问时间
    if (this.timeToIdleSecs > 0) {
      entry.lastAccessTime = Date.now();
    }

    return entry.data;
  }

  /**
   * 写入资源数据
   */
  set(bookId: string, resourceId: string, data: ArrayBuffer, mimeType: string): void {
    const key = this.getCacheKey(bookId, resourceId);

    // 如果已存在，仅增加引用计数
    if (this.cache.has(key)) {
      this.addRef(bookId, resourceId);
      return;
    }

    const memoryMB = this.calculateMemoryMB(data);

    // 淘汰直到满足内存限制
    while (
      this.currentMemoryMB + memoryMB > this.maxMemoryMB &&
      this.evictUnusedOldest()
    ) {
      // 继续淘汰
    }

    const now = Date.now();
    const entry: MobiResourceCacheEntry = {
      bookId,
      resourceId,
      data,
      mimeType,
      sizeBytes: data.byteLength,
      refCount: 1,
      lastAccessTime: this.timeToIdleSecs > 0 ? now : 0,
      createdAt: now,
    };

    this.cache.set(key, entry);
    this.currentMemoryMB += memoryMB;
  }

  /**
   * 检查资源是否已缓存
   */
  has(bookId: string, resourceId: string): boolean {
    const key = this.getCacheKey(bookId, resourceId);
    const entry = this.cache.get(key);
    if (!entry) return false;

    if (
      entry.refCount === 0 &&
      isIdleExpired(entry.lastAccessTime, this.timeToIdleSecs)
    ) {
      this.currentMemoryMB -= this.calculateMemoryMB(entry.data);
      if (this.currentMemoryMB < 0) {
        this.currentMemoryMB = 0;
      }
      this.cache.delete(key);
      return false;
    }

    return true;
  }

  /**
   * 增加资源引用计数
   */
  addRef(bookId: string, resourceId: string): void {
    const key = this.getCacheKey(bookId, resourceId);
    const entry = this.cache.get(key);
    if (entry) {
      entry.refCount++;
      if (this.timeToIdleSecs > 0) {
        entry.lastAccessTime = Date.now();
      }
    }
  }

  /**
   * 减少资源引用计数
   */
  release(bookId: string, resourceId: string): void {
    const key = this.getCacheKey(bookId, resourceId);
    const entry = this.cache.get(key);
    if (entry && entry.refCount > 0) {
      entry.refCount--;
    }
  }

  /**
   * 清空指定书籍的所有资源缓存
   */
  clearBook(bookId: string): void {
    const prefix = `${bookId}:`;
    const keysToDelete: string[] = [];

    this.cache.forEach((entry, key) => {
      if (key.startsWith(prefix)) {
        keysToDelete.push(key);
        this.currentMemoryMB -= this.calculateMemoryMB(entry.data);
      }
    });

    keysToDelete.forEach((key) => this.cache.delete(key));
    logError(`[MobiResourceCache] 清空书籍资源: ${bookId}, 删除 ${keysToDelete.length} 个资源`).catch(() => {});
  }

  /**
   * 清空所有资源缓存
   */
  clearAll(): void {
    this.cache.clear();
    this.currentMemoryMB = 0;
    logError('[MobiResourceCache] 清空所有资源缓存').catch(() => {});
  }

  /**
   * 获取缓存统计信息
   */
  getStats(): BookPageCacheStats {
    return {
      size: this.cache.size,
      maxSize: 0, // 资源缓存不按数量限制
      memoryMB: parseFloat(this.currentMemoryMB.toFixed(2)),
      maxMemoryMB: this.maxMemoryMB,
    };
  }

  /**
   * 获取资源的 MIME 类型
   */
  getMimeType(bookId: string, resourceId: string): string | null {
    const key = this.getCacheKey(bookId, resourceId);
    const entry = this.cache.get(key);
    return entry?.mimeType ?? null;
  }
}

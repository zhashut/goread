/**
 * MOBI 章节缓存管理器
 * 使用 LRU 策略管理章节快照缓存
 */

import type {
  MobiSectionCacheEntry,
  IMobiSectionCache,
} from './types';
import type { BookPageCacheStats } from '../../types';
import { log, logError } from '../../../index';
import { isIdleExpired, evictOldestEntry } from '../../../../utils/lruCacheUtils';

/**
 * MOBI 章节缓存管理器
 * 参考 PageCacheManager 实现 LRU 淘汰和内存控制
 */
export class MobiSectionCacheManager implements IMobiSectionCache {
  /** 缓存容器 */
  private cache: Map<string, MobiSectionCacheEntry>;
  /** 最大内存占用（MB） */
  private maxMemoryMB: number;
  /** 当前内存占用（MB） */
  private currentMemoryMB: number;
  /** 空闲过期时间（秒），0 表示不过期 */
  private timeToIdleSecs: number;

  constructor(maxMemoryMB: number = 256) {
    this.cache = new Map();
    this.maxMemoryMB = maxMemoryMB;
    this.currentMemoryMB = 0;
    this.timeToIdleSecs = 0;
  }

  /**
   * 生成缓存键
   */
  private getCacheKey(bookId: string, sectionIndex: number): string {
    return `${bookId}:${sectionIndex}`;
  }

  /**
   * 计算章节条目的内存占用（MB）
   * 按 UTF-16 编码估算：每个字符 2 字节
   */
  private calculateMemoryMB(entry: MobiSectionCacheEntry): number {
    const htmlBytes = entry.rawHtml.length * 2;
    const stylesBytes = entry.rawStyles.reduce((sum, s) => sum + s.length * 2, 0);
    const refsBytes = entry.resourceRefs.reduce((sum, s) => sum + s.length * 2, 0);
    const totalBytes = htmlBytes + stylesBytes + refsBytes;
    return totalBytes / (1024 * 1024);
  }

  /**
   * 淘汰最久未使用的条目
   */
  private evictOldest(): void {
    const removed = evictOldestEntry(this.cache, {
      onEvict: (entry, key) => {
        this.currentMemoryMB -= this.calculateMemoryMB(entry);
        if (this.currentMemoryMB < 0) {
          this.currentMemoryMB = 0;
        }
        logError(`[MobiSectionCache] 淘汰章节缓存: ${String(key)}`, { key: String(key) }).catch(() => { });
      },
    });
    if (!removed) {
      return;
    }
  }

  /**
   * 设置空闲过期时间
   */
  setTimeToIdleSecs(secs: number): void {
    this.timeToIdleSecs = secs >= 0 ? secs : 0;
  }

  /**
   * 获取章节缓存
   */
  getSection(bookId: string, sectionIndex: number): MobiSectionCacheEntry | null {
    const key = this.getCacheKey(bookId, sectionIndex);
    const entry = this.cache.get(key);

    if (!entry) return null;

    if (isIdleExpired(entry.meta.lastAccessTime, this.timeToIdleSecs)) {
      this.currentMemoryMB -= this.calculateMemoryMB(entry);
      if (this.currentMemoryMB < 0) {
        this.currentMemoryMB = 0;
      }
      this.cache.delete(key);
      log(`[MobiSectionCache] 章节缓存已过期: ${key}`, 'info').catch(() => { });
      return null;
    }

    // 更新访问时间
    if (this.timeToIdleSecs > 0) {
      entry.meta.lastAccessTime = Date.now();
    }

    // 移到 Map 末尾（LRU）
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry;
  }

  /**
   * 写入章节缓存
   */
  setSection(entry: MobiSectionCacheEntry): void {
    const key = this.getCacheKey(entry.bookId, entry.sectionIndex);
    const memoryMB = this.calculateMemoryMB(entry);

    // 如果已存在，先移除旧条目
    if (this.cache.has(key)) {
      const old = this.cache.get(key)!;
      this.currentMemoryMB -= this.calculateMemoryMB(old);
      this.cache.delete(key);
    }

    // 淘汰直到满足内存限制
    while (
      this.currentMemoryMB + memoryMB > this.maxMemoryMB &&
      this.cache.size > 0
    ) {
      this.evictOldest();
    }

    // 更新元信息
    const now = Date.now();
    entry.meta.createdAt = entry.meta.createdAt || now;
    entry.meta.lastAccessTime = this.timeToIdleSecs > 0 ? now : 0;
    entry.meta.sizeBytes = Math.round(memoryMB * 1024 * 1024);

    // 写入缓存
    this.cache.set(key, entry);
    this.currentMemoryMB += memoryMB;

    // logError(`[MobiSectionCache] 写入章节缓存: ${key}, 内存: ${memoryMB.toFixed(2)}MB`).catch(() => {});
  }

  /**
   * 检查章节是否已缓存
   */
  hasSection(bookId: string, sectionIndex: number): boolean {
    const key = this.getCacheKey(bookId, sectionIndex);
    const entry = this.cache.get(key);
    if (!entry) return false;

    if (isIdleExpired(entry.meta.lastAccessTime, this.timeToIdleSecs)) {
      this.currentMemoryMB -= this.calculateMemoryMB(entry);
      if (this.currentMemoryMB < 0) {
        this.currentMemoryMB = 0;
      }
      this.cache.delete(key);
      return false;
    }

    return true;
  }

  /**
   * 移除指定章节缓存
   */
  removeSection(bookId: string, sectionIndex: number): void {
    const key = this.getCacheKey(bookId, sectionIndex);
    const entry = this.cache.get(key);
    if (entry) {
      this.currentMemoryMB -= this.calculateMemoryMB(entry);
      this.cache.delete(key);
    }
  }

  /**
   * 清空指定书籍的所有章节缓存
   */
  clearBook(bookId: string): void {
    const prefix = `${bookId}:`;
    const keysToDelete: string[] = [];

    this.cache.forEach((entry, key) => {
      if (key.startsWith(prefix)) {
        keysToDelete.push(key);
        this.currentMemoryMB -= this.calculateMemoryMB(entry);
      }
    });

    keysToDelete.forEach((key) => this.cache.delete(key));
    log(`[MobiSectionCache] 清空书籍缓存: ${bookId}, 删除 ${keysToDelete.length} 个章节`, 'info').catch(() => { });
  }

  /**
   * 清空所有缓存
   */
  clearAll(): void {
    this.cache.clear();
    this.currentMemoryMB = 0;
    log('[MobiSectionCache] 清空所有缓存', 'info').catch(() => { });
  }

  /**
   * 获取缓存统计信息
   */
  getStats(): BookPageCacheStats {
    return {
      size: this.cache.size,
      maxSize: 0, // 不按数量限制，仅靠内存上限控制
      memoryMB: parseFloat(this.currentMemoryMB.toFixed(2)),
      maxMemoryMB: this.maxMemoryMB,
    };
  }
}

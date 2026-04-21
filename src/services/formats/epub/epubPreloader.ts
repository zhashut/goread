/**
 * EPUB 书籍预加载器
 * 在用户点击书籍准备进入阅读页时，提前触发书籍加载
 * 利用页面切换动画的时间完成 ZIP 解析，减少横向模式的等待时间
 */

import { logError, getInvoke } from '../../index';
import { generateContentAwareBookId } from './cache';
import { evictOldestEntry } from '../../../utils/lruCacheUtils';
import { EPUB_PRELOADER_MAX_MEMORY_MB } from '../../../constants/cache';

/** 预加载缓存条目 */
interface PreloadCacheEntry {
  bookId: string;
  filePath: string;
  promise: Promise<number>;
  createdAt: number;
  lastAccessTime: number;
  estimatedSizeMB: number;
}

/**
 * EPUB 预加载器类
 * 单例模式，在用户点击书籍时触发预加载
 */
class EpubPreloader {
  /** 预加载缓存（bookId -> entry） */
  private _cache = new Map<string, PreloadCacheEntry>();
  /** 文件路径 -> bookId 反查表，用于同步的 has / clear */
  private _pathToBookId = new Map<string, string>();

  /** 空闲过期时间（秒），0 表示不过期 */
  private _timeToIdleSecs = 0;
  /** 最大预估内存占用（MB），0 表示不限 */
  private _maxMemoryMB = EPUB_PRELOADER_MAX_MEMORY_MB;
  /** 当前预估内存占用（MB） */
  private _currentMemoryMB = 0;

  /**
   * 设置过期时间（天）
   * @param days 过期天数，0 表示不过期
   */
  setExpiryDays(days: number): void {
    if (days > 0) {
      this._timeToIdleSecs = days * 24 * 60 * 60;
    } else {
      this._timeToIdleSecs = 0;
    }
  }

  /**
   * 设置空闲过期时间（秒）
   */
  setTimeToIdleSecs(secs: number): void {
    this._timeToIdleSecs = secs >= 0 ? secs : 0;
  }

  /**
   * 设置最大预估内存占用（MB）
   * 0 表示不限制，依赖系统自身回收策略
   */
  setMaxMemoryMB(mb: number): void {
    if (mb >= 0 && Number.isFinite(mb)) {
      this._maxMemoryMB = mb;
    }
  }

  /**
   * 估算预加载书籍的内存占用（MB）
   */
  private _estimateSizeMB(sectionCount: number): number {
    const sections = sectionCount > 0 ? sectionCount : 1;
    const base = 4;
    const perSection = 0.04;
    return base + sections * perSection;
  }

  /**
   * 清理过期和超出容量的预加载条目
   */
  private _cleanup(): void {
    if (this._cache.size === 0) {
      return;
    }

    for (const [key, entry] of this._cache.entries()) {
      if (
        this._timeToIdleSecs > 0 &&
        Date.now() - entry.lastAccessTime > this._timeToIdleSecs * 1000
      ) {
        this._cache.delete(key);
        this._pathToBookId.delete(entry.filePath);
        this._currentMemoryMB -= entry.estimatedSizeMB;
        if (this._currentMemoryMB < 0) {
          this._currentMemoryMB = 0;
        }
      }
    }

    if (this._maxMemoryMB > 0 && this._currentMemoryMB > this._maxMemoryMB) {
      while (this._cache.size > 0 && this._currentMemoryMB > this._maxMemoryMB) {
        const removed = evictOldestEntry(this._cache, {
          onEvict: (entry) => {
            this._pathToBookId.delete(entry.filePath);
            this._currentMemoryMB -= entry.estimatedSizeMB;
            if (this._currentMemoryMB < 0) {
              this._currentMemoryMB = 0;
            }
            logError(`[EpubPreloader] 容量淘汰预加载: ${entry.filePath}`).catch(() => {});
          },
        });
        if (!removed) {
          break;
        }
      }
    }
  }

  /**
   * 触发预加载（不等待结果）
   * @param filePath - EPUB 文件路径
   */
  preload(filePath: string): void {
    this._cleanup();

    // 异步生成内容感知 bookId 后再进入预加载主流程
    void (async () => {
      try {
        const bookId = await generateContentAwareBookId(filePath);
        const previousBookId = this._pathToBookId.get(filePath);

        // 文件内容变化导致 bookId 变了，先清理旧预加载条目
        if (previousBookId && previousBookId !== bookId) {
          this._removeEntry(previousBookId);
        }
        this._pathToBookId.set(filePath, bookId);

        if (this._cache.has(bookId)) {
          return;
        }

        await this._checkMetadataCacheAndPreload(filePath, bookId);
      } catch (e) {
        logError('[EpubPreloader] 预加载准备失败', {
          error: String(e),
          filePath,
        }).catch(() => {});
      }
    })();
  }

  /**
   * 检查元数据缓存并决定是否执行预加载
   */
  private async _checkMetadataCacheAndPreload(filePath: string, bookId: string): Promise<void> {
    try {
      // 动态导入避免循环依赖
      const { epubCacheService } = await import('./epubCacheService');
      const metadata = await epubCacheService.getMetadata(bookId);
      
      if (metadata) {
        // 元数据缓存存在，跳过预加载
        logError(`[EpubPreloader] 元数据缓存命中，跳过预加载: ${filePath}`).catch(() => {});
        return;
      }
    } catch {
      // 检查失败，继续正常预加载
    }

    // 已经有缓存了（在检查期间被添加），跳过
    if (this._cache.has(bookId)) {
      return;
    }

    // 立即开始加载，不等待结果
    const createdAt = Date.now();
    const loadPromise = this._preloadBook(filePath, bookId).then((sectionCount) => {
      const entry = this._cache.get(bookId);
      if (entry) {
        const estimatedSizeMB = this._estimateSizeMB(sectionCount);
        this._currentMemoryMB -= entry.estimatedSizeMB;
        if (this._currentMemoryMB < 0) {
          this._currentMemoryMB = 0;
        }
        entry.estimatedSizeMB = estimatedSizeMB;
        this._currentMemoryMB += estimatedSizeMB;
      }
      return sectionCount;
    });

    const entry: PreloadCacheEntry = {
      bookId,
      filePath,
      promise: loadPromise,
      createdAt,
      lastAccessTime: createdAt,
      estimatedSizeMB: 8,
    };

    this._currentMemoryMB += entry.estimatedSizeMB;
    this._cache.set(bookId, entry);

    // 处理加载失败的情况
    loadPromise.catch(() => {
      // 加载失败时立即清理
      this._removeEntry(bookId);
      this._pathToBookId.delete(filePath);
    });

    logError(`[EpubPreloader] 开始预加载: ${filePath}`).catch(() => {});
  }

  /**
   * 检查是否有预加载缓存（不等待）
   * @param filePath - EPUB 文件路径
   */
  has(filePath: string): boolean {
    const bookId = this._pathToBookId.get(filePath);
    if (!bookId) return false;
    const entry = this._cache.get(bookId);
    if (!entry) return false;

    if (
      this._timeToIdleSecs > 0 &&
      Date.now() - entry.lastAccessTime > this._timeToIdleSecs * 1000
    ) {
      this._removeEntry(bookId);
      return false;
    }

    return true;
  }

  /**
   * 清除指定文件的预加载缓存
   * @param filePath - EPUB 文件路径
   */
  clear(filePath: string): void {
    const bookId = this._pathToBookId.get(filePath);
    if (!bookId) return;
    this._removeEntry(bookId);
    this._pathToBookId.delete(filePath);
  }

  /**
   * 清除所有预加载缓存
   */
  clearAll(): void {
    this._cache.clear();
    this._pathToBookId.clear();
    this._currentMemoryMB = 0;
  }

  /**
   * 从缓存中移除指定 bookId 对应的条目，并回收其内存计数
   */
  private _removeEntry(bookId: string): void {
    const entry = this._cache.get(bookId);
    if (!entry) return;
    this._cache.delete(bookId);
    this._currentMemoryMB -= entry.estimatedSizeMB;
    if (this._currentMemoryMB < 0) {
      this._currentMemoryMB = 0;
    }
  }

  /**
   * 内部预加载方法：调用后端 epub_prepare_book 预热缓存
   */
  private async _preloadBook(filePath: string, bookId: string): Promise<number> {
    const invoke = await getInvoke();
    try {
      const result = await invoke<{
        book_info: {
          page_count: number;
        };
        toc: any[];
        section_count: number;
      }>('epub_prepare_book', {
        filePath,
        bookId,
      });

      const sectionCount = Number(result?.section_count ?? result?.book_info?.page_count ?? 0);
      logError(`[EpubPreloader] epub_prepare_book 预加载完成: ${filePath}`).catch(() => {});
      return sectionCount;
    } catch (e) {
      logError(`[EpubPreloader] epub_prepare_book 预加载失败`, {
        error: String(e),
        filePath,
      }).catch(() => {});
      throw e;
    }
  }
}

/** 导出单例实例 */
export const epubPreloader = new EpubPreloader();

/**
 * 判断文件是否为 EPUB 格式
 * @param filePath - 文件路径
 */
export function isEpubFile(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.epub');
}

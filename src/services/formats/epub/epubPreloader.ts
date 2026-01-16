/**
 * EPUB 书籍预加载器
 * 在用户点击书籍准备进入阅读页时，提前触发书籍加载
 * 利用页面切换动画的时间完成 ZIP 解析，减少横向模式的等待时间
 */

import { useEpubLoader, type EpubBook } from './hooks';
import { logError } from '../../index';
import { generateQuickBookId } from './cache';
import { evictOldestEntry } from './cache/lruCacheUtils';

/** 获取 Tauri invoke 函数 */
async function getInvoke() {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke;
}

/** 预加载缓存条目 */
interface PreloadCacheEntry {
  bookId: string;
  filePath: string;
  promise: Promise<EpubBook>;
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
  
  /** loader hook 实例 */
  private _loaderHook = useEpubLoader();

  /** 空闲过期时间（秒），0 表示不过期 */
  private _timeToIdleSecs = 0;
  /** 最大预估内存占用（MB），0 表示不限 */
  private _maxMemoryMB = 128;
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
  private _estimateSizeMB(book: EpubBook): number {
    const sections = Array.isArray(book.sections) ? book.sections.length : 1;
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
    const bookId = generateQuickBookId(filePath);

    this._cleanup();

    if (this._cache.has(bookId)) {
      return;
    }

    // 立即开始加载，不等待结果
    const createdAt = Date.now();
    const loadPromise = this._loadBook(filePath).then((book) => {
      const entry = this._cache.get(bookId);
      if (entry) {
        const estimatedSizeMB = this._estimateSizeMB(book);
        this._currentMemoryMB -= entry.estimatedSizeMB;
        if (this._currentMemoryMB < 0) {
          this._currentMemoryMB = 0;
        }
        entry.estimatedSizeMB = estimatedSizeMB;
        this._currentMemoryMB += estimatedSizeMB;
      }
      return book;
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
      const entry = this._cache.get(bookId);
      if (entry) {
        this._cache.delete(bookId);
        this._currentMemoryMB -= entry.estimatedSizeMB;
        if (this._currentMemoryMB < 0) {
          this._currentMemoryMB = 0;
        }
      }
    });

    logError(`[EpubPreloader] 开始预加载: ${filePath}`).catch(() => {});
  }

  /**
   * 获取预加载的书籍（如果有）
   * @param filePath - EPUB 文件路径
   * @returns 预加载的书籍对象，或 null
   */
  async get(filePath: string): Promise<EpubBook | null> {
    const bookId = generateQuickBookId(filePath);
    const entry = this._cache.get(bookId);
    if (!entry) {
      return null;
    }

    try {
      const book = await entry.promise;
      entry.lastAccessTime = Date.now();
      this._cache.delete(bookId);
      this._cache.set(bookId, entry);

      logError(`[EpubPreloader] 命中预加载缓存: ${filePath}`).catch(() => {});
      return book;
    } catch (e) {
      // 加载失败，清理缓存
      const stored = this._cache.get(bookId);
      if (stored) {
        this._cache.delete(bookId);
      }
      logError(`[EpubPreloader] 预加载失败: ${e}`).catch(() => {});
      return null;
    }
  }

  /**
   * 检查是否有预加载缓存（不等待）
   * @param filePath - EPUB 文件路径
   */
  has(filePath: string): boolean {
    const bookId = generateQuickBookId(filePath);
    const entry = this._cache.get(bookId);
    if (!entry) return false;

    if (
      this._timeToIdleSecs > 0 &&
      Date.now() - entry.lastAccessTime > this._timeToIdleSecs * 1000
    ) {
      this._cache.delete(bookId);
      this._currentMemoryMB -= entry.estimatedSizeMB;
      if (this._currentMemoryMB < 0) {
        this._currentMemoryMB = 0;
      }
      return false;
    }

    return true;
  }

  /**
   * 清除指定文件的预加载缓存
   * @param filePath - EPUB 文件路径
   */
  clear(filePath: string): void {
    const bookId = generateQuickBookId(filePath);
    const entry = this._cache.get(bookId);
    if (!entry) return;
    this._cache.delete(bookId);
    this._currentMemoryMB -= entry.estimatedSizeMB;
    if (this._currentMemoryMB < 0) {
      this._currentMemoryMB = 0;
    }
  }

  /**
   * 清除所有预加载缓存
   */
  clearAll(): void {
    this._cache.clear();
    this._currentMemoryMB = 0;
  }

  /**
   * 内部加载方法
   */
  private async _loadBook(filePath: string): Promise<EpubBook> {
    // 通过 Tauri 读取文件
    const invoke = await getInvoke();
    const bytes = await invoke<number[]>('read_file_bytes', { path: filePath });
    const arrayBuffer = new Uint8Array(bytes).buffer;

    // 创建 File 对象
    const fileName = this._loaderHook.extractFileName(filePath);
    const file = new File([arrayBuffer], fileName + '.epub', {
      type: 'application/epub+zip',
    });

    // 解析 EPUB
    const book = await this._loaderHook.createBookFromFile(file);
    
    logError(`[EpubPreloader] 预加载完成: ${filePath}`).catch(() => {});
    return book;
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

/**
 * MOBI 书籍预加载器
 * 在用户点击书籍准备进入阅读页时，提前触发书籍加载
 * 利用页面切换动画的时间完成 MOBI 解析，减少等待时间
 */

import { logError, getInvoke } from '../../index';
import { generateQuickBookId } from '../../../utils/bookId';
import { evictOldestEntry } from '../../../utils/lruCacheUtils';
import { MobiBook } from './types';

/** 预加载缓存条目 */
interface PreloadCacheEntry {
  bookId: string;
  filePath: string;
  promise: Promise<MobiBook>;
  createdAt: number;
  lastAccessTime: number;
  estimatedSizeMB: number;
}

/**
 * MOBI 预加载器类
 * 单例模式，在用户点击书籍时触发预加载
 */
class MobiPreloader {
  /** 预加载缓存（bookId -> entry） */
  private _cache = new Map<string, PreloadCacheEntry>();

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
  private _estimateSizeMB(book: MobiBook): number {
    const sections = Array.isArray(book.sections) ? book.sections.length : 1;
    const base = 6; // MOBI 解析器基础开销稍大于 EPUB
    const perSection = 0.05;
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
            logError(`[MobiPreloader] 容量淘汰预加载: ${entry.filePath}`).catch(() => {});
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
   * @param filePath - MOBI 文件路径
   */
  preload(filePath: string): void {
    const bookId = generateQuickBookId(filePath);

    this._cleanup();

    if (this._cache.has(bookId)) {
      return;
    }

    // 检查元数据缓存是否存在，如果存在则跳过预加载
    // 因为 MobiRenderer.loadDocument 会直接从元数据缓存启动
    this._checkMetadataCacheAndPreload(filePath, bookId);
  }

  /**
   * 检查元数据缓存并决定是否执行预加载
   */
  private async _checkMetadataCacheAndPreload(filePath: string, bookId: string): Promise<void> {
    try {
      // 动态导入避免循环依赖
      const { mobiCacheService } = await import('./mobiCacheService');
      const metadata = await mobiCacheService.getMetadata(bookId);

      if (metadata) {
        // 元数据缓存存在，跳过预加载
        logError(`[MobiPreloader] 元数据缓存命中，跳过预加载: ${filePath}`).catch(() => {});
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
      estimatedSizeMB: 10, // 初始估计值
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

    logError(`[MobiPreloader] 开始预加载: ${filePath}`).catch(() => {});
  }

  /**
   * 获取预加载的书籍（如果有）
   * @param filePath - MOBI 文件路径
   * @returns 预加载的书籍对象，或 null
   */
  async get(filePath: string): Promise<MobiBook | null> {
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

      logError(`[MobiPreloader] 命中预加载缓存: ${filePath}`).catch(() => {});
      return book;
    } catch (e) {
      // 加载失败，清理缓存
      const stored = this._cache.get(bookId);
      if (stored) {
        this._cache.delete(bookId);
      }
      logError(`[MobiPreloader] 预加载失败: ${e}`).catch(() => {});
      return null;
    }
  }

  /**
   * 检查是否有预加载缓存（不等待）
   * @param filePath - MOBI 文件路径
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
   * @param filePath - MOBI 文件路径
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
   * 从文件路径提取文件名
   */
  private _extractFileName(filePath: string): string {
    const parts = filePath.replace(/\\/g, '/').split('/');
    const fileName = parts[parts.length - 1];
    return fileName.replace(/\.(mobi|azw3|azw)$/i, '');
  }

  /**
   * 内部加载方法
   */
  private async _loadBook(filePath: string): Promise<MobiBook> {
    // 通过 Tauri 读取文件
    const invoke = await getInvoke();
    const bytes = await invoke('read_file_bytes', { path: filePath }) as number[];
    const arrayBuffer = new Uint8Array(bytes).buffer;

    // 动态导入 foliate-js 的 mobi 模块
    // @ts-ignore - foliate-js
    const mobiModule: any = await import('../../../lib/foliate-js/mobi.js');

    // 导入 fflate 用于解压缩
    // @ts-ignore
    const { unzlibSync } = await import('fflate');

    // 创建 MOBI 解析器并打开文件
    const mobi = new mobiModule.MOBI({ unzlib: unzlibSync });
    const fileName = this._extractFileName(filePath);
    const file = new File([arrayBuffer], fileName + '.mobi', {
      type: 'application/x-mobipocket-ebook',
    });

    const book = await mobi.open(file) as MobiBook;

    logError(`[MobiPreloader] 预加载完成: ${filePath}`).catch(() => {});
    return book;
  }
}

/** 导出单例实例 */
export const mobiPreloader = new MobiPreloader();

/**
 * 判断文件是否为 MOBI 格式（包含 mobi、azw3、azw）
 * @param filePath - 文件路径
 */
export function isMobiFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith('.mobi') || lower.endsWith('.azw3') || lower.endsWith('.azw');
}

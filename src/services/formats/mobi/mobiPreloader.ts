/**
 * MOBI 书籍预加载器
 * 在用户点击书籍时提前触发 Rust 后端解析
 * 利用页面切换动画时间完成解析，减少等待时间
 */

import { log, getInvoke } from '../../index';
import { generateQuickBookId } from '../../../utils/bookId';
import { mobiCacheService } from './mobiCacheService';

/** 预加载缓存条目（仅存 sectionCount） */
interface PreloadCacheEntry {
  bookId: string;
  filePath: string;
  promise: Promise<number>;
  createdAt: number;
}

class MobiPreloader {
  private _cache = new Map<string, PreloadCacheEntry>();

  /**
   * 触发预加载
   */
  preload(filePath: string): void {
    const bookId = generateQuickBookId(filePath);
    if (this._cache.has(bookId)) return;

    this._checkAndPreload(filePath, bookId);
  }

  private async _checkAndPreload(filePath: string, bookId: string): Promise<void> {
    try {
      // 元数据缓存存在则跳过
      const metadata = await mobiCacheService.getMetadata(bookId);
      if (metadata) {
        log(`[MobiPreloader] 元数据缓存命中，跳过预加载: ${filePath}`, 'info').catch(() => { });
        return;
      }
    } catch {
      // 检查失败，继续预加载
    }

    if (this._cache.has(bookId)) return;

    const loadPromise = this._preloadBook(filePath, bookId);
    this._cache.set(bookId, {
      bookId,
      filePath,
      promise: loadPromise,
      createdAt: Date.now(),
    });

    loadPromise.catch(() => {
      this._cache.delete(bookId);
    });
  }

  /**
   * 调用 Rust 后端解析
   */
  private async _preloadBook(filePath: string, bookId: string): Promise<number> {
    const invoke = await getInvoke();
    const result = await invoke<{ section_count: number }>('mobi_prepare_book', {
      filePath,
      bookId,
    });
    log(`[MobiPreloader] 预加载完成: ${filePath}, sections=${result.section_count}`, 'info').catch(() => { });
    return result.section_count;
  }

  /**
   * 获取预加载结果（如果有）
   */
  async get(filePath: string): Promise<number | null> {
    const bookId = generateQuickBookId(filePath);
    const entry = this._cache.get(bookId);
    if (!entry) return null;

    try {
      const sectionCount = await entry.promise;
      this._cache.delete(bookId);
      return sectionCount;
    } catch {
      this._cache.delete(bookId);
      return null;
    }
  }

  has(filePath: string): boolean {
    return this._cache.has(generateQuickBookId(filePath));
  }

  clear(filePath: string): void {
    this._cache.delete(generateQuickBookId(filePath));
  }

  clearAll(): void {
    this._cache.clear();
  }

  /**
   * 设置缓存过期天数（清理超过有效期的预加载条目）
   */
  setExpiryDays(days: number): void {
    if (days <= 0) return;
    const maxAge = days * 24 * 60 * 60 * 1000;
    const now = Date.now();
    for (const [key, entry] of this._cache) {
      if (now - entry.createdAt > maxAge) {
        this._cache.delete(key);
      }
    }
  }
}

export const mobiPreloader = new MobiPreloader();

/**
 * 判断文件是否为 MOBI 格式
 */
export function isMobiFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith('.mobi') || lower.endsWith('.azw3') || lower.endsWith('.azw');
}

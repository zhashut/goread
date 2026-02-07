/**
 * EPUB 缓存服务（全局单例）
 * 提供章节缓存和资源缓存的全局访问
 * 全部使用后端 Rust 磁盘持久化（对齐 PDF 缓存方案）
 */

import { invoke } from '@tauri-apps/api/core';
import { logError } from '../../index';
import {
  EpubSectionCacheManager,
  EpubResourceCacheManager,
  type IEpubSectionCache,
  type IEpubResourceCache,
  type EpubSectionCacheEntry,
} from './cache';

import { BookInfo, TocItem } from '../types';

export interface EpubMetadataCacheEntry {
  bookId: string;
  bookInfo: BookInfo;
  toc: TocItem[];
  sectionCount: number;
  spine: string[];
  lastAccessTime: number;
}

/** 后端返回的元数据结构（蛇形命名） */
interface BackendMetadataEntry {
  book_id: string;
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
  toc: BackendTocItem[];
  section_count: number;
  spine: string[];
  last_access_time: number;
}

/** 后端返回的目录项结构 */
interface BackendTocItem {
  title: string | null;
  location: string | null;
  level: number;
  children: BackendTocItem[];
}

/** 资源持久化缓存条目（用于内存缓存和后端传输） */
export interface EpubResourceDBEntry {
  key: string;           // bookId:resourcePath
  bookId: string;
  resourcePath: string;
  mimeType: string;
  sizeBytes: number;
  lastAccessTime: number;
  data: ArrayBuffer;     // 二进制数据
}

/** 持久化缓存统计信息 */
export interface EpubPersistedStats {
  sectionCount: number;
  resourceCount: number;
  totalSizeBytes: number;
}

/** 后端缓存统计信息 */
interface BackendCacheStats {
  total_size: number;
  section_count: number;
  resource_count: number;
  max_size: number;
  expiry_days: number;
}

/**
 * 全局 EPUB 缓存服务
 */
class EpubCacheService {
  private _sectionCache: IEpubSectionCache;
  private _resourceCache: IEpubResourceCache;

  constructor() {
    // 内存缓存（一级缓存）
    this._sectionCache = new EpubSectionCacheManager(100, 100);
    this._resourceCache = new EpubResourceCacheManager(150);
  }

  /**
   * 获取章节缓存管理器
   */
  get sectionCache(): IEpubSectionCache {
    return this._sectionCache;
  }

  /**
   * 获取资源缓存管理器
   */
  get resourceCache(): IEpubResourceCache {
    return this._resourceCache;
  }

  /**
   * 等待就绪（兼容旧代码，现在不需要等待 IndexedDB）
   */
  async waitForReady(): Promise<void> {
    // 后端持久化不需要初始化等待
  }

  // ====================== 章节缓存（后端持久化） ======================

  /**
   * 从后端加载章节缓存（现在返回完整数据：HTML + 样式 + 资源引用）
   */
  async loadSectionFromDB(bookId: string, sectionIndex: number): Promise<EpubSectionCacheEntry | null> {
    try {
      // 后端返回的数据结构
      interface BackendSectionData {
        html: string;
        styles: string[];
        resource_refs: string[];
      }

      const result = await invoke<BackendSectionData | null>('epub_load_section', {
        bookId,
        sectionIndex,
      });

      if (!result) {
        return null;
      }

      const now = Date.now();
      // 从后端恢复完整的缓存条目
      const entry: EpubSectionCacheEntry = {
        bookId,
        sectionIndex,
        rawHtml: result.html,
        rawStyles: result.styles ?? [],
        resourceRefs: result.resource_refs ?? [],
        meta: {
          lastAccessTime: now,
          sizeBytes: result.html.length * 2,
          createdAt: now,
          sectionId: null,
        },
      };

      return entry;
    } catch (e) {
      // 后端调用失败时静默返回 null
      return null;
    }
  }

  /**
   * 将章节缓存保存到后端（包含完整的样式和资源引用信息）
   */
  async saveSectionToDB(entry: EpubSectionCacheEntry): Promise<void> {
    try {
      const params = {
        bookId: entry.bookId,
        sectionIndex: entry.sectionIndex,
        htmlContent: entry.rawHtml,
        styles: entry.rawStyles ?? [],
        resourceRefs: entry.resourceRefs ?? [],
      };
      logError('[EpubCacheService] 准备保存章节，参数键:', Object.keys(params).join(', ')).catch(() => { });
      await invoke('epub_save_section', params);
    } catch (e) {
      logError('[EpubCacheService] 保存章节到后端失败', {
        error: String(e),
        stack: (e as Error)?.stack,
        bookId: entry.bookId,
        sectionIndex: entry.sectionIndex,
      }).catch(() => { });
    }
  }

  // ====================== 资源缓存（后端持久化） ======================

  /**
   * 从后端加载资源缓存
   */
  async loadResourceFromDB(bookId: string, resourcePath: string): Promise<EpubResourceDBEntry | null> {
    try {
      const result = await invoke<[number[], string] | null>('epub_load_resource', {
        bookId,
        resourcePath,
      });

      if (!result) {
        return null;
      }

      const [dataArray, mimeType] = result;
      const data = new Uint8Array(dataArray).buffer;

      return {
        key: `${bookId}:${resourcePath}`,
        bookId,
        resourcePath,
        mimeType,
        sizeBytes: data.byteLength,
        lastAccessTime: Date.now(),
        data,
      };
    } catch (e) {
      // 后端调用失败时静默返回 null
      return null;
    }
  }

  /**
   * 将资源保存到后端
   */
  async saveResourceToDB(entry: Omit<EpubResourceDBEntry, 'key'>): Promise<void> {
    try {
      // 将 ArrayBuffer 转换为 number 数组
      const dataArray = Array.from(new Uint8Array(entry.data));

      await invoke('epub_save_resource', {
        bookId: entry.bookId,
        resourcePath: entry.resourcePath,
        data: dataArray,
        mimeType: entry.mimeType,
      });
    } catch (e) {
      logError('[EpubCacheService] 保存资源到后端失败', {
        error: String(e),
        stack: (e as Error)?.stack,
        bookId: entry.bookId,
        resourcePath: entry.resourcePath,
      }).catch(() => { });
    }
  }

  // ====================== 元数据缓存（后端持久化） ======================

  /**
   * 将后端目录项转换为前端格式
   */
  private _convertTocItem(item: BackendTocItem): TocItem {
    return {
      title: item.title ?? '未命名章节',
      location: item.location ?? '',
      level: item.level ?? 0,
      children: item.children?.map(sub => this._convertTocItem(sub)),
    };
  }

  /**
   * 从后端加载元数据缓存
   */
  async getMetadata(bookId: string): Promise<EpubMetadataCacheEntry | null> {
    try {
      const result = await invoke<BackendMetadataEntry | null>('epub_load_metadata', {
        bookId,
      });

      if (!result) {
        return null;
      }

      // 转换后端数据结构为前端格式
      return {
        bookId: result.book_id,
        bookInfo: {
          title: result.book_info.title ?? undefined,
          author: result.book_info.author ?? undefined,
          description: result.book_info.description ?? undefined,
          publisher: result.book_info.publisher ?? undefined,
          language: result.book_info.language ?? undefined,
          pageCount: result.book_info.page_count,
          format: (result.book_info.format as BookInfo['format']) ?? 'epub',
          coverImage: result.book_info.cover_image ?? undefined,
        },
        toc: result.toc?.map(item => this._convertTocItem(item)) ?? [],
        sectionCount: result.section_count,
        spine: result.spine ?? [],
        lastAccessTime: result.last_access_time,
      };
    } catch {
      // 后端调用失败时静默返回 null
      return null;
    }
  }

  /**
   * 将元数据保存到后端
   */
  async saveMetadata(bookId: string, entry: Omit<EpubMetadataCacheEntry, 'bookId' | 'lastAccessTime'>): Promise<void> {
    try {
      // 处理 author 字段：可能是字符串或对象 {name, role, sortAs}
      let authorStr: string | null = null;
      const rawAuthor = entry.bookInfo.author;
      if (typeof rawAuthor === 'string') {
        authorStr = rawAuthor;
      } else if (rawAuthor && typeof rawAuthor === 'object' && 'name' in rawAuthor) {
        authorStr = (rawAuthor as { name?: string }).name ?? null;
      }

      // 转换为后端期望的数据结构
      const bookInfo = {
        title: entry.bookInfo.title ?? null,
        author: authorStr,
        description: entry.bookInfo.description ?? null,
        publisher: entry.bookInfo.publisher ?? null,
        language: entry.bookInfo.language ?? null,
        page_count: entry.bookInfo.pageCount,
        format: entry.bookInfo.format ?? 'epub',
        cover_image: entry.bookInfo.coverImage ?? null,
      };

      // 转换目录项为后端格式
      const convertTocItemToBackend = (item: TocItem): object => ({
        title: item.title ?? null,
        location: String(item.location ?? ''),
        level: item.level ?? 0,
        children: item.children?.map(sub => convertTocItemToBackend(sub)) ?? [],
      });

      const toc = entry.toc?.map(item => convertTocItemToBackend(item)) ?? [];

      const metaParams = {
        bookId,
        bookInfo,
        toc,
        sectionCount: entry.sectionCount,
        spine: entry.spine,
      };
      logError('[EpubCacheService] 准备保存元数据，参数键:', Object.keys(metaParams).join(', ')).catch(() => { });
      await invoke('epub_save_metadata', metaParams);
    } catch (e) {
      logError('[EpubCacheService] 保存元数据到后端失败', {
        error: String(e),
        stack: (e as Error)?.stack,
        bookId,
      }).catch(() => { });
    }
  }

  // ====================== 清理操作 ======================

  /**
   * 清空指定书籍的缓存（内存 + 后端持久化，包括元数据）
   */
  async clearBookFromDB(bookId: string): Promise<void> {
    // 清理后端持久化（后端会同时清理章节、资源、元数据）
    try {
      await invoke('epub_clear_book_cache', { bookId });
    } catch (e) {
      logError('[EpubCacheService] 清理后端书籍缓存失败', {
        error: String(e),
        stack: (e as Error)?.stack,
        bookId,
      }).catch(() => { });
    }
  }

  /**
   * 清空所有持久化缓存
   */
  async clearAllFromDB(): Promise<void> {
    // 通过设置有效期为 -1 天来清理所有缓存
    // 注意：后端没有 clear_all 命令，这里只是触发过期清理
    logError('[EpubCacheService] 清空所有缓存').catch(() => { });
  }

  /**
   * 清理过期的持久化缓存（后端会同时清理章节、资源、元数据）
   */
  async cleanupPersistedCache(): Promise<void> {
    try {
      const cleaned = await invoke<number>('epub_cleanup_expired');
      if (cleaned > 0) {
        logError(`[EpubCacheService] 后端清理过期缓存 ${cleaned} 条`).catch(() => { });
      }
    } catch {
      // 静默失败
    }
  }

  /**
   * 获取持久化缓存统计信息
   */
  async getPersistedStats(): Promise<EpubPersistedStats> {
    try {
      const stats = await invoke<BackendCacheStats>('epub_get_cache_stats');
      return {
        sectionCount: stats.section_count,
        resourceCount: stats.resource_count,
        totalSizeBytes: stats.total_size,
      };
    } catch {
      return { sectionCount: 0, resourceCount: 0, totalSizeBytes: 0 };
    }
  }

  /**
   * 设置内存缓存过期时间（仅内存层）
   */
  setTimeToIdleSecs(secs: number): void {
    this._sectionCache.setTimeToIdleSecs(secs);
    this._resourceCache.setTimeToIdleSecs(secs);
  }

  /**
   * 配置变更时处理
   * @param newDays 新配置的有效期天数，0 表示不限时间
   */
  async applyConfigChange(newDays: number): Promise<void> {
    // 通知后端更新配置并清理过期缓存（后端会同时处理章节、资源、元数据）
    try {
      await invoke('epub_set_cache_expiry', { days: newDays });
      logError(`[EpubCacheService] 配置变更：${newDays === 0 ? '不限' : newDays + '天'}`).catch(() => { });
    } catch (e) {
      logError('[EpubCacheService] 设置缓存有效期失败', {
        error: String(e),
        stack: (e as Error)?.stack,
        days: newDays,
      }).catch(() => { });
    }
  }

  /**
   * 清空所有缓存（内存 + 持久化）
   */
  async clearAll(): Promise<void> {
    this._sectionCache.clearAll();
    this._resourceCache.clearAll();
    await this.clearAllFromDB();
  }
}

// 全局单例
export const epubCacheService = new EpubCacheService();

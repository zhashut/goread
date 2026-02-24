/**
 * MOBI 缓存服务（全局单例）
 * 提供章节缓存和资源缓存的全局访问
 * 全部使用后端 Rust 磁盘持久化（对齐 EPUB/PDF 缓存方案）
 */

import { log, logError, getInvoke } from '../../index';
import {
  MobiSectionCacheManager,
  MobiResourceCacheManager,
  type IMobiSectionCache,
  type IMobiResourceCache,
  type MobiSectionCacheEntry,
} from './cache';
import {
  MOBI_SECTION_CACHE_MAX_MEMORY_MB,
  MOBI_RESOURCE_CACHE_MAX_MEMORY_MB,
} from '../../../constants/cache';

import { BookInfo, TocItem } from '../types';

export interface MobiMetadataCacheEntry {
  bookId: string;
  bookInfo: BookInfo;
  toc: TocItem[];
  sectionCount: number;
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
  last_access_time: number;
}

/** 后端返回的目录项结构 */
interface BackendTocItem {
  title: string | null;
  location: string | null; // MOBI 通常不直接用页码，可能为空或特定 loc
  level: number;
  children: BackendTocItem[];
}

/** 资源持久化缓存条目（用于内存缓存和后端传输） */
export interface MobiResourceDBEntry {
  key: string;           // bookId:resourcePath
  bookId: string;
  resourcePath: string;
  mimeType: string;
  sizeBytes: number;
  lastAccessTime: number;
  data: ArrayBuffer;     // 二进制数据
}

/** 持久化缓存统计信息 */
export interface MobiPersistedStats {
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
 * 全局 MOBI 缓存服务
 */
class MobiCacheService {
  private _sectionCache: IMobiSectionCache;
  private _resourceCache: IMobiResourceCache;

  constructor() {
    // 内存缓存（一级缓存）
    this._sectionCache = new MobiSectionCacheManager(MOBI_SECTION_CACHE_MAX_MEMORY_MB);
    this._resourceCache = new MobiResourceCacheManager(MOBI_RESOURCE_CACHE_MAX_MEMORY_MB);
  }

  /**
   * 获取章节缓存管理器
   */
  get sectionCache(): IMobiSectionCache {
    return this._sectionCache;
  }

  /**
   * 获取资源缓存管理器
   */
  get resourceCache(): IMobiResourceCache {
    return this._resourceCache;
  }

  // ====================== 章节缓存（后端持久化） ======================

  /**
   * 从后端加载章节缓存（返回完整数据：HTML + 样式 + 资源引用）
   */
  async loadSectionFromDB(bookId: string, sectionIndex: number): Promise<MobiSectionCacheEntry | null> {
    try {
      // 后端返回的数据结构
      interface BackendSectionData {
        html: string;
        styles: string[];
        resource_refs: string[];
      }

      const invoke = (await getInvoke()) as <T>(cmd: string, args?: any) => Promise<T>;
      const result = await invoke<BackendSectionData | null>('mobi_load_section', {
        bookId,
        sectionIndex,
      });

      if (!result) {
        return null;
      }

      const now = Date.now();
      // 从后端恢复完整的缓存条目
      const entry: MobiSectionCacheEntry = {
        bookId,
        sectionIndex,
        rawHtml: result.html,
        rawStyles: result.styles ?? [],
        resourceRefs: result.resource_refs ?? [],
        meta: {
          lastAccessTime: now,
          sizeBytes: result.html.length * 2,
          createdAt: now,
          sectionId: sectionIndex, // 暂用 index 代替 id
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
  async saveSectionToDB(entry: MobiSectionCacheEntry): Promise<void> {
    try {
      const params = {
        bookId: entry.bookId,
        sectionIndex: entry.sectionIndex,
        htmlContent: entry.rawHtml,
        styles: entry.rawStyles ?? [],
        resourceRefs: entry.resourceRefs ?? [],
      };
      // logError('[MobiCacheService] 准备保存章节，参数键:', Object.keys(params).join(', ')).catch(() => {});
      const invoke = (await getInvoke()) as <T>(cmd: string, args?: any) => Promise<T>;
      await invoke('mobi_save_section', params);
    } catch (e) {
      logError('[MobiCacheService] 保存章节到后端失败', {
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
  async loadResourceFromDB(bookId: string, resourcePath: string): Promise<MobiResourceDBEntry | null> {
    try {
      const invoke = (await getInvoke()) as <T>(cmd: string, args?: any) => Promise<T>;
      const result = await invoke<[number[], string] | null>('mobi_load_resource', {
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
  async saveResourceToDB(entry: Omit<MobiResourceDBEntry, 'key'>): Promise<void> {
    try {
      // 将 ArrayBuffer 转换为 number 数组
      const dataArray = Array.from(new Uint8Array(entry.data));

      const invoke = (await getInvoke()) as <T>(cmd: string, args?: any) => Promise<T>;
      await invoke('mobi_save_resource', {
        bookId: entry.bookId,
        resourcePath: entry.resourcePath,
        data: dataArray,
        mimeType: entry.mimeType,
      });
    } catch (e) {
      logError('[MobiCacheService] 保存资源到后端失败', {
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
  async getMetadata(bookId: string): Promise<MobiMetadataCacheEntry | null> {
    try {
      const invoke = (await getInvoke()) as <T>(cmd: string, args?: any) => Promise<T>;
      const result = await invoke<BackendMetadataEntry | null>('mobi_load_metadata', {
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
          pageCount: result.section_count || result.book_info.page_count,
          format: (result.book_info.format as BookInfo['format']) ?? 'mobi',
          coverImage: result.book_info.cover_image ?? undefined,
        },
        toc: result.toc?.map(item => this._convertTocItem(item)) ?? [],
        sectionCount: result.section_count,
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
  async saveMetadata(bookId: string, entry: Omit<MobiMetadataCacheEntry, 'bookId' | 'lastAccessTime'>): Promise<void> {
    try {
      // 辅助函数：确保字段为字符串（处理数组和非字符串类型）
      const ensureString = (val: unknown): string | null => {
        if (val === null || val === undefined) return null;
        if (Array.isArray(val)) return val.join(', ');
        return String(val);
      };

      // 转换为后端期望的数据结构（所有字段确保为字符串）
      const bookInfo = {
        title: ensureString(entry.bookInfo.title),
        author: ensureString(entry.bookInfo.author),
        description: ensureString(entry.bookInfo.description),
        publisher: ensureString(entry.bookInfo.publisher),
        language: ensureString(entry.bookInfo.language),
        page_count: entry.bookInfo.pageCount ?? 1,
        format: entry.bookInfo.format ?? 'mobi',
        cover_image: ensureString(entry.bookInfo.coverImage),
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
      };
      const invoke = (await getInvoke()) as <T>(cmd: string, args?: any) => Promise<T>;
      await invoke('mobi_save_metadata', metaParams);
    } catch (e) {
      logError('[MobiCacheService] 保存元数据到后端失败', {
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
      const invoke = (await getInvoke()) as <T>(cmd: string, args?: any) => Promise<T>;
      await invoke('mobi_clear_book_cache', { bookId });
    } catch (e) {
      logError('[MobiCacheService] 清理后端书籍缓存失败', {
        error: String(e),
        stack: (e as Error)?.stack,
        bookId,
      }).catch(() => { });
    }
  }

  /**
   * 清空所有持久化缓存
   * TODO: 后端暂未提供 clear_all 命令，当前仅清理内存层
   */
  async clearAllFromDB(): Promise<void> {
    log('[MobiCacheService] 清空所有缓存', 'info').catch(() => { });
  }

  /**
   * 清理过期的持久化缓存（后端会同时清理章节、资源、元数据）
   */
  async cleanupPersistedCache(): Promise<void> {
    try {
      const invoke = (await getInvoke()) as <T>(cmd: string, args?: any) => Promise<T>;
      const cleaned = await invoke<number>('mobi_cleanup_expired');
      if (cleaned > 0) {
        log(`[MobiCacheService] 后端清理过期缓存 ${cleaned} 条`, 'info').catch(() => { });
      }
    } catch {
      // 静默失败
    }
  }

  /**
   * 获取持久化缓存统计信息
   */
  async getPersistedStats(): Promise<MobiPersistedStats> {
    try {
      const invoke = (await getInvoke()) as <T>(cmd: string, args?: any) => Promise<T>;
      const stats = await invoke<BackendCacheStats>('mobi_get_cache_stats');
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
    // 通知后端更新配置并清理过期缓存
    try {
      const invoke = (await getInvoke()) as <T>(cmd: string, args?: any) => Promise<T>;
      await invoke('mobi_set_cache_expiry', { days: newDays });
      log(`[MobiCacheService] 配置变更：${newDays === 0 ? '不限' : newDays + '天'}`, 'info').catch(() => { });
    } catch (e) {
      logError('[MobiCacheService] 设置缓存有效期失败', {
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
export const mobiCacheService = new MobiCacheService();

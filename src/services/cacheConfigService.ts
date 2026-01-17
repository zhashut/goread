import { getInvoke } from './index';
import { epubCacheService } from './formats/epub/epubCacheService';
import { epubPreloader } from './formats/epub/epubPreloader';
import { generateQuickBookId } from './formats/epub/cache';

/** 书籍格式类型（用于缓存清理判断） */
type BookFormat = 'pdf' | 'epub' | 'unknown';

/**
 * 根据文件路径判断书籍格式
 */
function getBookFormat(filePath: string): BookFormat {
  const ext = filePath.toLowerCase().split('.').pop() || '';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'epub') return 'epub';
  return 'unknown';
}

/**
 * 通用缓存配置服务，管理应用级别的缓存策略
 */
export const cacheConfigService = {
  /**
   * 设置缓存过期天数（适用于所有书籍格式）
   * @param days 过期天数，0 表示不限时间
   */
  async setCacheExpiry(days: number): Promise<boolean> {
    const secs =
      typeof days === 'number' && days > 0
        ? days * 24 * 60 * 60
        : 0;
    
    // 设置 EPUB 内存缓存过期时间
    epubCacheService.setTimeToIdleSecs(secs);
    
    // 设置 EPUB 预加载缓存过期时间（与全局策略一致）
    epubPreloader.setExpiryDays(days);
    
    // 配置变更时立即处理存量缓存（按新配置的严格时间清理）
    epubCacheService.applyConfigChange(days).catch(() => {});
    
    // 设置 PDF 缓存过期时间
    try {
      const invoke = await getInvoke();
      return await invoke('pdf_set_cache_expiry', { days });
    } catch {
      return false;
    }
  },

  /**
   * 获取缓存统计信息
   */
  async getCacheStats(): Promise<{
    pdf: {
      item_count: number;
      total_size: number;
      max_size: number;
      max_items: number;
      hit_rate: number;
    } | null;
    epub: {
      memory: {
        sectionCount: number;
        sectionMemoryMB: number;
        resourceCount: number;
        resourceMemoryMB: number;
      };
      persisted: {
        sectionCount: number;
        resourceCount: number;
        totalSizeBytes: number;
      };
    } | null;
  }> {
    // PDF 统计
    let pdfStats = null;
    try {
      const invoke = await getInvoke();
      pdfStats = await invoke('pdf_get_cache_stats');
    } catch {}

    // EPUB 统计
    let epubStats = null;
    try {
      const sectionMemoryStats = epubCacheService.sectionCache.getStats();
      const resourceMemoryStats = epubCacheService.resourceCache.getStats();
      const persistedStats = await epubCacheService.getPersistedStats();

      epubStats = {
        memory: {
          sectionCount: sectionMemoryStats.size,
          sectionMemoryMB: sectionMemoryStats.memoryMB ?? 0,
          resourceCount: resourceMemoryStats.size,
          resourceMemoryMB: resourceMemoryStats.memoryMB ?? 0,
        },
        persisted: {
          sectionCount: persistedStats.sectionCount,
          resourceCount: persistedStats.resourceCount,
          totalSizeBytes: persistedStats.totalSizeBytes,
        },
      };
    } catch {}

    return { pdf: pdfStats, epub: epubStats };
  },

  /**
   * 清理缓存
   * @param filePath 可选，指定书籍路径清理；不传则清理全部
   */
  async clearCache(filePath?: string): Promise<boolean> {
    try {
      const invoke = await getInvoke();

      if (filePath) {
        const format = getBookFormat(filePath);

        if (format === 'epub') {
          // 清理预加载缓存
          epubPreloader.clear(filePath);
          
          // 生成 bookId 并清理内存缓存
          const bookId = generateQuickBookId(filePath);
          epubCacheService.sectionCache.clearBook(bookId);
          epubCacheService.resourceCache.clearBook(bookId);
          
          // 清理后端磁盘缓存（章节、资源、元数据）
          await epubCacheService.clearBookFromDB(bookId);
          return true;
        } else if (format === 'pdf') {
          // 清理指定 PDF 的缓存
          return await invoke('pdf_clear_cache', { filePath });
        } else {
          // 未知格式，尝试两边都清理
          const bookId = generateQuickBookId(filePath);
          epubCacheService.sectionCache.clearBook(bookId);
          epubCacheService.resourceCache.clearBook(bookId);
          await epubCacheService.clearBookFromDB(bookId);
          return await invoke('pdf_clear_cache', { filePath });
        }
      } else {
        // 清理所有缓存
        await epubCacheService.clearAll();
        return await invoke('pdf_clear_cache', { filePath: undefined });
      }
    } catch {
      return false;
    }
  },
};

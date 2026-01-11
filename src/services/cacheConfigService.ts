import { getInvoke } from './index';
import { epubCacheService } from './formats/epub/epubCacheService';

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
    epubCacheService.setTimeToIdleSecs(secs);
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
    item_count: number;
    total_size: number;
    max_size: number;
    max_items: number;
    hit_rate: number;
  } | null> {
    try {
      const invoke = await getInvoke();
      return await invoke('pdf_get_cache_stats');
    } catch {
      return null;
    }
  },

  /**
   * 清理缓存
   * @param filePath 可选，指定书籍路径清理；不传则清理全部
   */
  async clearCache(filePath?: string): Promise<boolean> {
    try {
      const invoke = await getInvoke();
      return await invoke('pdf_clear_cache', { filePath });
    } catch {
      return false;
    }
  },
};

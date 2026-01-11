/**
 * EPUB 缓存模块统一导出
 */

// 类型定义
export type {
  EpubSectionCacheEntry,
  EpubSectionCacheMeta,
  EpubResourceCacheEntry,
  IEpubSectionCache,
  IEpubResourceCache,
} from './types';

// 工具函数
export {
  EPUB_RESOURCE_PLACEHOLDER_PREFIX,
  toResourcePlaceholder,
  fromResourcePlaceholder,
  isResourcePlaceholder,
  getMimeType,
} from './types';

// 缓存管理器
export { EpubSectionCacheManager } from './EpubSectionCacheManager';
export { EpubResourceCacheManager } from './EpubResourceCacheManager';

// BookId 工具
export {
  generateBookId,
  generateQuickBookId,
  extractLogicalId,
} from './bookIdUtils';

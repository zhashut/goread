import { getInvoke } from '../services';

// ======================== EPUB 缓存配置 ========================
/** EPUB 章节内存缓存 - 内存上限 (MB) */
export const EPUB_SECTION_CACHE_MAX_MEMORY_MB = 256;
/** EPUB 资源内存缓存 - 内存上限 (MB) */
export const EPUB_RESOURCE_CACHE_MAX_MEMORY_MB = 256;
/** EPUB 预加载器 - 内存上限 (MB) */
export const EPUB_PRELOADER_MAX_MEMORY_MB = 256;
/** EPUB 后端磁盘缓存上限 (MB) */
export const EPUB_DISK_CACHE_MAX_MB = 256;

// ======================== MOBI 缓存配置 ========================
/** MOBI 章节内存缓存 - 内存上限 (MB) */
export const MOBI_SECTION_CACHE_MAX_MEMORY_MB = 256;
/** MOBI 资源内存缓存 - 内存上限 (MB) */
export const MOBI_RESOURCE_CACHE_MAX_MEMORY_MB = 256;
/** MOBI 预加载器 - 内存上限 (MB) */
export const MOBI_PRELOADER_MAX_MEMORY_MB = 256;
/** MOBI 后端磁盘缓存上限 (MB) */
export const MOBI_DISK_CACHE_MAX_MB = 256;

// ======================== TXT 缓存配置 ========================
/** TXT 总内存上限 (MB) */
export const TXT_CACHE_MAX_MEMORY_MB = 256;
/** TXT 预加载范围（前后各 N 章） */
export const TXT_PRELOAD_RANGE = 5;
/** TXT 空闲过期时间（秒），0 = 不过期 */
export const TXT_CACHE_TIME_TO_IDLE_SECS = 0;

// ======================== PDF 缓存配置 ========================
/** PDF 页面缓存内存上限 (MB) */
export const PDF_PAGE_CACHE_MAX_MEMORY_MB = 256;
/** PDF 后端内存缓存上限 (MB) */
export const PDF_BACKEND_CACHE_MAX_MB = 256;

/** 将后端磁盘缓存配置同步到 Rust 侧，应用启动时调用一次 */
export async function syncDiskCacheConfig(): Promise<void> {
  const invoke = await getInvoke();
  await Promise.all([
    invoke('epub_set_cache_max_size', { maxSizeMb: EPUB_DISK_CACHE_MAX_MB }),
    invoke('mobi_set_cache_max_size', { maxSizeMb: MOBI_DISK_CACHE_MAX_MB }),
    invoke('pdf_set_cache_max_size', { maxSizeMb: PDF_BACKEND_CACHE_MAX_MB }),
  ]);
}

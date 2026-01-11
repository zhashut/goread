/**
 * EPUB 章节缓存类型定义
 * 定义章节缓存和资源缓存的数据结构与接口
 */

import type { BookPageCacheStats } from '../../types';

// ========== 缓存条目类型 ==========

/** 章节缓存条目元信息 */
export interface EpubSectionCacheMeta {
  /** 条目字节大小估算（UTF-16） */
  sizeBytes: number;
  /** 创建时间戳（ms） */
  createdAt: number;
  /** 最近访问时间戳（ms），用于 LRU 和空闲过期 */
  lastAccessTime: number;
  /** foliate section.id，用于 TOC/CFI 映射 */
  sectionId: string | null;
}

/**
 * 章节缓存条目（章节快照）
 * 存储可序列化的章节内容、样式、资源引用，不包含 DOM 节点和 Blob URL
 */
export interface EpubSectionCacheEntry {
  /** 书籍唯一标识（逻辑ID#版本号） */
  bookId: string;
  /** 章节在 spine 中的索引（0-based） */
  sectionIndex: number;
  /** 规范化后的 HTML（使用 __EPUB_RES__:{path} 占位符） */
  rawHtml: string;
  /** 书中 CSS 文本列表 */
  rawStyles: string[];
  /** 本章节引用的资源路径列表 */
  resourceRefs: string[];
  /** 元信息 */
  meta: EpubSectionCacheMeta;
}

/** 资源缓存条目 */
export interface EpubResourceCacheEntry {
  /** 所属书籍标识 */
  bookId: string;
  /** 资源在 EPUB 内的相对路径 */
  resourcePath: string;
  /** 资源二进制数据 */
  data: ArrayBuffer;
  /** 资源 MIME 类型 */
  mimeType: string;
  /** 资源大小（字节） */
  sizeBytes: number;
  /** 引用计数，记录有多少章节引用此资源 */
  refCount: number;
  /** 最近访问时间戳（ms） */
  lastAccessTime: number;
  /** 创建时间戳（ms） */
  createdAt: number;
}

// ========== 缓存接口定义 ==========

/**
 * EPUB 章节缓存接口
 * 管理章节快照的存储与读取
 */
export interface IEpubSectionCache {
  /** 获取章节缓存 */
  getSection(bookId: string, sectionIndex: number): EpubSectionCacheEntry | null;
  /** 写入章节缓存 */
  setSection(entry: EpubSectionCacheEntry): void;
  /** 检查章节是否已缓存 */
  hasSection(bookId: string, sectionIndex: number): boolean;
  /** 移除指定章节缓存 */
  removeSection(bookId: string, sectionIndex: number): void;
  /** 清空指定书籍的所有章节缓存 */
  clearBook(bookId: string): void;
  /** 清空所有缓存 */
  clearAll(): void;
  /** 获取缓存统计信息 */
  getStats(): BookPageCacheStats;
  /** 设置空闲过期时间（秒），0 表示不过期 */
  setTimeToIdleSecs(secs: number): void;
}

/**
 * EPUB 资源缓存接口
 * 管理二进制资源的存储与引用计数
 */
export interface IEpubResourceCache {
  /** 获取资源数据 */
  get(bookId: string, resourcePath: string): ArrayBuffer | null;
  /** 写入资源数据 */
  set(bookId: string, resourcePath: string, data: ArrayBuffer, mimeType: string): void;
  /** 检查资源是否已缓存 */
  has(bookId: string, resourcePath: string): boolean;
  /** 增加资源引用计数 */
  addRef(bookId: string, resourcePath: string): void;
  /** 减少资源引用计数 */
  release(bookId: string, resourcePath: string): void;
  /** 清空指定书籍的所有资源缓存 */
  clearBook(bookId: string): void;
  /** 清空所有资源缓存 */
  clearAll(): void;
  /** 获取缓存统计信息 */
  getStats(): BookPageCacheStats;
  /** 设置空闲过期时间（秒），0 表示不过期 */
  setTimeToIdleSecs(secs: number): void;
}

// ========== 资源路径占位符常量 ==========

/** 资源路径占位符前缀 */
export const EPUB_RESOURCE_PLACEHOLDER_PREFIX = '__EPUB_RES__:';

/**
 * 将资源路径转换为占位符格式
 */
export function toResourcePlaceholder(resourcePath: string): string {
  return `${EPUB_RESOURCE_PLACEHOLDER_PREFIX}${resourcePath}`;
}

/**
 * 从占位符中提取资源路径
 */
export function fromResourcePlaceholder(placeholder: string): string | null {
  if (placeholder.startsWith(EPUB_RESOURCE_PLACEHOLDER_PREFIX)) {
    return placeholder.slice(EPUB_RESOURCE_PLACEHOLDER_PREFIX.length);
  }
  return null;
}

/**
 * 检查是否为资源占位符
 */
export function isResourcePlaceholder(str: string): boolean {
  return str.startsWith(EPUB_RESOURCE_PLACEHOLDER_PREFIX);
}

// ========== MIME 类型工具 ==========

/** 根据文件扩展名获取 MIME 类型 */
export function getMimeType(resourcePath: string): string {
  const ext = resourcePath.split('.').pop()?.toLowerCase() || '';
  const mimeMap: Record<string, string> = {
    // 图片
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    // 字体
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
    otf: 'font/otf',
    eot: 'application/vnd.ms-fontobject',
    // 其他
    css: 'text/css',
    js: 'text/javascript',
    xhtml: 'application/xhtml+xml',
    html: 'text/html',
    xml: 'application/xml',
  };
  return mimeMap[ext] || 'application/octet-stream';
}

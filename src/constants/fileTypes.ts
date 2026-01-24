/**
 * 书籍文件类型配置
 * 用于文件扫描和过滤
 */

import { BookFormat } from '../services/formats/types';
import i18n from '../locales';

/** 支持的文件扩展名（当前扫描支持的格式） */
export const SUPPORTED_FILE_EXTENSIONS = [
  '.pdf',
  '.epub',
  '.md',
  '.markdown',
  '.html',
  '.htm',
  '.txt',
] as const;

export type SupportedExtension = typeof SUPPORTED_FILE_EXTENSIONS[number];

/** 扩展名到格式的映射（当前支持的格式） */
const EXTENSION_FORMAT_MAP: Record<string, BookFormat> = {
  '.pdf': 'pdf',
  '.epub': 'epub',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.html': 'html',
  '.htm': 'html',
  '.txt': 'txt',
};

/** 格式显示名称（默认英文） */
export const FORMAT_DISPLAY_NAMES: Partial<Record<BookFormat, string>> = {
  pdf: 'PDF',
  epub: 'EPUB',
  markdown: 'Markdown',
  html: 'HTML',
  txt: 'TXT',
};

/** 扫描支持的格式（前端已实现的格式） */
export const SCAN_SUPPORTED_FORMATS: BookFormat[] = ['pdf', 'epub', 'markdown', 'html', 'txt'];

/** 默认选中的扫描格式 */
export const DEFAULT_SCAN_FORMATS: BookFormat[] = ['pdf', 'epub', 'markdown', 'html'];

/** 格式颜色配置（当前支持的格式） */
export const FORMAT_COLORS: Record<BookFormat, string> = {
  pdf: '#E82922',
  epub: '#6DA618',
  markdown: '#595959',
  html: '#E34C26',
  txt: '#4A90D9',
  // 以下为历史格式，保留以兼容已导入的书籍
  mobi: '#0058A8',
  azw3: '#FF9900',
  fb2: '#8E24AA',
};

/** 获取格式对应的图标文字 (缩写) */
export function getFormatIconText(format: BookFormat): string {
  switch (format) {
    case 'markdown': return 'MD';
    case 'azw3': return 'AZW3';
    default: return format.toUpperCase();
  }
}

/** 获取格式颜色 */
export function getFormatColor(format: BookFormat | null): string {
    if (!format) return '#999999';
    return FORMAT_COLORS[format] || '#999999';
}

/** 检查文件是否为支持的格式 */
export function isSupportedFile(filePath: string): boolean {
  const lowerPath = filePath.toLowerCase();
  return SUPPORTED_FILE_EXTENSIONS.some(ext => lowerPath.endsWith(ext));
}

/** 根据文件路径获取书籍格式 */
export function getBookFormat(filePath: string): BookFormat | null {
  const lowerPath = filePath.toLowerCase();
  for (const [ext, format] of Object.entries(EXTENSION_FORMAT_MAP)) {
    if (lowerPath.endsWith(ext)) {
      return format;
    }
  }
  return null;
}

/** 从路径提取扩展名 */
export function getFileExtension(filePath: string): string {
  const match = filePath.toLowerCase().match(/(\.[^.]+)$/);
  return match ? match[1] : '';
}

/** 获取扩展名列表的显示名称 */
export function getFileTypeDisplayName(extensions: readonly string[]): string {
  return extensions.map(ext => ext.toUpperCase().slice(1)).join(', ');
}

/** 获取格式的显示名称（带多语言） */
export function getFormatDisplayName(format: BookFormat): string {
  const key = `import:format.${format}`;
  const translated = i18n.t(key as any) as unknown as string;
  if (translated && translated !== key) return translated;
  return FORMAT_DISPLAY_NAMES[format] || format.toUpperCase();
}

/**
 * 书籍文件类型配置
 * 用于文件扫描和过滤
 */

import { BookFormat } from '../services/formats/types';

/** 支持的文件扩展名 */
export const SUPPORTED_FILE_EXTENSIONS = [
  '.pdf',
  '.epub',
  '.mobi',
  '.azw3',
  '.azw',
  '.fb2',
  '.txt',
] as const;

export type SupportedExtension = typeof SUPPORTED_FILE_EXTENSIONS[number];

/** 扩展名到格式的映射 */
const EXTENSION_FORMAT_MAP: Record<string, BookFormat> = {
  '.pdf': 'pdf',
  '.epub': 'epub',
  '.mobi': 'mobi',
  '.azw3': 'azw3',
  '.azw': 'azw3',
  '.fb2': 'fb2',
  '.txt': 'txt',
};

/** 格式显示名称 */
export const FORMAT_DISPLAY_NAMES: Record<BookFormat, string> = {
  pdf: 'PDF',
  epub: 'EPUB',
  mobi: 'MOBI',
  azw3: 'AZW3/Kindle',
  fb2: 'FB2',
  txt: 'TXT',
};

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

/** 获取格式的显示名称 */
export function getFormatDisplayName(format: BookFormat): string {
  return FORMAT_DISPLAY_NAMES[format] || format.toUpperCase();
}

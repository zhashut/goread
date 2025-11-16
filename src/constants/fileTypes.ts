/**
 * 支持的文件类型配置
 * 用于文件扫描和浏览时的过滤规则
 */
export const SUPPORTED_FILE_EXTENSIONS = ['.pdf'] as const;

/**
 * 检查文件路径是否匹配支持的文件类型
 */
export function isSupportedFile(filePath: string): boolean {
  const lowerPath = filePath.toLowerCase();
  return SUPPORTED_FILE_EXTENSIONS.some(ext => lowerPath.endsWith(ext));
}

/**
 * 获取文件类型的显示名称
 */
export function getFileTypeDisplayName(extensions: readonly string[]): string {
  return extensions.map(ext => ext.toUpperCase().slice(1)).join(', ');
}


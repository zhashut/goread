/**
 * EPUB BookId 生成工具
 * 基于书籍元数据和文件内容生成唯一标识
 */

import { logError } from '../../../index';

/**
 * 计算 ArrayBuffer 的 SHA-256 摘要
 * @returns 十六进制字符串
 */
async function sha256(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 从 EPUB 元数据中提取逻辑 ID
 * 优先使用 dc:identifier，回退到 title
 */
export function extractLogicalId(metadata: {
  title?: string;
  identifier?: string;
  [key: string]: unknown;
}): string {
  // 尝试获取标识符
  if (metadata.identifier && typeof metadata.identifier === 'string') {
    return sanitizeId(metadata.identifier);
  }

  // 回退到标题
  if (metadata.title && typeof metadata.title === 'string') {
    return sanitizeId(metadata.title);
  }

  // 最后回退
  return 'unknown';
}

/**
 * 清理 ID 中的特殊字符
 */
function sanitizeId(id: string): string {
  return id
    .replace(/[#:]/g, '_') // 替换可能冲突的字符
    .replace(/\s+/g, '_') // 空白替换为下划线
    .substring(0, 64); // 限制长度
}

/**
 * 生成 EPUB 书籍的唯一标识
 * 格式：逻辑ID#版本号（版本号为文件内容摘要的前 16 位）
 *
 * @param metadata EPUB 元数据
 * @param fileBuffer 文件内容的 ArrayBuffer（可选，用于生成版本号）
 * @returns bookId 字符串
 */
export async function generateBookId(
  metadata: {
    title?: string;
    identifier?: string;
    [key: string]: unknown;
  },
  fileBuffer?: ArrayBuffer
): Promise<string> {
  const logicalId = extractLogicalId(metadata);

  if (!fileBuffer) {
    // 没有文件内容时，使用时间戳作为临时版本
    const tempVersion = Date.now().toString(16).substring(0, 8);
    return `${logicalId}#${tempVersion}`;
  }

  try {
    const fullHash = await sha256(fileBuffer);
    const versionHash = fullHash.substring(0, 16);
    return `${logicalId}#${versionHash}`;
  } catch (e) {
    logError('[BookIdUtils] SHA-256 计算失败:', e).catch(() => {});
    const fallbackVersion = Date.now().toString(16).substring(0, 8);
    return `${logicalId}#${fallbackVersion}`;
  }
}

/**
 * 从文件路径生成简化的 bookId（用于快速生成临时 ID）
 * 注意：此方法不考虑文件内容变化，仅用于临时场景
 */
export function generateQuickBookId(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/');
  const fileName = parts[parts.length - 1] || 'unknown';
  const name = fileName.replace(/\.[^.]+$/, '');
  const sanitized = sanitizeId(name);
  const pathHash = simpleHash(filePath).toString(16).padStart(8, '0');
  return `${sanitized}#${pathHash}`;
}

/**
 * 简单字符串哈希（djb2 算法）
 */
function simpleHash(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash = hash & hash; // 转为 32 位整数
  }
  return Math.abs(hash);
}

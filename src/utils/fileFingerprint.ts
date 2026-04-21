/**
 * 轻量文件指纹工具
 * 基于文件 size + mtime + 首部字节哈希快速判定文件内容是否变化
 * 相比全文件 SHA-256，对大文件的启动影响可以忽略
 */

import { getInvoke, logError } from '../services';

/** 后端返回的文件指纹原始结果 */
interface BackendFingerprint {
  size: number;
  mtime_ms: number;
  head_hash: string;
}

/** 内部简单字符串哈希，仅用于回退场景 */
function fallbackHash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}

/**
 * 获取文件的内容指纹
 * 成功时返回 size-mtime-headHash 拼接的 16 进制字符串
 * 失败时回退为基于路径的哈希，保证调用方永远拿得到一个稳定字符串
 */
export async function getFileFingerprint(filePath: string): Promise<string> {
  const start = Date.now();
  try {
    const invoke = await getInvoke();
    const result = await invoke<BackendFingerprint>('fs_quick_fingerprint', {
      path: filePath,
    });

    const sizeHex = result.size.toString(16);
    const mtimeHex = Math.max(0, result.mtime_ms).toString(16);
    const fingerprint = `${sizeHex}-${mtimeHex}-${result.head_hash}`;

    const duration = Date.now() - start;
    if (duration > 50) {
      logError(`[FileFingerprint] 指纹计算耗时偏高: ${duration}ms`, {
        filePath,
        duration,
      }).catch(() => {});
    }

    return fingerprint;
  } catch (e) {
    logError('[FileFingerprint] 指纹计算失败，回退路径哈希', {
      error: String(e),
      filePath,
    }).catch(() => {});
    return `fallback-${fallbackHash(filePath)}`;
  }
}

/**
 * NAS 网络书架服务模块
 * 封装后端 nas_open_remote / nas_cache_stats / nas_cache_clear 命令，
 * 提供「点击即读」透明缓存与缓存管理能力。
 */

import type { NasConnection } from '../utils/nasConnections';
import { getInvoke } from './commonService';

/** nas_open_remote 命令返回结果（后端 NasOpenResult） */
export interface NasOpenResult {
  /** 入库后的书籍 id（进度/书签均挂在该 id 上） */
  book_id: number;
  /** 本地缓存文件绝对路径 */
  cache_path: string;
  /** 本次调用是否命中已有缓存（true=秒开，false=执行了下载） */
  was_cached: boolean;
}

/** nas_cache_stats 命令返回结果（后端 NasCacheStats） */
export interface NasCacheStats {
  /** 缓存文件数量 */
  file_count: number;
  /** 缓存总字节数 */
  total_bytes: number;
}

/**
 * 打开 NAS 远端书籍（透明缓存）
 * 功能描述：调用后端 nas_open_remote 命令，将远端文件下载到确定性缓存路径
 *          （缓存键由连接 id + 远端路径决定），并入库生成书籍记录；
 *          命中缓存时直接复用不重复下载。下载进度通过 goread:nas:download 事件推送。
 * 参数说明：connection - NAS 连接配置；remotePath - 远端文件完整路径；fileName - 文件名（含扩展名）。
 * 返回值类型及用途：返回 NasOpenResult，含书籍 id（用于跳转阅读器）与缓存命中信息。
 */
export async function nasOpenRemote(connection: NasConnection, remotePath: string, fileName: string): Promise<NasOpenResult> {
  const invoke = await getInvoke();
  return await invoke('nas_open_remote', {
    connectionId: connection.id,
    baseUrl: connection.url,
    username: connection.username || undefined,
    password: connection.password || undefined,
    remotePath,
    fileName,
  });
}

/**
 * 格式化字节数为可读文本
 * 功能描述：将字节数格式化为 B/KB/MB/GB 显示，供进度浮层与设置页缓存统计共用。
 * 参数说明：n - 字节数。
 * 返回值类型及用途：返回如 "128.0 KB" / "2.5 MB" 的可读字符串。
 */
export function formatNasBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * 查询 NAS 缓存统计
 * 功能描述：调用后端 nas_cache_stats 命令，统计缓存目录下文件数量与总字节数。
 * 参数说明：无。
 * 返回值类型及用途：返回 NasCacheStats，用于设置页缓存管理条目展示。
 */
export async function nasCacheStats(): Promise<NasCacheStats> {
  const invoke = await getInvoke();
  return await invoke('nas_cache_stats');
}

/**
 * 清空 NAS 缓存
 * 功能描述：调用后端 nas_cache_clear 命令，删除缓存目录下全部文件；书籍记录与阅读进度保留，
 *          再次打开时自动重新下载。
 * 参数说明：无。
 * 返回值类型及用途：返回被删除的缓存文件数量，用于提示用户清理结果。
 */
export async function nasCacheClear(): Promise<number> {
  const invoke = await getInvoke();
  return await invoke('nas_cache_clear');
}

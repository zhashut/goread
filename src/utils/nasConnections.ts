/**
 * NAS 连接共享存储模块
 *
 * 「导入-NAS」页面与「书架-网络书架」页签共用同一份连接配置，
 * 统一存储于 localStorage（键：nas_connections_v1），
 * 并通过自定义事件 goread:nas:connections-changed 广播变更，
 * 保证跨页面（导入页 / 书架页）的连接列表实时同步。
 */

/** NAS 连接配置 */
export interface NasConnection {
  id: string;
  name: string;
  url: string;
  username: string;
  password: string;
  startPath?: string;
}

/** WebDAV 目录条目（后端 webdav_list 命令返回） */
export interface NasEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size?: number;
  mtime?: number;
}

/** 网络书架目录层级（面包屑节点） */
export interface NasDirLevel {
  name: string;
  path: string;
}

/** NAS 连接列表的 localStorage 存储键 */
export const NAS_CONNECTIONS_STORAGE_KEY = "nas_connections_v1";

/** NAS 连接列表变更广播事件名 */
export const NAS_CONNECTIONS_CHANGED_EVENT = "goread:nas:connections-changed";

/**
 * 从 localStorage 读取 NAS 连接列表
 * 返回值：连接数组；无数据或解析失败时返回空数组
 */
export function loadNasConnections(): NasConnection[] {
  try {
    const raw = localStorage.getItem(NAS_CONNECTIONS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as NasConnection[]) : [];
  } catch {
    return [];
  }
}

/**
 * 保存 NAS 连接列表并广播变更事件
 * 参数：list 待保存的连接数组
 */
export function saveNasConnections(list: NasConnection[]): void {
  localStorage.setItem(NAS_CONNECTIONS_STORAGE_KEY, JSON.stringify(list));
  window.dispatchEvent(new CustomEvent(NAS_CONNECTIONS_CHANGED_EVENT));
}

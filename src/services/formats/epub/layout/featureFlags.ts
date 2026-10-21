/**
 * EPUB 功能开关读取
 *
 * 统一「localStorage + 默认值 + 进程内缓存」的布尔开关逻辑，
 * 避免各模块各自实现一套缓存与解析规则。
 */

/** 开关缓存：key -> 解析结果，避免重复读取 localStorage */
const flagCache = new Map<string, boolean>();

/**
 * 读取布尔型功能开关。
 * localStorage 值为 '0' 时关闭、'1' 时开启，其余情况使用调用方给的默认值。
 * @param key localStorage 键
 * @param fallback 未显式配置时的默认值
 */
export function readBooleanFlag(key: string, fallback: boolean): boolean {
  const cached = flagCache.get(key);
  if (cached !== undefined) return cached;

  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(key);
  } catch {
    // localStorage 不可用时使用默认值
  }

  const value = stored === '0' ? false : stored === '1' ? true : fallback;
  flagCache.set(key, value);
  return value;
}

/**
 * 平台判断工具
 *
 * 收敛分散在各处的 UA / Tauri 环境判断，避免每个模块各写一套正则。
 * 仅提供“无副作用”的纯判断，不涉及具体业务。
 */

export type PlatformKind = 'android' | 'ios' | 'desktop' | 'unknown';

/** 是否运行在 Tauri 容器内（含旧版 __TAURI__ 与新版 __TAURI_INTERNALS__） */
export function isTauri(): boolean {
  const w = window as any;
  return (
    typeof w.__TAURI__ !== 'undefined' ||
    typeof w.__TAURI_INTERNALS__ !== 'undefined' ||
    typeof w.__TAURI_IPC__ !== 'undefined'
  );
}

/** 是否 Android（以 UA 为准，Android WebView 一定带 Android 标记） */
export function isAndroid(): boolean {
  return /android/i.test(navigator.userAgent || '');
}

/** 是否 iOS（iPhone / iPad / iPod） */
export function isIOS(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent || '');
}

/**
 * 判断原生 JS Bridge 是否已注入
 * @param name JavascriptInterface 的全局对象名，如 'StoragePermissionBridge'
 */
export function hasNativeBridge(name: string): boolean {
  return typeof (window as any)[name] !== 'undefined';
}

/** 平台类型判定（优先 UA，其次 Tauri 环境） */
export function detectPlatform(): PlatformKind {
  if (isIOS()) return 'ios';
  if (isAndroid()) return 'android';
  if (isTauri()) return 'desktop';
  // 浏览器开发环境等未知场景统一按桌面处理，便于本地调试
  return 'unknown';
}

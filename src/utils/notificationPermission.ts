/**
 * 通知权限检查与请求工具（Android 13+ POST_NOTIFICATIONS）
 *
 * 背景：Android 13 起通知为 opt-in 运行时权限，未授权时前台服务通知不会出现在通知栏，
 * 但朗读本身不受影响。因此这里只做“尽力申请 + 结果上报”，绝不阻塞业务。
 *
 * 平台差异：
 * - Android 13+：通过 NotificationPermissionBridge 走系统权限弹窗，并提供跳转系统通知设置
 * - Android 12 及以下：无该运行时权限，通知默认可见，视为已授权
 * - iOS / 桌面 / 浏览器：不涉及该权限，视为已授权
 */

import { hasNativeBridge, isAndroid } from './platform';
import { log, logError } from '../services';

/** Android 侧 NotificationPermissionBridge 的最小能力集合 */
interface NativeNotificationPermissionBridge {
  hasPermission(): boolean;
  isSupported(): boolean;
  requestPermission(): void;
  openSettings(): void;
}

/** 平台通知权限处理器接口（面向接口编程，便于后续扩展其他平台） */
export interface INotificationPermissionHandler {
  /** 当前系统/浏览器是否需要该权限（Android 13+ 且 Bridge 可用时为 true） */
  isSupported(): boolean;
  /** 当前是否已授权（同步查询，底层 Bridge 为同步调用） */
  hasPermission(): boolean;
  /** 请求授权：返回最终是否已授权（用户拒绝 / 系统异常均为 false） */
  requestPermission(): Promise<boolean>;
  /** 打开系统通知设置页（仅 Android 实现） */
  openSettings(): void;
}

/** 获取 Android 通知权限 Bridge（未注入时返回 null，兼容旧包与浏览器环境） */
function getAndroidBridge(): NativeNotificationPermissionBridge | null {
  if (!hasNativeBridge('NotificationPermissionBridge')) return null;
  return (window as any).NotificationPermissionBridge as NativeNotificationPermissionBridge;
}

/** 判定是否为“需要且支持”请求通知权限的场景 */
function isAndroidNotificationPermissionAvailable(): boolean {
  if (!isAndroid()) return false;
  const bridge = getAndroidBridge();
  if (!bridge) return false;
  try {
    return !!bridge.isSupported();
  } catch (e) {
    logError('[NotificationPermission] isSupported 调用失败', { error: String(e) }).catch(() => {});
    return false;
  }
}

/** 本次会话是否已主动弹过权限框（避免每次开始朗读都打扰用户） */
let promptedThisSession = false;

// ============================================================================
// Android 平台实现
// ============================================================================

class AndroidNotificationPermissionHandler implements INotificationPermissionHandler {
  /** 进行中的请求（并发去重用：多个入口同时触发时只为一次系统弹窗） */
  private pendingRequest: Promise<boolean> | null = null;

  isSupported(): boolean {
    return isAndroidNotificationPermissionAvailable();
  }

  hasPermission(): boolean {
    const bridge = getAndroidBridge();
    if (!bridge) return false;
    try {
      return !!bridge.hasPermission();
    } catch (e) {
      // Bridge 异常时按“未授权”处理：只影响通知提示，不影响朗读
      logError('[NotificationPermission] hasPermission 调用失败', { error: String(e) }).catch(() => {});
      return false;
    }
  }

  async requestPermission(): Promise<boolean> {
    const bridge = getAndroidBridge();
    if (!bridge) return false;
    // 已授权或系统无需授权时不再弹框
    if (this.hasPermission()) return true;
    // 并发去重：复用同一次系统弹窗
    if (this.pendingRequest) return this.pendingRequest;

    const request = new Promise<boolean>((resolve) => {
      let settled = false;
      /** 收口：清理回调用具并 resolve，避免重复回调与内存泄漏 */
      const finish = (granted: boolean) => {
        if (settled) return;
        settled = true;
        delete (window as any).__onNotificationPermissionResult__;
        resolve(granted);
      };

      (window as any).__onNotificationPermissionResult__ = (granted: boolean) => finish(!!granted);

      // 兜底：部分 ROM 可能丢失回调，超时后按实际权限状态收口，避免 Promise 永久 pending
      window.setTimeout(() => finish(this.hasPermission()), 60 * 1000);

      try {
        bridge.requestPermission();
      } catch (e) {
        logError('[NotificationPermission] requestPermission 调用失败', { error: String(e) }).catch(() => {});
        finish(this.hasPermission());
      }
    });

    this.pendingRequest = request;
    try {
      return await request;
    } finally {
      // 只在仍是本次请求时清除，避免误清后续请求
      if (this.pendingRequest === request) this.pendingRequest = null;
    }
  }

  openSettings(): void {
    const bridge = getAndroidBridge();
    if (!bridge) return;
    try {
      bridge.openSettings();
    } catch (e) {
      logError('[NotificationPermission] openSettings 调用失败', { error: String(e) }).catch(() => {});
    }
  }
}

// ============================================================================
// 其他平台实现（无需该权限）
// ============================================================================

export class NoopNotificationPermissionHandler implements INotificationPermissionHandler {
  isSupported(): boolean {
    return false;
  }

  hasPermission(): boolean {
    return true;
  }

  async requestPermission(): Promise<boolean> {
    return true;
  }

  openSettings(): void {
    // 非 Android 平台无对应系统设置页
  }
}

// ============================================================================
// 单例与公共 API
// ============================================================================

function createHandler(): INotificationPermissionHandler {
  return isAndroid()
    ? new AndroidNotificationPermissionHandler()
    : new NoopNotificationPermissionHandler();
}

const permissionHandler: INotificationPermissionHandler = createHandler();

/** 当前平台是否需要（且支持）通知权限申请 */
export function isNotificationPermissionSupported(): boolean {
  return permissionHandler.isSupported();
}

/** 当前是否已获得通知权限（非 Android 13+ 恒为 true） */
export function hasNotificationPermission(): boolean {
  return permissionHandler.hasPermission();
}

/**
 * 显式请求通知权限（设置页入口使用，不受“会话内只弹一次”限制）
 * @returns 最终是否已授权
 */
export async function requestNotificationPermission(): Promise<boolean> {
  if (!permissionHandler.isSupported()) return true;
  log('[NotificationPermission] 请求通知权限', 'info');
  const granted = await permissionHandler.requestPermission();
  log(`[NotificationPermission] 请求结果 granted=${granted}`, granted ? 'info' : 'warn');
  return granted;
}

/**
 * 确保拥有通知权限（检查 + 首次按需申请，用于开始朗读前）
 *
 * 注意：结果只用于“是否提示用户后台朗读没有通知”，不得阻塞朗读流程。
 */
export async function ensureNotificationPermission(): Promise<boolean> {
  if (!permissionHandler.isSupported()) return true;
  if (permissionHandler.hasPermission()) return true;
  if (promptedThisSession) return false;
  promptedThisSession = true;
  return requestNotificationPermission();
}

/** 打开系统通知设置页（仅 Android 有效，用于用户已拒绝后的手动开启） */
export function openNotificationSettings(): void {
  permissionHandler.openSettings();
}

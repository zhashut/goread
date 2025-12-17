/**
 * 存储权限检查与请求工具
 * 用于在需要访问存储时按需请求权限
 * 
 * 触发系统原生权限弹窗（Android 标准的三选项弹窗）
 */

import { fileSystemService } from '../services/fileSystemService';

// 权限状态缓存（避免频繁调用原生接口）
let permissionCache: boolean | null = null;
let cacheExpireTimer: ReturnType<typeof setTimeout> | null = null;
const CACHE_EXPIRE_MS = 30 * 1000; // 缓存 30 秒

/**
 * 清除权限缓存（权限状态可能已变化时调用）
 */
export function clearPermissionCache(): void {
    permissionCache = null;
    if (cacheExpireTimer) {
        clearTimeout(cacheExpireTimer);
        cacheExpireTimer = null;
    }
}

/**
 * 通过 Native Bridge 检查权限（优先使用缓存）
 */
export async function checkStoragePermission(): Promise<boolean> {
    // 使用缓存
    if (permissionCache !== null) {
        return permissionCache;
    }

    try {
        // 优先使用 Native Bridge
        if (typeof (window as any).StoragePermissionBridge !== 'undefined') {
            const bridge = (window as any).StoragePermissionBridge;
            permissionCache = bridge.hasPermission();
        } else {
            // 回退到 Tauri command
            permissionCache = await fileSystemService.checkStoragePermission();
        }

        // 设置缓存过期
        if (cacheExpireTimer) clearTimeout(cacheExpireTimer);
        cacheExpireTimer = setTimeout(() => {
            permissionCache = null;
        }, CACHE_EXPIRE_MS);

        return permissionCache ?? false;
    } catch (error) {
        console.error('检查存储权限失败:', error);
        return false;
    }
}

/**
 * 通过 Native Bridge 请求权限
 * 会触发系统原生权限弹窗
 */
export async function requestStoragePermission(): Promise<boolean> {
    try {
        // 优先使用 Native Bridge
        if (typeof (window as any).StoragePermissionBridge !== 'undefined') {
            const bridge = (window as any).StoragePermissionBridge;
            
            // 创建 Promise 监听权限结果回调
            const resultPromise = new Promise<boolean>((resolve) => {
                // 设置回调函数供原生代码调用
                (window as any).__onPermissionResult__ = (granted: boolean) => {
                    clearPermissionCache();
                    resolve(granted);
                    delete (window as any).__onPermissionResult__;
                };
                
                // 设置超时（用户可能长时间不操作）
                setTimeout(() => {
                    if ((window as any).__onPermissionResult__) {
                        clearPermissionCache();
                        // 超时后重新检查权限状态
                        resolve(bridge.hasPermission());
                        delete (window as any).__onPermissionResult__;
                    }
                }, 60000); // 60秒超时
            });
            
            // 触发原生权限请求
            bridge.requestPermission();
            
            return await resultPromise;
        }
        // 回退到 Tauri command
        const result = await fileSystemService.requestStoragePermission();
        clearPermissionCache();
        return result;
    } catch (error) {
        console.error('请求存储权限失败:', error);
        return false;
    }
}

export interface EnsurePermissionOptions {
    /** 是否静默模式（不显示任何提示，仅检查） */
    silent?: boolean;
}

/**
 * 确保拥有存储权限（检查 + 请求）
 * 直接触发系统原生权限弹窗，不再显示自定义弹窗
 * @returns true 表示已获得权限，false 表示用户拒绝或出错
 */
export async function ensureStoragePermission(options?: EnsurePermissionOptions): Promise<boolean> {
    const { silent = false } = options || {};

    try {
        const hasPermission = await checkStoragePermission();
        if (hasPermission) {
            return true;
        }

        if (silent) {
            return false;
        }

        // 直接请求权限，触发系统原生弹窗
        const granted = await requestStoragePermission();
        return granted;
    } catch (error) {
        console.error('权限检查流程失败:', error);
        return false;
    }
}

/**
 * 专用：导入文件前检查权限
 * 直接触发系统原生权限弹窗
 */
export async function ensurePermissionForImport(): Promise<boolean> {
    return ensureStoragePermission();
}

/**
 * 专用：删除本地文件前检查权限
 * 直接触发系统原生权限弹窗
 * @returns allowed: 是否继续操作, downgrade: 是否降级（仅删除记录不删除文件）
 */
export async function ensurePermissionForDeleteLocal(): Promise<{ allowed: boolean; downgrade: boolean }> {
    try {
        const hasPermission = await checkStoragePermission();
        if (hasPermission) {
            return { allowed: true, downgrade: false };
        }

        // 直接请求权限，触发系统原生弹窗
        const granted = await requestStoragePermission();
        if (!granted) {
            // 权限被拒绝，降级处理（仅删除记录，保留本地文件）
            return { allowed: true, downgrade: true };
        }

        return { allowed: true, downgrade: false };
    } catch (error) {
        console.error('删除权限检查流程失败:', error);
        return { allowed: false, downgrade: false };
    }
}

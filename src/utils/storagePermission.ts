/**
 * 存储权限检查与请求工具
 * 用于在需要访问存储时按需请求权限
 * 
 * 平台差异：
 * - Android: 需要运行时动态请求存储权限（READ_EXTERNAL_STORAGE / MANAGE_EXTERNAL_STORAGE）
 * - iOS: 使用沙盒机制，App 沙盒内文件无需权限，外部文件通过 Document Picker 访问
 */

import { fileSystemService } from '../services/fileSystemService';

// ============================================================================
// 平台权限处理接口定义
// ============================================================================

/**
 * 存储权限处理器接口
 * 不同平台实现各自的权限检查和请求逻辑
 */
interface StoragePermissionHandler {
    /** 检查是否拥有存储权限 */
    checkPermission(): Promise<boolean>;
    /** 请求存储权限 */
    requestPermission(): Promise<boolean>;
    /** 清除权限缓存 */
    clearCache(): void;
}

// ============================================================================
// Android 平台实现
// ============================================================================

/**
 * Android 存储权限处理器
 * 通过 Native Bridge 与 Kotlin 代码交互，触发系统原生权限弹窗
 */
class AndroidStoragePermissionHandler implements StoragePermissionHandler {
    private permissionCache: boolean | null = null;
    private cacheExpireTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly CACHE_EXPIRE_MS = 30 * 1000; // 缓存 30 秒

    clearCache(): void {
        this.permissionCache = null;
        if (this.cacheExpireTimer) {
            clearTimeout(this.cacheExpireTimer);
            this.cacheExpireTimer = null;
        }
    }

    async checkPermission(): Promise<boolean> {
        // 使用缓存
        if (this.permissionCache !== null) {
            return this.permissionCache;
        }

        try {
            // 优先使用 Native Bridge
            if (typeof (window as any).StoragePermissionBridge !== 'undefined') {
                const bridge = (window as any).StoragePermissionBridge;
                this.permissionCache = bridge.hasPermission();
            } else {
                // 回退到 Tauri command
                this.permissionCache = await fileSystemService.checkStoragePermission();
            }

            // 设置缓存过期
            if (this.cacheExpireTimer) clearTimeout(this.cacheExpireTimer);
            this.cacheExpireTimer = setTimeout(() => {
                this.permissionCache = null;
            }, this.CACHE_EXPIRE_MS);

            return this.permissionCache ?? false;
        } catch (error) {
            console.error('[Android] 检查存储权限失败:', error);
            return false;
        }
    }

    async requestPermission(): Promise<boolean> {
        try {
            // 优先使用 Native Bridge
            if (typeof (window as any).StoragePermissionBridge !== 'undefined') {
                const bridge = (window as any).StoragePermissionBridge;
                
                // 创建 Promise 监听权限结果回调
                const resultPromise = new Promise<boolean>((resolve) => {
                    // 设置回调函数供原生代码调用
                    (window as any).__onPermissionResult__ = (granted: boolean) => {
                        this.clearCache();
                        resolve(granted);
                        delete (window as any).__onPermissionResult__;
                    };
                    
                    // 设置超时（用户可能长时间不操作）
                    setTimeout(() => {
                        if ((window as any).__onPermissionResult__) {
                            this.clearCache();
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
            this.clearCache();
            return result;
        } catch (error) {
            console.error('[Android] 请求存储权限失败:', error);
            return false;
        }
    }
}

// ============================================================================
// iOS 平台实现
// ============================================================================

/**
 * iOS 存储权限处理器
 * 
 * iOS 使用沙盒机制，与 Android 权限模型完全不同：
 * - App 沙盒内文件：无需任何权限，可自由读写（电子书文件存储在此）
 * - 导入外部文件：通过 UIDocumentPickerViewController（系统文件选择器），用户选择后自动获得访问权限
 * 
 * 对于电子书文件（PDF、EPUB、MOBI 等）的读取，iOS 始终有权限
 */
class IOSStoragePermissionHandler implements StoragePermissionHandler {
    
    clearCache(): void {
        // iOS 无需缓存管理
    }

    async checkPermission(): Promise<boolean> {
        // iOS 沙盒机制下，App 对沙盒内文件始终有访问权限
        // 外部文件通过 Document Picker 访问时，系统会自动处理权限
        console.log('[iOS] 沙盒机制，无需检查存储权限');
        return true;
    }

    async requestPermission(): Promise<boolean> {
        // iOS 不需要主动请求存储权限
        // 文件访问通过 Document Picker 进行，系统自动处理授权
        console.log('[iOS] 沙盒机制，无需请求存储权限');
        return true;
    }
}

// ============================================================================
// 平台检测与处理器选择
// ============================================================================

/**
 * 检测当前运行平台
 */
function detectPlatform(): 'android' | 'ios' | 'unknown' {
    const userAgent = navigator.userAgent.toLowerCase();
    
    // 检测 iOS（iPhone, iPad, iPod）
    if (/iphone|ipad|ipod/.test(userAgent)) {
        return 'ios';
    }
    
    // 检测 Android
    if (/android/.test(userAgent)) {
        return 'android';
    }
    
    // Tauri 环境下的额外检测
    if (typeof (window as any).__TAURI__ !== 'undefined') {
        // 检查是否存在 Android 特有的 Bridge
        if (typeof (window as any).StoragePermissionBridge !== 'undefined') {
            return 'android';
        }
        // 检查是否存在 iOS 特有的 Bridge（如果后续添加）
        if (typeof (window as any).IOSStoragePermissionBridge !== 'undefined') {
            return 'ios';
        }
    }
    
    return 'unknown';
}

/**
 * 获取当前平台对应的权限处理器
 */
function getPermissionHandler(): StoragePermissionHandler {
    const platform = detectPlatform();
    
    switch (platform) {
        case 'ios':
            return new IOSStoragePermissionHandler();
        case 'android':
            return new AndroidStoragePermissionHandler();
        default:
            // 未知平台默认使用 Android 实现（保守策略）
            console.warn('[Permission] 未知平台，使用 Android 权限处理器');
            return new AndroidStoragePermissionHandler();
    }
}

// 单例模式：根据平台创建对应的处理器
const permissionHandler = getPermissionHandler();

// ============================================================================
// 导出的公共 API（保持原有接口不变）
// ============================================================================

/**
 * 清除权限缓存（权限状态可能已变化时调用）
 */
export function clearPermissionCache(): void {
    permissionHandler.clearCache();
}

/**
 * 检查存储权限
 */
export async function checkStoragePermission(): Promise<boolean> {
    return permissionHandler.checkPermission();
}

/**
 * 请求存储权限
 * Android: 触发系统原生权限弹窗
 * iOS: 直接返回 true（沙盒机制无需请求）
 */
export async function requestStoragePermission(): Promise<boolean> {
    return permissionHandler.requestPermission();
}

export interface EnsurePermissionOptions {
    /** 是否静默模式（不显示任何提示，仅检查） */
    silent?: boolean;
}

/**
 * 确保拥有存储权限（检查 + 请求）
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

        // 请求权限
        const granted = await requestStoragePermission();
        return granted;
    } catch (error) {
        console.error('权限检查流程失败:', error);
        return false;
    }
}

/**
 * 专用：导入文件前检查权限
 */
export async function ensurePermissionForImport(): Promise<boolean> {
    return ensureStoragePermission();
}

/**
 * 专用：删除本地文件前检查权限
 * @returns allowed: 是否继续操作, downgrade: 是否降级（仅删除记录不删除文件）
 */
export async function ensurePermissionForDeleteLocal(): Promise<{ allowed: boolean; downgrade: boolean }> {
    try {
        const hasPermission = await checkStoragePermission();
        if (hasPermission) {
            return { allowed: true, downgrade: false };
        }

        // 请求权限
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

// ============================================================================
// 平台信息导出（供调试使用）
// ============================================================================

/**
 * 获取当前平台名称
 */
export function getCurrentPlatform(): string {
    return detectPlatform();
}

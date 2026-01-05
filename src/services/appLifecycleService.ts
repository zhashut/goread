import { logError } from './index';

/**
 * 应用生命周期服务
 * 统一管理前后台状态感知，兼容 Android 和 Web/Desktop 平台
 */

type LifecycleCallback = (isForeground: boolean) => void;

class AppLifecycleService {
    private _isForeground = true;
    private callbacks = new Set<LifecycleCallback>();
    private initialized = false;

    get isForeground(): boolean {
        return this._isForeground;
    }

    /**
     * 初始化生命周期监听
     * 应在应用启动时调用一次
     */
    init() {
        if (this.initialized) return;
        this.initialized = true;

        // Android 原生生命周期事件（来自 MainActivity.kt）
        window.addEventListener("goread:app-pause", this.handlePause);
        window.addEventListener("goread:app-resume", this.handleResume);

        // Web/Desktop 兼容：监听 visibilitychange
        document.addEventListener("visibilitychange", this.handleVisibilityChange);

        // 初始状态
        this._isForeground = !document.hidden;
    }

    /**
     * 销毁监听（通常不需要调用）
     */
    destroy() {
        window.removeEventListener("goread:app-pause", this.handlePause);
        window.removeEventListener("goread:app-resume", this.handleResume);
        document.removeEventListener("visibilitychange", this.handleVisibilityChange);
        this.callbacks.clear();
        this.initialized = false;
    }

    /**
     * 注册状态变化回调
     */
    onStateChange(callback: LifecycleCallback): () => void {
        this.callbacks.add(callback);
        return () => this.callbacks.delete(callback);
    }

    /**
     * 移除状态变化回调
     */
    offStateChange(callback: LifecycleCallback) {
        this.callbacks.delete(callback);
    }

    private handlePause = () => {
        if (!this._isForeground) return;
        this._isForeground = false;
        this.notifyCallbacks();
    };

    private handleResume = () => {
        if (this._isForeground) return;
        this._isForeground = true;
        this.notifyCallbacks();
    };

    private handleVisibilityChange = () => {
        // 在 Android 上，原生事件优先；这里作为备用
        const foreground = !document.hidden;
        if (foreground !== this._isForeground) {
            this._isForeground = foreground;
            this.notifyCallbacks();
        }
    };

    private notifyCallbacks() {
        this.callbacks.forEach((cb) => {
            try {
                cb(this._isForeground);
            } catch (e) {
                logError('[AppLifecycle] Callback error', { error: String(e) }).catch(() => {});
            }
        });
    }
}

export const appLifecycleService = new AppLifecycleService();

// 立即初始化
appLifecycleService.init();

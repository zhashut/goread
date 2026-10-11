/**
 * Status Bar Service
 * Controls the system status bar visibility for mobile platforms (Android/iOS)
 * Uses Android JavascriptInterface bridge for Tauri Android apps,
 * with fallback to browser fullscreen API for web
 * 
 * Note: Status bar should only be hidden in Reader page based on user settings.
 * Other pages (Bookshelf, Settings, etc.) always show status bar.
 */

import { logError } from './index';

// Check if we're running in a Tauri mobile environment
const isTauriMobile = () => {
  const ua = navigator.userAgent || '';
  const isMobile = /Android|iPhone|iPad|iPod/i.test(ua);
  const isTauri = typeof (window as any).__TAURI__ !== 'undefined';
  return isMobile && isTauri;
};

// Check if we're running on Android with the StatusBarBridge
const hasStatusBarBridge = () => {
  return typeof (window as any).StatusBarBridge !== 'undefined';
};

// Check if the bridge is ready (notified by Android)
const isBridgeReady = () => {
  return (window as any).__STATUS_BAR_BRIDGE_READY__ === true;
};

// Check if we're running in a mobile browser (non-Tauri)
const isMobileBrowser = () => {
  const ua = navigator.userAgent || '';
  const isMobile = /Android|iPhone|iPad|iPod/i.test(ua);
  const isTauri = typeof (window as any).__TAURI__ !== 'undefined';
  return isMobile && !isTauri;
};

/**
 * 状态栏图标风格
 * - 'dark'：深色图标，适用于浅色背景的页面
 * - 'light'：浅色图标，适用于深色背景的页面（如阅读页）
 * - 'system'：跟随系统深浅色（应用默认，与主题 windowLightStatusBar 一致）
 */
export type StatusBarIconStyle = 'dark' | 'light' | 'system';

class StatusBarService {
  private initialized = false;
  private bridgeReadyPromise: Promise<void> | null = null;
  private bridgeReadyResolve: (() => void) | null = null;

  /**
   * Initialize the status bar service
   * Should be called early in app lifecycle
   * Note: Does NOT hide status bar on init - only Reader page controls visibility
   */
  async init() {
    if (this.initialized) return;

    // Create a promise that resolves when bridge is ready
    this.bridgeReadyPromise = new Promise((resolve) => {
      this.bridgeReadyResolve = resolve;
    });

    if (hasStatusBarBridge() && isBridgeReady()) {
      // Bridge already ready
      this.initialized = true;
      this.bridgeReadyResolve?.();
    } else if (isTauriMobile()) {
      // Wait for bridge to be ready
      this.waitForBridge();
    } else {
      // Non-mobile or browser
      this.initialized = true;
      this.bridgeReadyResolve?.();
    }
  }

  /**
   * Wait for the Android bridge to be ready
   */
  private waitForBridge() {
    // Listen for the custom event from Android
    const handler = () => {
      window.removeEventListener('statusBarBridgeReady', handler);
      this.onBridgeReady();
    };
    window.addEventListener('statusBarBridgeReady', handler);

    // Also poll in case we missed the event
    let attempts = 0;
    const maxAttempts = 50; // 5 seconds max
    const pollInterval = setInterval(() => {
      attempts++;
      if (hasStatusBarBridge() && isBridgeReady()) {
        clearInterval(pollInterval);
        window.removeEventListener('statusBarBridgeReady', handler);
        this.onBridgeReady();
      } else if (attempts >= maxAttempts) {
        clearInterval(pollInterval);
        window.removeEventListener('statusBarBridgeReady', handler);
        this.initialized = true;
        this.bridgeReadyResolve?.();
      }
    }, 100);
  }

  /**
   * Called when bridge becomes ready
   */
  private onBridgeReady() {
    if (this.initialized) return;
    
    this.initialized = true;
    this.bridgeReadyResolve?.();
  }

  /**
   * Wait for the service to be ready before calling show/hide
   */
  async waitForReady(): Promise<void> {
    if (this.initialized) return;
    await this.bridgeReadyPromise;
  }

  /**
   * 应用状态栏设置（可见性 + 图标风格）
   * @param showStatusBar - Whether to show the system status bar
   * @param iconStyle - 图标明暗风格，需与状态栏下方的页面背景保持一致；'system' 表示跟随系统
   */
  async applySettings(showStatusBar: boolean, iconStyle: StatusBarIconStyle) {
    try {
      await this.waitForReady();
      if (showStatusBar) {
        await this.showStatusBar();
      } else {
        await this.hideStatusBar();
      }
      // 必须在显示之后再设置图标风格：部分 ROM 在重新显示状态栏时会重置外观
      await this.setIconAppearance(iconStyle);
    } catch (error) {
      logError('[StatusBar] Apply settings failed', { error: String(error), showStatusBar, iconStyle }).catch(() => {});
    }
  }

  /**
   * 设置状态栏图标明暗
   * 状态栏图标由系统绘制，Android 上仅能切换深/浅两套配色，无法自定义颜色
   * @param style - 'dark' 对应浅色背景，'light' 对应深色背景，'system' 跟随系统
   */
  async setIconAppearance(style: StatusBarIconStyle) {
    try {
      if (hasStatusBarBridge()) {
        if (style === 'system') {
          (window as any).StatusBarBridge.resetAppearance();
        } else {
          // Android JavascriptInterface：参数为是否使用深色图标
          (window as any).StatusBarBridge.setAppearance(style === 'dark');
        }
      }
    } catch (error) {
      logError('[StatusBar] Set icon appearance failed', { error: String(error), style }).catch(() => {});
    }
  }

  /**
   * Show the system status bar
   */
  async showStatusBar() {
    try {
      if (hasStatusBarBridge()) {
        // Use Android JavascriptInterface bridge
        (window as any).StatusBarBridge.show();
      } else if (isMobileBrowser()) {
        // Fallback: Exit fullscreen for mobile browsers
        if (document.fullscreenElement) {
          await document.exitFullscreen?.().catch(() => {});
        }
      }
    } catch (error) {
      logError('[StatusBar] Show failed', { error: String(error) }).catch(() => {});
    }
  }

  /**
   * Hide the system status bar
   */
  async hideStatusBar() {
    try {
      if (hasStatusBarBridge()) {
        // Use Android JavascriptInterface bridge
        (window as any).StatusBarBridge.hide();
      } else if (isMobileBrowser()) {
        // Fallback: Enter fullscreen for mobile browsers
        if (!document.fullscreenElement) {
          await document.documentElement.requestFullscreen?.().catch(() => {});
        }
      }
    } catch (error) {
      logError('[StatusBar] Hide failed', { error: String(error) }).catch(() => {});
    }
  }

  /**
   * Get current status bar visibility
   */
  isVisible(): boolean {
    try {
      if (hasStatusBarBridge()) {
        return (window as any).StatusBarBridge.isVisible();
      }
    } catch (error) {
      logError('[StatusBar] isVisible failed', { error: String(error) }).catch(() => {});
    }
    return true;
  }
}

export const statusBarService = new StatusBarService();

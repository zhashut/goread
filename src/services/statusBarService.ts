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
   * Apply status bar settings (for Reader page only)
   * @param showStatusBar - Whether to show the system status bar
   */
  async applySettings(showStatusBar: boolean) {
    try {
      await this.waitForReady();
      if (showStatusBar) {
        await this.showStatusBar();
      } else {
        await this.hideStatusBar();
      }
    } catch (error) {
      logError('[StatusBar] Apply settings failed', { error: String(error), showStatusBar }).catch(() => {});
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

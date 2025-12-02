// Type declaration for Android native safe area insets injected via window object
declare global {
  interface Window {
    __SAFE_AREA_INSETS__?: {
      top: number;
      bottom: number;
      left: number;
      right: number;
    };
  }
}

const isAndroid = /Android/i.test(navigator.userAgent);

/**
 * Initialize safe area insets watching for Android.
 * Call this early in your app lifecycle (e.g., in main.tsx).
 * This sets up a MutationObserver to detect when native code injects CSS variables.
 */
export const initSafeAreaInsets = () => {
  if (!isAndroid) return;
  
  // For Android, poll for native-injected CSS variables until they're set
  // This handles the race condition between native injection and React render
  const checkAndApplyInsets = () => {
    const root = document.documentElement;
    const currentTop = getComputedStyle(root).getPropertyValue('--safe-area-inset-top').trim();
    
    // If CSS variables are not yet injected, check window object for native values
    if ((!currentTop || currentTop === '0px') && window.__SAFE_AREA_INSETS__) {
      root.style.setProperty('--safe-area-inset-top', `${window.__SAFE_AREA_INSETS__.top}px`);
      root.style.setProperty('--safe-area-inset-bottom', `${window.__SAFE_AREA_INSETS__.bottom}px`);
      console.log('[SafeArea] Applied from window object:', window.__SAFE_AREA_INSETS__);
    }
  };
  
  // Check immediately
  checkAndApplyInsets();
  
  // Also check after a short delay (for initial page load)
  setTimeout(checkAndApplyInsets, 50);
  setTimeout(checkAndApplyInsets, 200);
  setTimeout(checkAndApplyInsets, 500);
};

/**
 * Returns CSS values for safe area insets that can be used in inline styles.
 * - For Android: Uses CSS variables injected by native MainActivity via WindowInsets API
 * - For iOS: Uses standard env() function which works correctly in WKWebView
 */
export const getSafeAreaInsets = () => {
  // Android: Use CSS variables injected by native MainActivity via WindowInsets API
  // iOS: Use standard env() function which works correctly in WKWebView
  const top = isAndroid
    ? "var(--safe-area-inset-top, 0px)"
    : "env(safe-area-inset-top, 0px)";
  const bottom = isAndroid
    ? "var(--safe-area-inset-bottom, 0px)"
    : "env(safe-area-inset-bottom, 0px)";
  
  return {
    top,
    bottom,
  };
};

// 通过 window 对象注入的 Android 原生安全区域声明
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
 * 初始化 Android 安全区域监听。
 * 请在应用生命周期早期调用（例如 main.tsx）。
 * 这将检测原生代码何时注入 CSS 变量。
 */
export const initSafeAreaInsets = () => {
  if (!isAndroid) return;
  
  // 针对 Android，轮询检测原生注入的 CSS 变量，直到设置完成
  // 这处理了原生注入和 React 渲染之间的竞态条件
  const checkAndApplyInsets = () => {
    const root = document.documentElement;
    const currentTop = getComputedStyle(root).getPropertyValue('--safe-area-inset-top').trim();
    
    // 如果 CSS 变量尚未注入，检查 window 对象中的原生值
    if ((!currentTop || currentTop === '0px') && window.__SAFE_AREA_INSETS__) {
      root.style.setProperty('--safe-area-inset-top', `${window.__SAFE_AREA_INSETS__.top}px`);
      root.style.setProperty('--safe-area-inset-bottom', `${window.__SAFE_AREA_INSETS__.bottom}px`);
      console.log('[SafeArea] Applied from window object:', window.__SAFE_AREA_INSETS__);
    }
  };
  
  // 立即检查
  checkAndApplyInsets();
  
  // 延时检查（针对初始页面加载）
  setTimeout(checkAndApplyInsets, 50);
  setTimeout(checkAndApplyInsets, 200);
  setTimeout(checkAndApplyInsets, 500);
};

/**
 * 返回可用于内联样式的安全区域 CSS 值。
 * - Android: 使用原生 MainActivity 通过 WindowInsets API 注入的 CSS 变量
 * - iOS: 使用在 WKWebView 中正常工作的标准 env() 函数
 */
export const getSafeAreaInsets = () => {
  // Android: 使用原生 MainActivity 通过 WindowInsets API 注入的 CSS 变量
  // iOS: 使用在 WKWebView 中正常工作的标准 env() 函数
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

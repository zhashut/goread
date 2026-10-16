// 通过 window 对象注入的 Android 原生安全区域声明
// 结构为「CSS 变量名 -> CSS px」，与原生 MainActivity.buildSafeAreaVars 一一对应：
// --safe-area-inset-*（系统安全区，顶部已取状态栏与挖孔的较大者）
// --display-cutout-inset-*（纯物理遮挡，沉浸模式下仍需避让）
declare global {
  interface Window {
    __SAFE_AREA_INSETS__?: Record<string, number>;
  }
}

const isAndroid = /Android/i.test(navigator.userAgent);

/**
 * 把原生声明的安全区数据补齐到 CSS 变量
 * 原生注入与 React 渲染存在竞态：变量尚未写入或仍为默认 0px 时用 window 上的数据补齐，
 * 已有非 0 值时跳过，避免用旧值覆盖原生刚写入的新值
 */
const syncNativeSafeAreaInsets = () => {
  const insets = window.__SAFE_AREA_INSETS__;
  if (!insets) return;

  const root = document.documentElement;
  const computed = getComputedStyle(root);
  for (const [name, value] of Object.entries(insets)) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const current = computed.getPropertyValue(name).trim();
    if (current && current !== "0px") continue;
    root.style.setProperty(name, `${value}px`);
  }
};

/**
 * 初始化 Android 安全区域监听。
 * 请在应用生命周期早期调用（例如 main.tsx）。
 * 这将检测原生代码何时注入 CSS 变量。
 */
export const initSafeAreaInsets = () => {
  if (!isAndroid) return;
  
  // 针对 Android，轮询检测原生注入，直到写入完成
  // 这处理了原生注入和 React 渲染之间的竞态条件
  syncNativeSafeAreaInsets();
  
  // 延时检查（针对初始页面加载）
  setTimeout(syncNativeSafeAreaInsets, 50);
  setTimeout(syncNativeSafeAreaInsets, 200);
  setTimeout(syncNativeSafeAreaInsets, 500);
};

/**
 * 返回可用于内联样式的安全区域 CSS 值。
 * - Android: 使用原生 MainActivity 通过 WindowInsets API 注入的 CSS 变量
 *   （顶部已取「状态栏高度」与「挖孔遮挡」的较大者）
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

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initSafeAreaInsets } from "./utils/layout";
import { statusBarService } from "./services/statusBarService";
import { volumeKeyService } from "./services/volumeKeyService";
import { preloadCoverRoot } from "./hooks/useCover";
import { syncDiskCacheConfig } from "./constants/cache";
import i18n from "./locales";
import { getReaderSettings, ReaderSettings } from "./services";
import { getSystemAppLanguage, AppLanguage } from "./services/systemLanguageService";

// 抑制 ResizeObserver loop 错误（常见的浏览器警告，不影响功能）
const resizeObserverErr = (e: ErrorEvent) => {
  if (e.message === 'ResizeObserver loop completed with undelivered notifications.') {
    e.stopImmediatePropagation();
  }
};
window.addEventListener('error', resizeObserverErr);

// 提前初始化安全区域（在 React 渲染之前）
initSafeAreaInsets();

/**
 * 解析初始语言设置
 * - 用户显式选择 zh/en：直接使用
 * - 用户选择 system 或未设置：跟随系统语言
 */
async function resolveInitialLanguage(settings: ReaderSettings): Promise<AppLanguage> {
  // 情况 1：用户显式选择了 zh/en
  if (settings.language === 'zh' || settings.language === 'en') {
    return settings.language;
  }

  // 情况 2：system 或未设置 => 跟随系统
  const sysLang = await getSystemAppLanguage();
  return sysLang;
}

// 等待Tauri API加载
const setupApp = async () => {
  try {
    // 初始化语言设置：优先使用用户设置，否则跟随系统语言
    const settings = getReaderSettings();
    const initialLang = await resolveInitialLanguage(settings);
    await i18n.changeLanguage(initialLang);

    // 动态导入Tauri API
    await import('@tauri-apps/api/core');
    
    // 初始化移动平台的状态栏服务
    await statusBarService.init();
    
    // 初始化音量键翻页服务
    await volumeKeyService.init();
    
    // 预加载封面根目录路径（提高首页封面显示速度）
    preloadCoverRoot().catch(() => {});
    
    // 同步缓存配置到后端
    syncDiskCacheConfig().catch(() => {});
    
    try {
      const { logError } = await import('./services');
      window.addEventListener('error', async (e) => {
        try { await logError('window error', { message: e.message, filename: e.filename, lineno: e.lineno, colno: e.colno }); } catch {}
      });
      window.addEventListener('unhandledrejection', async (e) => {
        try { await logError('unhandled rejection', { reason: String(e.reason) }); } catch {}
      });
    } catch {}
    
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  } catch (error) {
    // 即使Tauri API加载失败，也要渲染应用
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  }
};

setupApp();

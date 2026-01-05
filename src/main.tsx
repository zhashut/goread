import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initSafeAreaInsets } from "./utils/layout";
import { statusBarService } from "./services/statusBarService";
import { volumeKeyService } from "./services/volumeKeyService";
import i18n, { getSystemLanguage } from "./locales";
import { getReaderSettings } from "./services";

// 抑制 ResizeObserver loop 错误（常见的浏览器警告，不影响功能）
const resizeObserverErr = (e: ErrorEvent) => {
  if (e.message === 'ResizeObserver loop completed with undelivered notifications.') {
    e.stopImmediatePropagation();
  }
};
window.addEventListener('error', resizeObserverErr);

// 提前初始化安全区域（在 React 渲染之前）
initSafeAreaInsets();

// 等待Tauri API加载
const setupApp = async () => {
  try {
    // 初始化语言设置：优先使用用户设置，否则使用系统语言
    const settings = getReaderSettings();
    if (settings.language) {
      i18n.changeLanguage(settings.language);
    } else {
      // 首次使用，检测系统语言
      const systemLang = getSystemLanguage();
      i18n.changeLanguage(systemLang);
    }

    // 动态导入Tauri API
    await import('@tauri-apps/api/core');
    
    // 初始化移动平台的状态栏服务
    await statusBarService.init();
    
    // 初始化音量键翻页服务
    await volumeKeyService.init();
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

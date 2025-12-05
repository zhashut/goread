import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initSafeAreaInsets } from "./utils/layout";
import { statusBarService } from "./services/statusBarService";

// 提前初始化安全区域（在 React 渲染之前）
initSafeAreaInsets();

// 等待Tauri API加载
const setupApp = async () => {
  try {
    // 动态导入Tauri API
    await import('@tauri-apps/api/core');
    console.log('Tauri API loaded successfully');
    
    // 初始化移动平台的状态栏服务
    await statusBarService.init();
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
    console.error('Failed to load Tauri API:', error);
    // 即使Tauri API加载失败，也要渲染应用
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  }
};

setupApp();

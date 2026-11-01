import { RouterProvider } from 'react-router-dom';
import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { router } from './router';
import ErrorBoundary from './components/ErrorBoundary';
import { PageTransitionProvider } from './router/PageTransitionProvider';
import { useSystemLanguageSync } from './hooks/useSystemLanguageSync';
import './App.css';
import './utils/polyfills';

function App() {
  // 监听应用从后台返回，自动同步系统语言
  useSystemLanguageSync();

  // 会话启动兜底：确保 WiFi 传书服务不因页面整页刷新（dev HMR / webview 重载）
  // 而在无界面归属的情况下残留运行；应用冷启动时后端服务本就未启动，此调用为幂等空操作
  useEffect(() => {
    invoke('wifi_transfer_stop').catch(() => {});
  }, []);

  return (
    <ErrorBoundary>
      <PageTransitionProvider>
        <RouterProvider router={router} />
      </PageTransitionProvider>
    </ErrorBoundary>
  );
}

export default App;

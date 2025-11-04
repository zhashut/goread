import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// 等待Tauri API加载
const setupApp = async () => {
  try {
    // 动态导入Tauri API
    const { invoke } = await import('@tauri-apps/api/core');
    console.log('Tauri API loaded successfully');
    
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

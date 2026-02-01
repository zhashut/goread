/**
 * 公共服务模块
 * 提供 Tauri invoke 和日志等基础工具函数
 */

// 动态解析 Tauri invoke（兼容 v1 / v2 / 浏览器预览）
const loadTauriAPI = async () => {
  // 1) 先用 window.__TAURI__ 注入的 invoke（WebView 环境最稳）
  const tauriAny = (window as any).__TAURI__;
  const v1Invoke = tauriAny?.invoke;
  if (typeof v1Invoke === 'function') {
    return v1Invoke as (cmd: string, args?: any) => Promise<any>;
  }
  const v2Invoke = tauriAny?.core?.invoke;
  if (typeof v2Invoke === 'function') {
    return v2Invoke as (cmd: string, args?: any) => Promise<any>;
  }

  // 2) 再尝试按包导入（开发者可能安装了 v1 或 v2 的包）
  try {
    const apiMod = await import('@tauri-apps/api').catch(() => null as any);
    if (apiMod && typeof (apiMod as any).invoke === 'function') {
      return (apiMod as any).invoke as (cmd: string, args?: any) => Promise<any>;
    }
  } catch { }

  try {
    const coreMod = await import('@tauri-apps/api/core').catch(() => null as any);
    if (coreMod && typeof (coreMod as any).invoke === 'function') {
      return (coreMod as any).invoke as (cmd: string, args?: any) => Promise<any>;
    }
  } catch { }

  // 3) 浏览器预览环境：返回 mock，避免页面因未找到 invoke 而报错
  return async (cmd: string, _args?: any) => {
    if (cmd === 'get_all_books') return [];
    if (cmd === 'init_database') return;
    return null;
  };
};

// 延迟加载invoke函数
let invokePromise: Promise<any> | null = null;
export const getInvoke = async (): Promise<<T = any>(cmd: string, args?: any) => Promise<T>> => {
  if (!invokePromise) {
    invokePromise = loadTauriAPI();
  }
  return await invokePromise;
};

// 日志工具函数
export const log = async (message: string, level: 'info' | 'warn' | 'error' = 'info', context?: any) => {
  const invoke = await getInvoke();
  await invoke('frontend_log', {
    level,
    message,
    context: context ? JSON.stringify(context) : undefined
  }).catch(() => { }); // 忽略日志错误
};

// 错误日志函数
export const logError = async (message: string, context?: any) => {
  const invoke = await getInvoke();
  try {
    await invoke('frontend_log', {
      level: 'error',
      message,
      context: context ? JSON.stringify(context) : null,
    });
  } catch { }
};

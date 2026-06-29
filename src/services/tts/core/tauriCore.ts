/** Tauri core 接口：invoke + addPluginListener */
export interface TauriCore {
  invoke: (cmd: string, args?: any) => Promise<any>;
  addPluginListener?: (
    plugin: string,
    event: string,
    handler: (payload: any) => void,
  ) => Promise<any>;
}

/**
 * 加载 Tauri core 模块：优先 import，回退到 window.__TAURI__ 注入对象。
 * 若两者都不可用返回 null。
 */
export async function loadTauriCore(): Promise<TauriCore | null> {
  const w = window as any;
  const injectedInvoke = w?.__TAURI__?.core?.invoke || w?.__TAURI__?.invoke;
  const injectedAddPluginListener =
    w?.__TAURI__?.core?.addPluginListener || w?.__TAURI__?.addPluginListener;
  const invokeFromWindow =
    typeof injectedInvoke === 'function'
      ? (injectedInvoke as (cmd: string, args?: any) => Promise<any>)
      : null;
  const addPluginListenerFromWindow =
    typeof injectedAddPluginListener === 'function' ? injectedAddPluginListener : null;
  try {
    const coreMod = await import('@tauri-apps/api/core').catch(() => null as any);
    const invoke = (coreMod as any)?.invoke;
    const addPluginListener = (coreMod as any)?.addPluginListener;
    const finalInvoke = typeof invoke === 'function' ? invoke : invokeFromWindow;
    const finalAddPluginListener =
      typeof addPluginListener === 'function'
        ? addPluginListener
        : addPluginListenerFromWindow;
    if (typeof finalInvoke !== 'function') return null;
    return {
      invoke: finalInvoke,
      addPluginListener: finalAddPluginListener || undefined,
    };
  } catch {
    if (invokeFromWindow) {
      return {
        invoke: invokeFromWindow,
        addPluginListener: addPluginListenerFromWindow || undefined,
      };
    }
    return null;
  }
}


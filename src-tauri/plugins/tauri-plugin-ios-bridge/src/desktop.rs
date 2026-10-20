use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

/// 非 iOS 平台（Windows/macOS/Linux 及 Android）的 no-op 桥接。
/// 桥接实现全部由 iOS 原生侧提供，这里只为让调用方在任意平台都能统一依赖该插件。
pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<IosBridge<R>> {
    Ok(IosBridge(app.clone()))
}

pub struct IosBridge<R: Runtime>(AppHandle<R>);

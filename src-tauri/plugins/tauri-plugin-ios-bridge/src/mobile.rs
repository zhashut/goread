use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_ios_bridge);

/// 仅 iOS 参与编译（模块 cfg 见 lib.rs），其它平台走 desktop.rs 的 no-op token。
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<IosBridge<R>> {
    let handle = api.register_ios_plugin(init_plugin_ios_bridge)?;
    Ok(IosBridge(handle))
}

pub struct IosBridge<R: Runtime>(PluginHandle<R>);

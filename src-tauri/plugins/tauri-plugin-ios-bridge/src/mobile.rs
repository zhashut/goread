use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_ios_bridge);

pub fn init<R: Runtime, C>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<IosBridge<R>> {
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_ios_bridge)?;
    #[cfg(not(target_os = "ios"))]
    let handle = api.register_android_plugin("com.tauri_app.ios_bridge", "IOSBridgePlugin")?;
    Ok(IosBridge(handle))
}

pub struct IosBridge<R: Runtime>(PluginHandle<R>);

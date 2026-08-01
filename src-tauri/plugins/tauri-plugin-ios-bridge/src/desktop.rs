use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

/// Desktop (Windows/macOS/Linux) no-op bridge. All bridging is iOS-only; on
/// desktop platforms this token exists solely so the app can depend uniformly
/// on the plugin.
pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<IosBridge<R>> {
    Ok(IosBridge(app.clone()))
}

pub struct IosBridge<R: Runtime>(AppHandle<R>);

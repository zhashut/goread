use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

// 桥接实现全部在 iOS 原生侧，因此仅 iOS 使用 mobile 实现；
// Android 与桌面同走 desktop 的 no-op token（Android 侧无对应原生插件类）。
#[cfg(not(target_os = "ios"))]
mod desktop;
#[cfg(target_os = "ios")]
mod mobile;

mod error;

pub use error::{Error, Result};

#[cfg(not(target_os = "ios"))]
use desktop::IosBridge;
#[cfg(target_os = "ios")]
use mobile::IosBridge;

/// Token exposed on the app state so the frontend can rely on the plugin being
/// registered. The actual JS bridging is injected natively on iOS; on other
/// platforms this is a no-op.
pub trait IosBridgeExt<R: Runtime> {
    fn ios_bridge(&self) -> &IosBridge<R>;
}

impl<R: Runtime, T: Manager<R>> IosBridgeExt<R> for T {
    fn ios_bridge(&self) -> &IosBridge<R> {
        self.state::<IosBridge<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("ios-bridge")
        .setup(|app, api| {
            #[cfg(target_os = "ios")]
            let bridge = mobile::init(app, api)?;
            #[cfg(not(target_os = "ios"))]
            let bridge = desktop::init(app, api)?;
            app.manage(bridge);
            Ok(())
        })
        .build()
}

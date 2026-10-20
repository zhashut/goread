use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod desktop;
#[cfg(any(target_os = "android", target_os = "ios"))]
mod mobile;

mod error;

pub use error::{Error, Result};

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use desktop::IosBridge;
#[cfg(any(target_os = "android", target_os = "ios"))]
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
            #[cfg(any(target_os = "android", target_os = "ios"))]
            let bridge = mobile::init(app, api)?;
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            let bridge = desktop::init(app, api)?;
            app.manage(bridge);
            Ok(())
        })
        .build()
}

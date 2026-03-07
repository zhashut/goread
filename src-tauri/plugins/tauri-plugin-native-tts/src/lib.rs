use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

pub use models::*;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod desktop;
#[cfg(any(target_os = "android", target_os = "ios"))]
mod mobile;

mod commands;
mod error;
mod models;

pub use error::{Error, Result};

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use desktop::NativeTts;
#[cfg(any(target_os = "android", target_os = "ios"))]
use mobile::NativeTts;

pub trait NativeTtsExt<R: Runtime> {
    fn native_tts(&self) -> &NativeTts<R>;
}

impl<R: Runtime, T: Manager<R>> NativeTtsExt<R> for T {
    fn native_tts(&self) -> &NativeTts<R> {
        self.state::<NativeTts<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("native-tts")
        .invoke_handler(tauri::generate_handler![
            commands::init,
            commands::speak,
            commands::stop,
            commands::pause,
            commands::resume,
            commands::set_rate,
            commands::set_voice,
            commands::get_all_voices,
            commands::open_tts_settings,
            commands::install_tts_data,
            commands::shutdown,
        ])
        .setup(|app, api| {
            #[cfg(any(target_os = "android", target_os = "ios"))]
            let native_tts = mobile::init(app, api)?;
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            let native_tts = desktop::init(app, api)?;
            app.manage(native_tts);
            Ok(())
        })
        .build()
}

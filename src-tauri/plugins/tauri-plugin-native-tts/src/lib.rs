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
            commands::set_rate,
            commands::set_voice,
            commands::get_all_voices,
            commands::set_media_session_active,
            commands::open_tts_settings,
            commands::install_tts_data,
            commands::shutdown,
            commands::tts_session_start,
            commands::tts_session_push,
            commands::tts_session_stop,
            commands::tts_session_pause,
            commands::tts_session_resume,
            commands::tts_session_set_rate,
            commands::tts_session_set_voice,
            commands::tts_session_set_end_of_book,
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


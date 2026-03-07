use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::*;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_native_tts);

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<NativeTts<R>> {
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin("com.tauri_app.native_tts", "NativeTTSPlugin")?;
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_native_tts)?;
    Ok(NativeTts(handle))
}

pub struct NativeTts<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> NativeTts<R> {
    pub fn init(&self, payload: InitArgs) -> crate::Result<InitResponse> {
        self.0.run_mobile_plugin("init", payload).map_err(Into::into)
    }

    pub fn speak(&self, payload: SpeakArgs) -> crate::Result<SpeakResponse> {
        self.0.run_mobile_plugin("speak", payload).map_err(Into::into)
    }

    pub fn pause(&self) -> crate::Result<()> {
        self.0.run_mobile_plugin("pause", ()).map_err(Into::into)
    }

    pub fn resume(&self) -> crate::Result<()> {
        self.0.run_mobile_plugin("resume", ()).map_err(Into::into)
    }

    pub fn stop(&self) -> crate::Result<()> {
        self.0.run_mobile_plugin("stop", ()).map_err(Into::into)
    }

    pub fn set_rate(&self, payload: SetRateArgs) -> crate::Result<()> {
        self.0.run_mobile_plugin("set_rate", payload).map_err(Into::into)
    }

    pub fn set_voice(&self, payload: SetVoiceArgs) -> crate::Result<()> {
        self.0.run_mobile_plugin("set_voice", payload).map_err(Into::into)
    }

    pub fn get_all_voices(&self) -> crate::Result<GetVoicesResponse> {
        self.0
            .run_mobile_plugin("get_all_voices", ())
            .map_err(Into::into)
    }

    pub fn open_tts_settings(&self) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("open_tts_settings", ())
            .map_err(Into::into)
    }

    pub fn install_tts_data(&self) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("install_tts_data", ())
            .map_err(Into::into)
    }

    pub fn shutdown(&self) -> crate::Result<()> {
        self.0.run_mobile_plugin("shutdown", ()).map_err(Into::into)
    }
}

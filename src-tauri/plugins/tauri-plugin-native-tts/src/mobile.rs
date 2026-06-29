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

    pub fn set_rate(&self, payload: SetRateArgs) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("set_rate", payload)
            .map_err(Into::into)
    }

    pub fn set_voice(&self, payload: SetVoiceArgs) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("set_voice", payload)
            .map_err(Into::into)
    }

    pub fn get_all_voices(&self) -> crate::Result<GetVoicesResponse> {
        self.0
            .run_mobile_plugin("get_all_voices", ())
            .map_err(Into::into)
    }

    pub fn set_media_session_active(
        &self,
        payload: SetMediaSessionActiveRequest,
    ) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("set_media_session_active", payload)
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
        self.0
            .run_mobile_plugin("shutdown", ())
            .map_err(Into::into)
    }

    pub fn tts_session_start(&self, payload: TTSSessionStartRequest) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("tts_session_start", payload)
            .map_err(Into::into)
    }

    pub fn tts_session_push(&self, payload: TTSSessionPushRequest) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("tts_session_push", payload)
            .map_err(Into::into)
    }

    pub fn tts_session_stop(&self) -> crate::Result<()> {
        self.tts_session_stop_with_request(TTSSessionStopRequest {
            emit_stopped_event: true,
        })
    }

    pub fn tts_session_stop_with_request(
        &self,
        payload: TTSSessionStopRequest,
    ) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("tts_session_stop", payload)
            .map_err(Into::into)
    }

    pub fn tts_session_pause(&self) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("tts_session_pause", ())
            .map_err(Into::into)
    }

    pub fn tts_session_resume(&self) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("tts_session_resume", ())
            .map_err(Into::into)
    }

    pub fn tts_session_set_rate(&self, payload: SetRateArgs) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("tts_session_set_rate", payload)
            .map_err(Into::into)
    }

    pub fn tts_session_set_voice(&self, payload: SetVoiceArgs) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("tts_session_set_voice", payload)
            .map_err(Into::into)
    }

    pub fn tts_session_set_end_of_book(
        &self,
        payload: TTSSessionSetEndOfBookRequest,
    ) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("tts_session_set_end_of_book", payload)
            .map_err(Into::into)
    }
}


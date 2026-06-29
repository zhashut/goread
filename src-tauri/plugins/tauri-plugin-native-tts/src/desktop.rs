use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::*;

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<NativeTts<R>> {
    Ok(NativeTts(app.clone()))
}

pub struct NativeTts<R: Runtime>(AppHandle<R>);

impl<R: Runtime> NativeTts<R> {
    pub fn init(&self, _payload: InitArgs) -> crate::Result<InitResponse> {
        Err(crate::Error::UnsupportedPlatformError)
    }
    pub fn set_rate(&self, _payload: SetRateArgs) -> crate::Result<()> {
        Err(crate::Error::UnsupportedPlatformError)
    }
    pub fn set_voice(&self, _payload: SetVoiceArgs) -> crate::Result<()> {
        Err(crate::Error::UnsupportedPlatformError)
    }
    pub fn get_all_voices(&self) -> crate::Result<GetVoicesResponse> {
        Err(crate::Error::UnsupportedPlatformError)
    }
    pub fn set_media_session_active(
        &self,
        _payload: SetMediaSessionActiveRequest,
    ) -> crate::Result<()> {
        Err(crate::Error::UnsupportedPlatformError)
    }
    pub fn open_tts_settings(&self) -> crate::Result<()> {
        Err(crate::Error::UnsupportedPlatformError)
    }
    pub fn install_tts_data(&self) -> crate::Result<()> {
        Err(crate::Error::UnsupportedPlatformError)
    }
    pub fn shutdown(&self) -> crate::Result<()> {
        Err(crate::Error::UnsupportedPlatformError)
    }
    pub fn tts_session_start(&self, _payload: TTSSessionStartRequest) -> crate::Result<()> {
        Err(crate::Error::UnsupportedPlatformError)
    }
    pub fn tts_session_push(&self, _payload: TTSSessionPushRequest) -> crate::Result<()> {
        Err(crate::Error::UnsupportedPlatformError)
    }
    pub fn tts_session_stop(&self) -> crate::Result<()> {
        Err(crate::Error::UnsupportedPlatformError)
    }
    pub fn tts_session_stop_with_request(
        &self,
        _payload: TTSSessionStopRequest,
    ) -> crate::Result<()> {
        Err(crate::Error::UnsupportedPlatformError)
    }
    pub fn tts_session_pause(&self) -> crate::Result<()> {
        Err(crate::Error::UnsupportedPlatformError)
    }
    pub fn tts_session_resume(&self) -> crate::Result<()> {
        Err(crate::Error::UnsupportedPlatformError)
    }
    pub fn tts_session_set_rate(&self, _payload: SetRateArgs) -> crate::Result<()> {
        Err(crate::Error::UnsupportedPlatformError)
    }
    pub fn tts_session_set_voice(&self, _payload: SetVoiceArgs) -> crate::Result<()> {
        Err(crate::Error::UnsupportedPlatformError)
    }
    pub fn tts_session_set_end_of_book(
        &self,
        _payload: TTSSessionSetEndOfBookRequest,
    ) -> crate::Result<()> {
        Err(crate::Error::UnsupportedPlatformError)
    }
}


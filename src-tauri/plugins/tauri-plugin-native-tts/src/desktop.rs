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
    pub fn speak(&self, _payload: SpeakArgs) -> crate::Result<SpeakResponse> {
        Err(crate::Error::UnsupportedPlatformError)
    }
    pub fn pause(&self) -> crate::Result<()> {
        Err(crate::Error::UnsupportedPlatformError)
    }
    pub fn resume(&self) -> crate::Result<()> {
        Err(crate::Error::UnsupportedPlatformError)
    }
    pub fn stop(&self) -> crate::Result<()> {
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
    pub fn open_tts_settings(&self) -> crate::Result<()> {
        Err(crate::Error::UnsupportedPlatformError)
    }
    pub fn install_tts_data(&self) -> crate::Result<()> {
        Err(crate::Error::UnsupportedPlatformError)
    }
    pub fn shutdown(&self) -> crate::Result<()> {
        Err(crate::Error::UnsupportedPlatformError)
    }
}


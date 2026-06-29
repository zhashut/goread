use tauri::{command, AppHandle, Runtime};

use crate::models::*;
use crate::NativeTtsExt;
use crate::Result;

#[command]
pub(crate) async fn init<R: Runtime>(app: AppHandle<R>, payload: InitArgs) -> Result<InitResponse> {
    app.native_tts().init(payload)
}

#[command]
pub(crate) async fn set_rate<R: Runtime>(app: AppHandle<R>, payload: SetRateArgs) -> Result<()> {
    app.native_tts().set_rate(payload)
}

#[command]
pub(crate) async fn set_voice<R: Runtime>(app: AppHandle<R>, payload: SetVoiceArgs) -> Result<()> {
    app.native_tts().set_voice(payload)
}

#[command]
pub(crate) async fn get_all_voices<R: Runtime>(app: AppHandle<R>) -> Result<GetVoicesResponse> {
    app.native_tts().get_all_voices()
}

#[command]
pub(crate) async fn set_media_session_active<R: Runtime>(
    app: AppHandle<R>,
    payload: SetMediaSessionActiveRequest,
) -> Result<()> {
    app.native_tts().set_media_session_active(payload)
}

#[command]
pub(crate) async fn open_tts_settings<R: Runtime>(app: AppHandle<R>) -> Result<()> {
    app.native_tts().open_tts_settings()
}

#[command]
pub(crate) async fn install_tts_data<R: Runtime>(app: AppHandle<R>) -> Result<()> {
    app.native_tts().install_tts_data()
}

#[command]
pub(crate) async fn shutdown<R: Runtime>(app: AppHandle<R>) -> Result<()> {
    app.native_tts().shutdown()
}

#[command]
pub(crate) async fn tts_session_start<R: Runtime>(
    app: AppHandle<R>,
    payload: TTSSessionStartRequest,
) -> Result<()> {
    app.native_tts().tts_session_start(payload)
}

#[command]
pub(crate) async fn tts_session_push<R: Runtime>(
    app: AppHandle<R>,
    payload: TTSSessionPushRequest,
) -> Result<()> {
    app.native_tts().tts_session_push(payload)
}

#[command]
pub(crate) async fn tts_session_stop<R: Runtime>(app: AppHandle<R>) -> Result<()> {
    app.native_tts().tts_session_stop()
}

#[command]
pub(crate) async fn tts_session_pause<R: Runtime>(app: AppHandle<R>) -> Result<()> {
    app.native_tts().tts_session_pause()
}

#[command]
pub(crate) async fn tts_session_resume<R: Runtime>(app: AppHandle<R>) -> Result<()> {
    app.native_tts().tts_session_resume()
}

#[command]
pub(crate) async fn tts_session_set_rate<R: Runtime>(
    app: AppHandle<R>,
    payload: SetRateArgs,
) -> Result<()> {
    app.native_tts().tts_session_set_rate(payload)
}

#[command]
pub(crate) async fn tts_session_set_voice<R: Runtime>(
    app: AppHandle<R>,
    payload: SetVoiceArgs,
) -> Result<()> {
    app.native_tts().tts_session_set_voice(payload)
}

#[command]
pub(crate) async fn tts_session_set_end_of_book<R: Runtime>(
    app: AppHandle<R>,
    payload: TTSSessionSetEndOfBookRequest,
) -> Result<()> {
    app.native_tts().tts_session_set_end_of_book(payload)
}


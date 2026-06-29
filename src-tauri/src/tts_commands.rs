use tauri::{AppHandle, Runtime};

use crate::tts::dispatcher;
use crate::tts::types::{TtsGetSegmentsRequest, TtsGetSegmentsResponse};

/// 统一 TTS 取片入口：按 format 字段分发到对应 dispatcher
#[tauri::command]
pub async fn tts_get_segments<R: Runtime>(
    app: AppHandle<R>,
    request: TtsGetSegmentsRequest,
) -> Result<TtsGetSegmentsResponse, String> {
    match request.format.as_str() {
        "epub" => dispatcher::epub::get_segments(&app, &request).await,
        "mobi" => dispatcher::mobi::get_segments(&app, &request).await,
        "txt" => dispatcher::txt::get_segments(&app, &request).await,
        other => Err(format!("不支持的 TTS 格式: {}", other)),
    }
}

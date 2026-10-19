use std::collections::HashSet;
use std::sync::Arc;

use tauri::{AppHandle, Manager, Runtime};
use tokio::sync::Mutex;

use crate::formats::mobi::cache::MobiCacheManager;
use crate::mobi_commands::MobiCacheState;
use crate::tts::dispatcher::common::{get_text_segments, SectionBatchConfig};
use crate::tts::dispatcher::html_text::extract_plain_text;
use crate::tts::types::{TtsGetSegmentsRequest, TtsGetSegmentsResponse};

/// MOBI 单批次配置：最多跨 8 章
const MOBI_BATCH: SectionBatchConfig = SectionBatchConfig {
    max_sections_per_batch: 8,
    id_prefix: "mobi",
};

/// MOBI 取片入口：从章节缓存按 cursor 续传地拉取 segments
pub async fn get_segments<R: Runtime>(
    app: &AppHandle<R>,
    req: &TtsGetSegmentsRequest,
) -> Result<TtsGetSegmentsResponse, String> {
    let total_sections = req.total_sections.unwrap_or(0).max(0);
    let manager: Arc<Mutex<MobiCacheManager>> = app
        .state::<MobiCacheState>()
        .inner()
        .clone();
    let book_id = req.book_id.clone();

    get_text_segments(req, total_sections, &MOBI_BATCH, &HashSet::new(), |section_index| {
        let manager = manager.clone();
        let book_id = book_id.clone();
        Box::pin(async move {
            let m = manager.lock().await;
            let loaded = m.load_section(&book_id, section_index as u32).await?;
            Ok(loaded.map(|d| extract_plain_text(&d.html)))
        })
    })
    .await
}



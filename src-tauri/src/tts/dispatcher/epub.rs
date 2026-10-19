use std::collections::HashSet;
use std::sync::Arc;

use tauri::{AppHandle, Manager, Runtime};
use tokio::sync::Mutex;

use crate::epub_commands::EpubCacheState;
use crate::formats::epub::EpubCacheManager;
use crate::tts::dispatcher::common::{get_text_segments, SectionBatchConfig};
use crate::tts::dispatcher::html_text::extract_plain_text;
use crate::tts::types::{TtsGetSegmentsRequest, TtsGetSegmentsResponse};

/// EPUB 单批次配置：最多跨 12 章
const EPUB_BATCH: SectionBatchConfig = SectionBatchConfig {
    max_sections_per_batch: 12,
    id_prefix: "epub",
};

/// EPUB 取片入口：从章节缓存按 cursor 续传地拉取 segments
pub async fn get_segments<R: Runtime>(
    app: &AppHandle<R>,
    req: &TtsGetSegmentsRequest,
) -> Result<TtsGetSegmentsResponse, String> {
    let total_sections = req.total_sections.unwrap_or(0).max(0);
    let manager: Arc<Mutex<EpubCacheManager>> = app
        .state::<EpubCacheState>()
        .inner()
        .clone();

    // 不参与阅读顺序的章节（如 EPUB3 导航文档）不朗读
    let hidden_sections: HashSet<i32> = req
        .hidden_sections
        .as_ref()
        .map(|list| list.iter().copied().collect())
        .unwrap_or_default();
    let book_id = req.book_id.clone();

    get_text_segments(req, total_sections, &EPUB_BATCH, &hidden_sections, |section_index| {
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



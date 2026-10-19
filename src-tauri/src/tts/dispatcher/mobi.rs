use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Manager, Runtime};
use tokio::sync::Mutex;

use crate::formats::mobi::cache::MobiCacheManager;
use crate::mobi_commands::MobiCacheState;
use crate::tts::dispatcher::common::{get_text_segments, SectionBatchConfig};
use crate::tts::dispatcher::html_text::extract_plain_text;
use crate::tts::types::{TtsGetSegmentsRequest, TtsGetSegmentsResponse};

/// MOBI 单批次配置
///
/// - 时间预算吸收“章大/章小、存储快/慢”的差异，不再用固定跨章数做配额；
/// - 安全阀只兜底大量空章（MOBI 无隐藏章节概念）。
const MOBI_BATCH: SectionBatchConfig = SectionBatchConfig {
    id_prefix: "mobi",
    max_examined_sections: 128,
    max_batch_load_time: Duration::from_millis(250),
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



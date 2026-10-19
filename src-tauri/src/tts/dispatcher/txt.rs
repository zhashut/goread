use std::collections::HashSet;
use std::time::Duration;

use tauri::{AppHandle, Runtime};

use crate::formats::txt::{TxtBookMeta, TxtEngine};
use crate::tts::dispatcher::common::{get_text_segments, SectionBatchConfig};
use crate::tts::types::{TtsGetSegmentsRequest, TtsGetSegmentsResponse};
use crate::txt_commands::METADATA_CACHE;

/// TXT 单批次配置
///
/// TXT 章节整体较大，正常一批会在首章内部就达到 segments 上限；
/// 安全阀比 EPUB/MOBI 更小，因为单章加载需要读文件（比读已缓存的章节 HTML 更贵）。
const TXT_BATCH: SectionBatchConfig = SectionBatchConfig {
    id_prefix: "txt",
    max_examined_sections: 64,
    max_batch_load_time: Duration::from_millis(250),
};

/// TXT 取片入口：按章节加载内容，cursor 用 sectionIndex:chunkIndex 形式
pub async fn get_segments<R: Runtime>(
    _app: &AppHandle<R>,
    req: &TtsGetSegmentsRequest,
) -> Result<TtsGetSegmentsResponse, String> {
    let meta = ensure_metadata(&req.file_path)?;
    let total_chapters = meta.chapters.len() as i32;
    let file_path = req.file_path.clone();

    get_text_segments(req, total_chapters, &TXT_BATCH, &HashSet::new(), |section_index| {
        let file_path = file_path.clone();
        let meta = meta.clone();
        Box::pin(async move {
            Ok(Some(load_chapter_text(&file_path, section_index, &meta)?))
        })
    })
    .await
}

/// 复用 txt_commands 的元数据缓存；未命中时自动解析并写入
fn ensure_metadata(file_path: &str) -> Result<TxtBookMeta, String> {
    {
        let cache = METADATA_CACHE.lock().map_err(|e| e.to_string())?;
        if let Some(m) = cache.get(file_path) {
            return Ok(m.clone());
        }
    }
    let m = TxtEngine::load_metadata(file_path).map_err(|e| e.to_string())?;
    let mut cache = METADATA_CACHE.lock().map_err(|e| e.to_string())?;
    cache.insert(file_path.to_string(), m.clone());
    Ok(m)
}

/// 加载指定章节文本
fn load_chapter_text(file_path: &str, chapter_index: i32, meta: &TxtBookMeta) -> Result<String, String> {
    let chapters = TxtEngine::load_chapters(file_path, &[chapter_index as u32], meta)
        .map_err(|e| e.to_string())?;
    Ok(chapters
        .into_iter()
        .next()
        .map(|c| c.content.trim().to_string())
        .unwrap_or_default())
}



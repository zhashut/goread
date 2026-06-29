use tauri::{AppHandle, Runtime};

use crate::formats::txt::{TxtBookMeta, TxtEngine};
use crate::tts::cursor::{decode_section_cursor, encode_section_cursor};
use crate::tts::slicer::{find_anchor_start_byte, slice_text_to_segments, SliceOptions};
use crate::tts::types::{TtsGetSegmentsRequest, TtsGetSegmentsResponse, TtsSegmentDto};
use crate::txt_commands::METADATA_CACHE;

/// 单批次最多跨越的 TXT 章节数
const MAX_CHAPTERS_PER_BATCH: i32 = 4;

/// TXT 取片入口：按章节加载内容，cursor 用 sectionIndex:chunkIndex 形式
pub async fn get_segments<R: Runtime>(
    _app: &AppHandle<R>,
    req: &TtsGetSegmentsRequest,
) -> Result<TtsGetSegmentsResponse, String> {
    let meta = ensure_metadata(&req.file_path)?;
    let total_chapters = meta.chapters.len() as i32;
    if total_chapters == 0 {
        return Ok(TtsGetSegmentsResponse {
            segments: Vec::new(),
            cursor: None,
            has_more: false,
        });
    }

    let (start_section, start_chunk) = resolve_start(req);
    let max_segments = req.max_segments.max(1);

    let mut segments: Vec<TtsSegmentDto> = Vec::new();
    let mut next_section = start_section;
    let mut next_chunk = start_chunk;
    let mut has_more = false;

    let mut section_index = start_section;
    while section_index < total_chapters {
        if section_index - start_section >= MAX_CHAPTERS_PER_BATCH {
            has_more = true;
            next_section = section_index;
            next_chunk = 0;
            break;
        }
        if segments.len() >= max_segments as usize {
            has_more = true;
            next_section = section_index;
            next_chunk = if section_index == start_section { start_chunk } else { 0 };
            break;
        }

        let raw_text = load_chapter_text(&req.file_path, section_index, &meta)?;
        if raw_text.is_empty() {
            section_index += 1;
            next_section = section_index;
            next_chunk = 0;
            continue;
        }

        let text = trim_text_by_anchor(&raw_text, section_index, req);
        if text.is_empty() {
            section_index += 1;
            next_section = section_index;
            next_chunk = 0;
            continue;
        }

        let slice_start = if section_index == start_section { start_chunk } else { 0 };
        let remaining = (max_segments as usize).saturating_sub(segments.len()) as u32;
        let id_prefix = format!("txt:{}", section_index);
        let slice = slice_text_to_segments(SliceOptions {
            id_prefix: &id_prefix,
            text: &text,
            section_index,
            start_chunk_index: slice_start,
            max_segments: remaining,
            lang: None,
            encode_cursor: None,
        });
        segments.extend(slice.segments);

        if slice.has_more_in_text {
            has_more = true;
            next_section = section_index;
            next_chunk = slice.next_chunk_index;
            break;
        }
        section_index += 1;
        next_section = section_index;
        next_chunk = 0;
    }

    if !has_more {
        has_more = next_section < total_chapters;
    }
    let cursor = if has_more {
        Some(encode_section_cursor(next_section, next_chunk))
    } else {
        None
    };

    Ok(TtsGetSegmentsResponse {
        segments,
        cursor,
        has_more,
    })
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

fn resolve_start(req: &TtsGetSegmentsRequest) -> (i32, i32) {
    if let Some(cursor) = req.cursor.as_deref() {
        if let Some((s, c)) = decode_section_cursor(cursor) {
            return (s, c);
        }
    }
    if let Some(pos) = req.start_position.as_ref() {
        return (pos.section_index.max(0), 0);
    }
    let fallback = req.fallback_section_index.unwrap_or(0).max(0);
    (fallback, 0)
}

fn trim_text_by_anchor(
    text: &str,
    section_index: i32,
    req: &TtsGetSegmentsRequest,
) -> String {
    if req.cursor.is_some() {
        return text.to_string();
    }
    let pos = match req.start_position.as_ref() {
        Some(p) => p,
        None => return text.to_string(),
    };
    if pos.section_index != section_index {
        return text.to_string();
    }
    let anchor = match pos.anchor.as_ref() {
        Some(a) => a,
        None => return text.to_string(),
    };
    let offset = find_anchor_start_byte(text, anchor);
    if offset == 0 || offset >= text.len() {
        return text.to_string();
    }
    text[offset..].trim().to_string()
}


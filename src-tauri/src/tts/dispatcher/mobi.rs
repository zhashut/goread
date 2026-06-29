use std::sync::Arc;

use tauri::{AppHandle, Manager, Runtime};
use tokio::sync::Mutex;

use crate::formats::mobi::cache::MobiCacheManager;
use crate::mobi_commands::MobiCacheState;
use crate::tts::cursor::{decode_section_cursor, encode_section_cursor};
use crate::tts::dispatcher::html_text::extract_plain_text;
use crate::tts::slicer::{find_anchor_start_byte, slice_text_to_segments, SliceOptions};
use crate::tts::types::{TtsGetSegmentsRequest, TtsGetSegmentsResponse, TtsSegmentDto};

/// 单批次最多跨越的章节数
const MAX_SECTIONS_PER_BATCH: i32 = 8;

/// MOBI 取片入口：从章节缓存按 cursor 续传地拉取 segments
pub async fn get_segments<R: Runtime>(
    app: &AppHandle<R>,
    req: &TtsGetSegmentsRequest,
) -> Result<TtsGetSegmentsResponse, String> {
    let total_sections = req.total_sections.unwrap_or(0).max(0);
    if total_sections <= 0 {
        return Ok(TtsGetSegmentsResponse {
            segments: Vec::new(),
            cursor: None,
            has_more: false,
        });
    }

    let manager: Arc<Mutex<MobiCacheManager>> = app
        .state::<MobiCacheState>()
        .inner()
        .clone();

    let (start_section, start_chunk) = resolve_start(req);
    let max_segments = req.max_segments.max(1);

    let mut segments: Vec<TtsSegmentDto> = Vec::new();
    let mut next_section = start_section;
    let mut next_chunk = start_chunk;
    let mut has_more = false;

    let mut section_index = start_section;
    while section_index < total_sections {
        if section_index - start_section >= MAX_SECTIONS_PER_BATCH {
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

        let load_result = {
            let m = manager.lock().await;
            m.load_section(&req.book_id, section_index as u32).await?
        };
        let raw_html = match load_result {
            Some(d) => d.html,
            None => {
                has_more = true;
                next_section = section_index;
                next_chunk = if section_index == start_section { start_chunk } else { 0 };
                break;
            }
        };

        let raw_text = extract_plain_text(&raw_html);
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
        let id_prefix = format!("mobi:{}", section_index);
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
        has_more = next_section < total_sections;
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


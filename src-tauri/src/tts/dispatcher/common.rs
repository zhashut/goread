use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;

use crate::tts::cursor::{decode_section_cursor, encode_section_cursor};
use crate::tts::slicer::{resolve_start_chunk_index, slice_text_to_segments, SliceOptions};
use crate::tts::types::{TtsGetSegmentsRequest, TtsGetSegmentsResponse, TtsSegmentDto};

/// 章节型格式（EPUB/MOBI）的批次配置。
///
/// 把“最大跨章数 + id 前缀”收成一个类型，避免各 dispatcher 各自维护同义常量。
pub(crate) struct SectionBatchConfig {
    pub max_sections_per_batch: i32,
    pub id_prefix: &'static str,
}

/// 异步加载单章纯文本的 future 类型：None 表示缓存暂不可用，保留 cursor 重试。
pub(crate) type SectionLoaderFuture =
    Pin<Box<dyn Future<Output = Result<Option<String>, String>> + Send>>;

/// 从 cursor / startPosition / fallbackSection 解析起始章节与 chunk。
pub(crate) fn resolve_start(req: &TtsGetSegmentsRequest) -> (i32, i32) {
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

/// EPUB/MOBI/TXT 共用的取片主循环。
///
/// 各格式只有“章节纯文本从哪里加载”“id 前缀”“最大跨章数”“是否跳过隐藏章节”不同，
/// 其余 cursor、chunk 换算、has_more 计算完全一致。
pub(crate) async fn get_text_segments<F>(
    req: &TtsGetSegmentsRequest,
    total_sections: i32,
    config: &SectionBatchConfig,
    hidden_sections: &HashSet<i32>,
    mut load_section: F,
) -> Result<TtsGetSegmentsResponse, String>
where
    F: FnMut(i32) -> SectionLoaderFuture,
{
    let total_sections = total_sections.max(0);
    if total_sections <= 0 {
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
    while section_index < total_sections {
        if section_index - start_section >= config.max_sections_per_batch {
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

        // 隐藏章节（如 EPUB3 导航文档）不消耗批次配额，也不产生 segments
        if hidden_sections.contains(&section_index) {
            section_index += 1;
            next_section = section_index;
            next_chunk = 0;
            continue;
        }

        let text = match load_section(section_index).await? {
            Some(text) => text,
            None => {
                // 章节加载失败：保留 cursor 等下次重试
                has_more = true;
                next_section = section_index;
                next_chunk = if section_index == start_section { start_chunk } else { 0 };
                break;
            }
        };

        if text.is_empty() {
            section_index += 1;
            next_section = section_index;
            next_chunk = 0;
            continue;
        }

        // 首批从章节中部起播时，把视口 anchor 换算成 chunk 下标；
        // 章节文本保持完整，保证首批产出的 cursor 与续读批使用同一套 chunk 下标坐标系
        let slice_start = if section_index == start_section {
            start_chunk.max(resolve_start_chunk_index(
                &text,
                section_index,
                req.cursor.as_deref(),
                req.start_position.as_ref(),
            ))
        } else {
            0
        };
        let remaining = (max_segments as usize).saturating_sub(segments.len()) as u32;
        let id_prefix = format!("{}:{}", config.id_prefix, section_index);
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

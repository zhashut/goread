use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::time::{Duration, Instant};

use crate::tts::cursor::{decode_section_cursor, encode_section_cursor};
use crate::tts::slicer::{resolve_start_chunk_index, slice_text_to_segments, SliceOptions};
use crate::tts::types::{TtsGetSegmentsRequest, TtsGetSegmentsResponse, TtsSegmentDto};

/// 章节型格式（EPUB/MOBI/TXT）的批次配置。
///
/// 批次边界由三个约束共同决定（任一满足就收尾并返回 cursor）：
/// 1. `max_segments`（请求参数）：本批产出的 segments 条数，直接决定音频前瞻时长；
/// 2. `max_batch_load_time`：本批累计加载耗时，保护慢存储/大章节；
/// 3. `max_examined_sections`：安全阀，兜住大量空章/隐藏章（只扫不产出）的极端书。
///
/// 不再用“固定跨章数”做配额：章节数量与真实成本无关（一章图文书可能比
/// 几十个空导航章还贵），具体成本由耗时代入；安全阀只是防无界扫描。
pub(crate) struct SectionBatchConfig {
    pub id_prefix: &'static str,
    /// 安全阀：单批最多“查看”的 section 数（含空章与隐藏章）
    pub max_examined_sections: i32,
    /// 单批软耗时预算（只在本批已产出内容后生效，保证不会制造空批）
    pub max_batch_load_time: Duration,
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
/// 各格式只有“章节纯文本从哪里加载”“id 前缀”“批次预算（安全阀 + 耗时）”“是否跳过隐藏章节”不同，
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
    // 下一批的起点：是否还有内容由它是否越界唯一决定（不在分支里维护 has_more 状态）
    let mut next_section = start_section;
    let mut next_chunk = start_chunk;

    // 本批成本计量：查看过多少 section（含空章/隐藏章）与累计加载耗时
    let started_at = Instant::now();
    let mut examined_sections: i32 = 0;

    let mut section_index = start_section;
    while section_index < total_sections {
        // 安全阀：兜住“大量空章/隐藏章”的扫描风暴。
        // 正常书籍会在下面的 segments 上限或时间预算处先收尾，走不到这里。
        if examined_sections >= config.max_examined_sections {
            next_section = section_index;
            next_chunk = 0;
            break;
        }
        if segments.len() >= max_segments as usize {
            next_section = section_index;
            next_chunk = if section_index == start_section { start_chunk } else { 0 };
            break;
        }
        examined_sections += 1;

        // 隐藏章节（如 EPUB3 导航文档）不产生 segments，只消耗安全阀配额
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
            next_section = section_index;
            next_chunk = slice.next_chunk_index;
            break;
        }
        section_index += 1;
        next_section = section_index;
        next_chunk = 0;

        // 时间预算：已产出内容且累计加载耗时超预算 → 以 cursor 收尾，等下一次补给。
        // 必须先有产出才判断，否则可能一章未读完就结束，产出空批
        // （托管会话每 tick 只补一次，空批等于白白消耗一个周期）。
        if !segments.is_empty() && started_at.elapsed() >= config.max_batch_load_time {
            break;
        }
    }

    // 收口前先把尾部隐藏章节跳掉：它们不产出内容，停在这里会让下一 tick 白跑一趟空批
    while next_section < total_sections && hidden_sections.contains(&next_section) {
        next_section += 1;
        next_chunk = 0;
    }

    // 统一收口：下一批起点越界即无后续内容。
    // 这样“正好停在书末”不会多跑一趟空批（某些分支会把 next_section 推到 total_sections）。
    let has_more = next_section < total_sections;
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试基线配置：安全阀 128、时间预算 250ms
    /// （生产值见各 dispatcher 的 *BatchConfig 常量；本处不与其耦合）
    fn config() -> SectionBatchConfig {
        SectionBatchConfig {
            id_prefix: "test",
            max_examined_sections: 128,
            max_batch_load_time: Duration::from_millis(250),
        }
    }

    fn request(max_segments: u32) -> TtsGetSegmentsRequest {
        TtsGetSegmentsRequest {
            book_id: "book".to_string(),
            file_path: "/tmp/book".to_string(),
            format: "epub".to_string(),
            cursor: None,
            max_segments,
            start_position: None,
            fallback_section_index: Some(0),
            total_sections: None,
            reading_mode: None,
            hidden_sections: None,
        }
    }

    /// 用固定章节文本构造 loader：越界返回 None（视为该章不存在）
    /// 空字符串会原样返回，用于模拟“空章节”。
    fn loader(sections: Vec<String>) -> impl FnMut(i32) -> SectionLoaderFuture {
        // 必须用 Arc：future 要求 Send，Rc 不满足
        let sections = std::sync::Arc::new(sections);
        move |index: i32| -> SectionLoaderFuture {
            let sections = sections.clone();
            Box::pin(async move { Ok(sections.get(index as usize).cloned()) })
        }
    }

    fn decode(cursor: Option<String>) -> (i32, i32) {
        decode_section_cursor(&cursor.expect("cursor expected")).expect("cursor decodable")
    }

    #[tokio::test]
    async fn normal_chapter_fills_batch_and_resumes_inside_chapter() {
        // 一章足够长：本批应该在章内就达到 segments 上限，cursor 指向同一章的后续 chunk
        let text = "这是一句用于测试的完整句子。".repeat(80);
        let total = 3;
        let resp = get_text_segments(
            &request(5),
            total,
            &config(),
            &HashSet::new(),
            loader(vec![text.clone(), text.clone(), text]),
        )
        .await
        .expect("ok");

        assert_eq!(resp.segments.len(), 5);
        assert!(resp.has_more);
        let (section, chunk) = decode(resp.cursor);
        assert_eq!(section, 0, "仍在第一章内续读");
        assert!(chunk > 0, "chunk 应该前进到下一句");
    }

    #[tokio::test]
    async fn short_chapters_cross_far_more_than_twelve_sections() {
        // 40 个超短章节：旧的“固定 12 章”配额会停在 12 章，
        // 新逻辑只受 max_segments 约束，本批应一次取满 40 段
        let sections: Vec<String> =
            (0..40).map(|i| format!("这是第{i}段测试文本，用来验证跨章节拼接。")).collect();
        let resp = get_text_segments(
            &request(60),
            40,
            &config(),
            &HashSet::new(),
            loader(sections),
        )
        .await
        .expect("ok");

        assert_eq!(resp.segments.len(), 40);
        assert!(!resp.has_more);
        assert!(resp.cursor.is_none());
    }

    #[tokio::test]
    async fn empty_section_storm_is_bounded_by_safety_valve() {
        // 100 个空章节：安全阀生效，返回空批 + 前进的 cursor（而不是无界扫描整本）
        let cfg = SectionBatchConfig {
            max_examined_sections: 8,
            ..config()
        };
        let sections: Vec<String> = (0..100).map(|_| String::new()).collect();
        let resp = get_text_segments(&request(60), 100, &cfg, &HashSet::new(), loader(sections))
            .await
            .expect("ok");

        assert!(resp.segments.is_empty());
        assert!(resp.has_more);
        assert_eq!(decode(resp.cursor).0, 8, "cursor 指向安全阀边界");
    }

    #[tokio::test]
    async fn hidden_sections_do_not_produce_segments() {
        let sections: Vec<String> =
            (0..6).map(|i| format!("第{i}章的正文句子。")).collect();
        let hidden: HashSet<i32> = vec![1, 2, 3].into_iter().collect();
        let resp = get_text_segments(&request(60), 6, &config(), &hidden, loader(sections))
            .await
            .expect("ok");

        assert_eq!(resp.segments.len(), 3, "隐藏章节不应产出 segments");
        assert!(!resp.has_more);
    }

    #[tokio::test]
    async fn time_budget_never_produces_empty_batch() {
        // 时间预算为 0：每章读完就超预算 → 本批停在 1 章，且必须已有产出
        let cfg = SectionBatchConfig {
            max_batch_load_time: Duration::ZERO,
            ..config()
        };
        let sections: Vec<String> =
            (0..5).map(|i| format!("第{i}章的一句话。")).collect();
        let resp = get_text_segments(&request(60), 5, &cfg, &HashSet::new(), loader(sections))
            .await
            .expect("ok");

        assert_eq!(resp.segments.len(), 1, "时间预算不能制造空批");
        assert!(resp.has_more);
        assert_eq!(decode(resp.cursor).0, 1);
    }

    #[tokio::test]
    async fn time_budget_at_book_end_reports_no_more() {        // 时间预算恰好在最后一章触发：next_section 已越界，不能报 has_more
        let cfg = SectionBatchConfig {
            max_batch_load_time: Duration::ZERO,
            ..config()
        };
        let resp = get_text_segments(
            &request(60),
            1,
            &cfg,
            &HashSet::new(),
            loader(vec!["全书只有这一句话。".to_string()]),
        )
        .await
        .expect("ok");

        assert_eq!(resp.segments.len(), 1);
        assert!(!resp.has_more);
        assert!(resp.cursor.is_none());
    }

    #[tokio::test]
    async fn hidden_sections_count_toward_safety_valve() {
        // 隐藏章节不产出内容，但必须计入“查看数”，否则纯隐藏段落会无界扫描
        let cfg = SectionBatchConfig {
            max_examined_sections: 8,
            ..config()
        };
        let hidden: HashSet<i32> = (0..8).collect();
        let sections: Vec<String> = (0..100).map(|i| format!("第{i}章正文。")).collect();
        let resp = get_text_segments(&request(60), 100, &cfg, &hidden, loader(sections))
            .await
            .expect("ok");

        assert!(resp.segments.is_empty());
        assert!(resp.has_more);
        assert_eq!(decode(resp.cursor).0, 8, "隐藏章也占用安全阀配额");
    }

    #[tokio::test]
    async fn trailing_hidden_sections_do_not_need_another_round() {
        // 本批停在隐藏章之前：收口时应直接报 end，而不是让下一 tick 取一次空批
        let hidden: HashSet<i32> = vec![1, 2].into_iter().collect();
        let resp = get_text_segments(
            &request(1),
            3,
            &config(),
            &hidden,
            loader(vec![
                "第一章正文。".to_string(),
                "第二章正文。".to_string(),
                "第三章正文。".to_string(),
            ]),
        )
        .await
        .expect("ok");

        assert_eq!(resp.segments.len(), 1);
        assert!(!resp.has_more, "尾部隐藏章不应再跑一趟空批");
        assert!(resp.cursor.is_none());
    }
}

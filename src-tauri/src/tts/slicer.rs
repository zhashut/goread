use crate::tts::cursor::encode_section_cursor;
use crate::tts::types::{TtsAnchorDto, TtsSegmentDto, TtsStartPosition};

/// 单句最大长度阈值，超过此长度的句子会被进一步硬拆
const SENTENCE_HARD_SPLIT_LENGTH: usize = 200;
/// anchor 上下文窗口长度
const ANCHOR_CONTEXT_LENGTH: usize = 24;

/// 句子结束标点：与前端 splitTextToSentences 行为一致
const SENTENCE_END_CHARS: &[char] = &['。', '！', '？', '；', '.', '!', '?', ';'];

/// 长文本兜底拆分时的次级标点
const SECONDARY_BREAK_CHARS: &[char] = &['，', '、', '；', '：', ',', ';', ':'];

/// 把整段文本按句切分；若无明显标点则按硬切兜底
pub fn split_text_to_chunks(text: &str) -> Vec<String> {
    let sentences = split_to_sentences(text);
    if sentences.is_empty() {
        return split_long_text(text, SENTENCE_HARD_SPLIT_LENGTH);
    }
    let mut chunks = Vec::with_capacity(sentences.len());
    for sentence in sentences {
        if char_count(&sentence) > SENTENCE_HARD_SPLIT_LENGTH {
            chunks.extend(split_long_text(&sentence, SENTENCE_HARD_SPLIT_LENGTH));
        } else {
            push_chunk(&mut chunks, &sentence);
        }
    }
    chunks
}

/// 按段落 + 句末标点切分文本
fn split_to_sentences(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for para in text.split('\n') {
        let para = para.trim();
        if para.is_empty() {
            continue;
        }
        let mut current = String::new();
        for ch in para.chars() {
            current.push(ch);
            if SENTENCE_END_CHARS.contains(&ch) {
                let trimmed = current.trim();
                if !trimmed.is_empty() {
                    out.push(trimmed.to_string());
                }
                current.clear();
            }
        }
        let trimmed = current.trim();
        if !trimmed.is_empty() {
            out.push(trimmed.to_string());
        }
    }
    out
}

/// 长文本兜底拆分：先用次级标点找断点，否则按字符硬切
fn split_long_text(text: &str, max_length: usize) -> Vec<String> {
    let mut chunks: Vec<String> = Vec::new();
    let mut remaining = text.trim().to_string();

    while char_count(&remaining) > max_length {
        let head: String = remaining.chars().take(max_length).collect();
        let break_at = SECONDARY_BREAK_CHARS
            .iter()
            .filter_map(|&c| head.rfind(c).map(|idx| idx + c.len_utf8()))
            .max();
        let cut_byte = match break_at {
            Some(b) if b > 0 => b,
            _ => head.len(),
        };
        push_chunk(&mut chunks, &remaining[..cut_byte]);
        remaining = remaining[cut_byte..].trim().to_string();
    }
    push_chunk(&mut chunks, &remaining);
    chunks
}

/// 添加 chunk 到列表，自动 trim 并跳过空串
fn push_chunk(chunks: &mut Vec<String>, chunk: &str) {
    let trimmed = chunk.trim();
    if !trimmed.is_empty() {
        chunks.push(trimmed.to_string());
    }
}

/// 字符数（按 Unicode 字符）
fn char_count(s: &str) -> usize {
    s.chars().count()
}

/// 在指定字节区间生成 anchor，附带前后 24 字符上下文
fn create_anchor(text: &str, start_byte: usize, end_byte: usize) -> TtsAnchorDto {
    let prefix = take_chars_before(text, start_byte, ANCHOR_CONTEXT_LENGTH);
    let suffix = take_chars_after(text, end_byte, ANCHOR_CONTEXT_LENGTH);
    TtsAnchorDto {
        quote: text[start_byte..end_byte].to_string(),
        prefix: if prefix.is_empty() { None } else { Some(prefix) },
        suffix: if suffix.is_empty() { None } else { Some(suffix) },
    }
}

/// 在指定字节位置之前取 n 个字符
fn take_chars_before(text: &str, byte_pos: usize, n: usize) -> String {
    let head = &text[..byte_pos.min(text.len())];
    let mut chars: Vec<char> = head.chars().collect();
    let len = chars.len();
    if len > n {
        chars = chars.split_off(len - n);
    }
    chars.iter().collect()
}

/// 在指定字节位置之后取 n 个字符
fn take_chars_after(text: &str, byte_pos: usize, n: usize) -> String {
    let tail = &text[byte_pos.min(text.len())..];
    tail.chars().take(n).collect()
}

/// 切片选项
pub struct SliceOptions<'a> {
    /// segment id 前缀（如 epub:0 / mobi:3 / txt-h:5）
    pub id_prefix: &'a str,
    /// 待切的整段文本
    pub text: &'a str,
    /// 该段所属的章节索引
    pub section_index: i32,
    /// 起始 chunk 序号（用于 cursor 续传）
    pub start_chunk_index: i32,
    /// 单批次最大产出 segment 数量
    pub max_segments: u32,
    /// 朗读语言
    pub lang: Option<String>,
    /// 自定义 cursor 编码方式
    pub encode_cursor: Option<fn(i32, i32) -> String>,
}

/// 切片结果
pub struct SliceResult {
    pub segments: Vec<TtsSegmentDto>,
    pub next_chunk_index: i32,
    pub has_more_in_text: bool,
}

/// 把文本切成 TTSSegment 数组；达到 max_segments 上限时返回 has_more_in_text=true
pub fn slice_text_to_segments(opts: SliceOptions) -> SliceResult {
    let chunks = split_text_to_chunks(opts.text);
    let cursor_encoder: fn(i32, i32) -> String =
        opts.encode_cursor.unwrap_or(encode_section_cursor);

    let mut segments: Vec<TtsSegmentDto> = Vec::new();
    let mut search_byte: usize = 0;

    for (i, chunk) in chunks.iter().enumerate() {
        let i_i32 = i as i32;
        let found = opts.text[search_byte..]
            .find(chunk.as_str())
            .map(|rel| search_byte + rel);
        let start = found.unwrap_or(search_byte);
        let end = (start + chunk.len()).min(opts.text.len());
        search_byte = end;

        if i_i32 < opts.start_chunk_index {
            continue;
        }
        if segments.len() >= opts.max_segments as usize {
            return SliceResult {
                segments,
                next_chunk_index: i_i32,
                has_more_in_text: true,
            };
        }

        segments.push(TtsSegmentDto {
            id: format!("{}:{}", opts.id_prefix, i),
            text: chunk.clone(),
            lang: opts.lang.clone(),
            section_index: opts.section_index,
            chunk_index: i_i32,
            cursor: cursor_encoder(opts.section_index, i_i32),
            anchor: Some(create_anchor(opts.text, start, end)),
        });
    }

    SliceResult {
        segments,
        next_chunk_index: chunks.len() as i32,
        has_more_in_text: false,
    }
}

/// 上下文优先的 anchor 起点匹配（章内同名句段消歧）
///
/// 逐级降级：完整上下文（prefix+quote+suffix）→ 前缀+quote → quote+后缀 →
/// 沿用 `find_anchor_start_byte` 的三层兜底（含空白规范化）。
/// 同名句段在章内重复时优先选中上下文吻合的那一次，避免把起播点拉回更早的重复句段。
fn find_anchor_start_offset_with_context(text: &str, anchor: &TtsAnchorDto) -> usize {
    let quote = anchor.quote.as_str();
    if quote.is_empty() {
        return 0;
    }
    let prefix = anchor.prefix.as_deref().unwrap_or("");
    let suffix = anchor.suffix.as_deref().unwrap_or("");
    // 上下文越完整优先级越高。quote 在模式内的偏移必须显式给出：
    // 若用 pattern.find(quote) 反推，prefix 自身含同名句段时会把起点误判到前缀里。
    let mut patterns: Vec<(String, usize)> = Vec::new();
    if !prefix.is_empty() || !suffix.is_empty() {
        patterns.push((format!("{}{}{}", prefix, quote, suffix), prefix.len()));
        if !prefix.is_empty() {
            patterns.push((format!("{}{}", prefix, quote), prefix.len()));
        }
        if !suffix.is_empty() {
            patterns.push((format!("{}{}", quote, suffix), 0));
        }
    }
    for (pattern, quote_offset) in patterns {
        if let Some(idx) = text.find(pattern.as_str()) {
            return idx + quote_offset;
        }
    }
    // 上下文缺失或不匹配（如 DOM 正文与提取文本的空白差异）：退回原有兜底匹配
    find_anchor_start_byte(text, anchor)
}

/// 计算「按 anchor 起播」时应跳过的 chunk 数，坐标系为传入的**完整章节文本**
///
/// 与「先裁掉 anchor 之前的前缀再切片」的旧做法相比，这里只把起点换算成 chunk 下标，
/// 章节文本保持原样，因此首批产出的 cursor 与后续 cursor 续读批始终处于同一套
/// chunk 下标坐标系，不会出现续读批回退到已读内容的问题。
/// 取 anchor 起点**所在**的整个 chunk（即视口顶部那一句），最多只多读一句，
/// 避免旧实现从句子中间开始朗读得到半句。
pub fn find_start_chunk_index_by_anchor(text: &str, anchor: &TtsAnchorDto) -> i32 {
    let offset = find_anchor_start_offset_with_context(text, anchor);
    if offset == 0 {
        // anchor 命中章首：无需跳过
        return 0;
    }
    let chunks = split_text_to_chunks(text);
    if chunks.is_empty() {
        return 0;
    }
    // 与 slice_text_to_segments 相同的顺序查找方式，保证两处 chunk 起止位置一致
    let mut search_byte: usize = 0;
    for (i, chunk) in chunks.iter().enumerate() {
        let found = text[search_byte..]
            .find(chunk.as_str())
            .map(|rel| search_byte + rel);
        let start = found.unwrap_or(search_byte);
        let end = (start + chunk.len()).min(text.len());
        if end > offset {
            return i as i32;
        }
        search_byte = end;
    }
    // anchor 落在末尾空白区（正常不会发生）：从最后一个 chunk 开始，避免整章重读
    (chunks.len() as i32) - 1
}

/// 解析首批（cursor 为空）的起播位置，返回应跳过的 chunk 数
///
/// cursor 续读、章节不匹配、无 anchor 或 anchor 命中章首时返回 0；
/// 传入的 text 必须是**未裁剪**的完整章节正文，返回值可直接作为
/// `SliceOptions.start_chunk_index` 使用。
pub fn resolve_start_chunk_index(
    text: &str,
    section_index: i32,
    cursor: Option<&str>,
    start_position: Option<&TtsStartPosition>,
) -> i32 {
    if cursor.is_some() {
        // 续读：起始位置已由 cursor 给出，不能再按 anchor 二次换算
        return 0;
    }
    let pos = match start_position {
        Some(p) => p,
        None => return 0,
    };
    if pos.section_index != section_index {
        return 0;
    }
    let anchor = match pos.anchor.as_ref() {
        Some(a) => a,
        None => return 0,
    };
    find_start_chunk_index_by_anchor(text, anchor)
}

/// 在整段文本中根据 anchor 计算起始字节偏移，三层匹配兜底
pub fn find_anchor_start_byte(text: &str, anchor: &TtsAnchorDto) -> usize {
    if anchor.quote.is_empty() {
        return 0;
    }
    if let Some(idx) = text.find(anchor.quote.as_str()) {
        return idx;
    }
    let prefix = anchor.prefix.as_deref().map(str::trim).unwrap_or("");
    let suffix = anchor.suffix.as_deref().map(str::trim).unwrap_or("");
    let mut pattern = String::new();
    if !prefix.is_empty() {
        pattern.push_str(prefix);
        pattern.push(' ');
    }
    pattern.push_str(&anchor.quote);
    if !suffix.is_empty() {
        pattern.push(' ');
        pattern.push_str(suffix);
    }
    if let Some(p_idx) = text.find(pattern.as_str()) {
        if let Some(q_idx) = pattern.find(anchor.quote.as_str()) {
            return p_idx + q_idx;
        }
    }
    find_anchor_offset_normalized(text, &anchor.quote)
}

/// 规范化空白后匹配
fn find_anchor_offset_normalized(text: &str, quote: &str) -> usize {
    let normalized_quote: String = quote.chars().filter(|c| !c.is_whitespace()).collect();
    if normalized_quote.is_empty() {
        return 0;
    }
    let mut normalized = String::with_capacity(text.len());
    let mut norm_to_raw: Vec<usize> = Vec::with_capacity(text.len());
    for (byte_idx, ch) in text.char_indices() {
        if ch.is_whitespace() {
            continue;
        }
        let mut buf = [0u8; 4];
        let s = ch.encode_utf8(&mut buf);
        for _ in 0..s.len() {
            norm_to_raw.push(byte_idx);
        }
        normalized.push(ch);
    }
    match normalized.find(normalized_quote.as_str()) {
        Some(idx) => norm_to_raw.get(idx).copied().unwrap_or(0),
        None => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造长正文：每句带唯一序号，便于断言 chunk 下标
    fn build_chapter(sentence_count: usize) -> String {
        (0..sentence_count)
            .map(|i| format!("这是第{}个句子，用于验证朗读游标不会回退。", i))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// 取句子前若干字符作为 anchor.quote（按字符切，避免切断多字节字符）
    fn head_of(sentence: &str, chars: usize) -> String {
        sentence.chars().take(chars).collect()
    }

    /// 按「字符偏移 + 引用长度」构造真实形态的 anchor（与前端 rangeToTextQuote 一致：
    /// quote 取可见文本，prefix/suffix 各带 24 字上下文）
    fn anchor_at(text: &str, offset_chars: usize, quote_chars: usize) -> TtsAnchorDto {
        let chars: Vec<char> = text.chars().collect();
        let start = offset_chars.min(chars.len());
        let end = (start + quote_chars).min(chars.len());
        let prefix_start = start.saturating_sub(24);
        let suffix_end = (end + 24).min(chars.len());
        TtsAnchorDto {
            quote: chars[start..end].iter().collect(),
            prefix: if prefix_start < start {
                Some(chars[prefix_start..start].iter().collect())
            } else {
                None
            },
            suffix: if end < suffix_end {
                Some(chars[end..suffix_end].iter().collect())
            } else {
                None
            },
        }
    }

    /// anchor 起点所在的整句应作为起始 chunk，而不是从句子中间开始
    #[test]
    fn find_start_chunk_returns_sentence_containing_anchor() {
        let text = build_chapter(5);
        let chunks = split_text_to_chunks(&text);
        assert_eq!(chunks.len(), 5);

        let mid = TtsAnchorDto {
            quote: head_of(&chunks[2], 8),
            prefix: None,
            suffix: None,
        };
        assert_eq!(find_start_chunk_index_by_anchor(&text, &mid), 2);

        // 视口顶部落在句中：仍应从该句句首开始，而不是从句中截断
        let sentence_start = chunks[..3].iter().map(|c| c.chars().count() + 1).sum::<usize>();
        let inner = anchor_at(&text, sentence_start + 5, 8);
        assert_eq!(find_start_chunk_index_by_anchor(&text, &inner), 3);

        let head = TtsAnchorDto {
            quote: head_of(&chunks[0], 8),
            prefix: None,
            suffix: None,
        };
        assert_eq!(find_start_chunk_index_by_anchor(&text, &head), 0);
    }

    /// 同名句段在章内重复时，优先命中上下文吻合的那一次，而不是更早的重复句
    #[test]
    fn context_prefers_correct_occurrence_when_quote_repeats() {
        let repeated = "重复内容相同的一句话，用于验证上下文消歧。";
        let text = format!("开头的一句话。\n{}\n{}\n结尾的一句话。", repeated, repeated);
        let chunks = split_text_to_chunks(&text);
        assert_eq!(chunks.len(), 4);
        assert_eq!(chunks[1], repeated);
        assert_eq!(chunks[2], repeated);

        // 指向第 3 句（下标 2）的 anchor：上下文应把它消歧到后一次出现
        let offset: usize = chunks[..2].iter().map(|c| c.chars().count() + 1).sum();
        let anchor = anchor_at(&text, offset, 10);
        assert_eq!(find_start_chunk_index_by_anchor(&text, &anchor), 2);
    }

    /// 首批 cursor 与续读批必须落在同一套 chunk 下标坐标系上（不再回退重读）
    #[test]
    fn first_batch_cursor_keeps_monotonic_after_anchor_start() {
        let text = build_chapter(300);
        let chunks = split_text_to_chunks(&text);
        let start_index = 100usize;
        let start_position = TtsStartPosition {
            section_index: 0,
            anchor: Some(TtsAnchorDto {
                quote: head_of(&chunks[start_index], 10),
                prefix: None,
                suffix: None,
            }),
        };

        // 首批：cursor 为空 + 视口起点，起点应换算成原文坐标系的 chunk 下标
        let first_start = resolve_start_chunk_index(&text, 0, None, Some(&start_position));
        assert_eq!(first_start, start_index as i32);

        let first = slice_text_to_segments(SliceOptions {
            id_prefix: "epub:0",
            text: &text,
            section_index: 0,
            start_chunk_index: first_start,
            max_segments: 60,
            lang: None,
            encode_cursor: None,
        });
        assert_eq!(first.segments.len(), 60);
        assert!(first.has_more_in_text);
        assert_eq!(first.segments[0].chunk_index, start_index as i32);
        let first_last_chunk = first.segments.last().unwrap().chunk_index;

        // 续读批：cursor 非空，不能再按 anchor 二次换算（否则 chunk 下标整体回退）
        assert_eq!(
            resolve_start_chunk_index(&text, 0, Some("0:160"), Some(&start_position)),
            0
        );
        let second = slice_text_to_segments(SliceOptions {
            id_prefix: "epub:0",
            text: &text,
            section_index: 0,
            start_chunk_index: first.next_chunk_index,
            max_segments: 60,
            lang: None,
            encode_cursor: None,
        });
        assert!(second.segments[0].chunk_index > first_last_chunk);
    }
}


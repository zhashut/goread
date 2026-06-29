use crate::tts::cursor::encode_section_cursor;
use crate::tts::types::{TtsAnchorDto, TtsSegmentDto};

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


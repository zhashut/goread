//! MOBI 解析引擎
//! 策略：所有 filepos/offset 操作直接在 &[u8] 上完成，避免字节偏移与字符索引不一致
//! 流程：提取原始文本字节 → 在字节流上拆分章节 → 按段解码为 UTF-8

use std::collections::HashMap;
use std::path::Path;

use encoding_rs::Encoding;
use mobi::Mobi;
use once_cell::sync::Lazy;
use regex::Regex;

use super::cache::{BookInfo, TocItem};

// ====================== 字节正则（在 &[u8] 上匹配） ======================

/// 匹配 <body> 标签内容起始位置
static BODY_OPEN_RE: Lazy<regex::bytes::Regex> = Lazy::new(|| {
    regex::bytes::Regex::new(r"(?is)<body[^>]*>").unwrap()
});

/// 匹配 </body> 结束标签
static BODY_CLOSE_RE: Lazy<regex::bytes::Regex> = Lazy::new(|| {
    regex::bytes::Regex::new(r"(?is)</body>").unwrap()
});

/// 匹配分页标记（字节级）
static SPLIT_BYTES_RE: Lazy<regex::bytes::Regex> = Lazy::new(|| {
    regex::bytes::Regex::new(r#"(?i)<mbp:pagebreak\s*/?>\s*|<hr\s+class=["']?pagebreak["']?\s*/?>"#).unwrap()
});

/// 匹配 guide 中 <reference type="toc" filepos="N">（字节级）
static REF_TOC_BYTES_RE: Lazy<regex::bytes::Regex> = Lazy::new(|| {
    regex::bytes::Regex::new(r#"(?i)<reference[^>]+type\s*=\s*["']?toc["']?[^>]+filepos\s*=\s*["']?(\d+)["']?[^>]*>"#).unwrap()
});

/// 匹配 guide 中 filepos 在 type 前的变体（字节级）
static REF_TOC_ALT_BYTES_RE: Lazy<regex::bytes::Regex> = Lazy::new(|| {
    regex::bytes::Regex::new(r#"(?i)<reference[^>]+filepos\s*=\s*["']?(\d+)["']?[^>]+type\s*=\s*["']?toc["']?[^>]*>"#).unwrap()
});

/// 匹配 <a filepos="N">...</a> 锚点（字节级）
static ANCHOR_BYTES_RE: Lazy<regex::bytes::Regex> = Lazy::new(|| {
    regex::bytes::Regex::new(r#"(?is)<a[^>]+filepos\s*=\s*["']?(\d+)["']?[^>]*>(.*?)</a>"#).unwrap()
});

/// 匹配 guide 中 <reference type="cover" filepos="N">（字节级，封面提取）
static REF_COVER_BYTES_RE: Lazy<regex::bytes::Regex> = Lazy::new(|| {
    regex::bytes::Regex::new(r#"(?i)<reference[^>]+type\s*=\s*["']?cover["']?[^>]+filepos\s*=\s*["']?(\d+)["']?[^>]*>"#).unwrap()
});

/// 匹配 <img recindex="N">（字节级，封面提取用）
static IMG_RECINDEX_BYTES_RE: Lazy<regex::bytes::Regex> = Lazy::new(|| {
    regex::bytes::Regex::new(r#"(?i)<img[^>]+recindex\s*=\s*["']?(\d+)["']?[^>]*>"#).unwrap()
});

// ====================== 文本正则（在 UTF-8 String 上匹配） ======================

/// 匹配 <img recindex="N"> 图片引用（用于解码后的 HTML）
static RECINDEX_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?i)<img\s+([^>]*?)recindex\s*=\s*["']?(\d+)["']?([^>]*)>"#).unwrap()
});

/// 匹配 h1-h6 标题标签及内容
static HEADING_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)<h([1-6])[^>]*>(.*?)</h[1-6]>").unwrap()
});

/// 匹配 h1-h3 标题起始位置（用于按标题拆分）
static HEADING_POS_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)<h[1-3][^>]*>").unwrap()
});

/// 匹配中英文章节名模式（第X章/第X节/Chapter N 等）
static CHAPTER_PATTERN_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?m)(第[一二三四五六七八九十百千零\d]{1,6}[章节回卷篇]|Chapter\s+\d+|Part\s+\d+)").unwrap()
});

/// 匹配上级目录模式（篇/卷/Part）
static PART_LEVEL_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"第[一二三四五六七八九十百千零\d]{1,6}[篇卷]|Part\s+\d+").unwrap()
});

/// 匹配章级目录模式（章/节/回/Chapter）
static CHAPTER_LEVEL_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"第[一二三四五六七八九十百千零\d]{1,6}[章节回]|Chapter\s+\d+").unwrap()
});

/// 匹配首个 <p> 段落的文本内容
static FIRST_P_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?is)<p[^>]*>(.*?)</p>").unwrap()
});

/// 匹配资源占位符引用
static RES_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"__MOBI_RES__:([^\s"'>]+)"#).unwrap()
});

/// 匹配 HTML 标签（去除标签用）
static TAG_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"<[^>]*>").unwrap()
});

// ====================== 数据结构 ======================

#[derive(Debug)]
pub struct PreparedSection {
    pub index: u32,
    pub html: String,
    pub styles: Vec<String>,
    pub resource_refs: Vec<String>,
}

#[derive(Debug)]
pub struct PreparedResource {
    pub path: String,
    pub data: Vec<u8>,
    pub mime_type: String,
}

#[derive(Debug)]
pub struct MobiPreparedBook {
    pub book_info: BookInfo,
    pub toc: Vec<TocItem>,
    pub section_count: u32,
    pub sections: Vec<PreparedSection>,
    pub resources: Vec<PreparedResource>,
}

// ====================== 入口 ======================

/// 解析 MOBI 文件并返回预处理数据
pub fn prepare_book(file_path: &str) -> Result<MobiPreparedBook, String> {
    let path = Path::new(file_path);
    if !path.exists() {
        return Err(format!("MOBI 文件不存在: {}", file_path));
    }

    let raw_bytes = std::fs::read(file_path)
        .map_err(|e| format!("读取 MOBI 文件字节失败: {}", e))?;

    println!("[mobi-engine] 文件大小: {} bytes", raw_bytes.len());

    // mobi crate 对大文件可能触发 overflow panic，用 catch_unwind 保护
    let file_path_owned = file_path.to_string();
    let mobi_opt: Option<Mobi> = std::panic::catch_unwind(
        std::panic::AssertUnwindSafe(|| Mobi::from_path(&file_path_owned).ok())
    ).unwrap_or_else(|_| {
        println!("[mobi-engine] mobi crate panic，回退到纯字节解析");
        None
    });

    let image_records = extract_image_records_from_bytes(&raw_bytes);
    let (resources, image_map) = build_image_resources(&image_records);

    let encoding = detect_encoding(&raw_bytes);
    println!("[mobi-engine] 检测编码: {}", encoding.name());

    // 提取原始文本字节（解压后的字节流，保持 filepos 偏移一致）
    let raw_text = match extract_raw_text_bytes(&raw_bytes) {
        Some(t) if !t.is_empty() => t,
        _ => return Err("无法提取 MOBI 文本内容：原始字节解压失败".to_string()),
    };

    println!("[mobi-engine] 原始文本字节长度: {} bytes", raw_text.len());

    let (sections, toc) = split_into_sections(&raw_text, &image_map, encoding);
    let section_count = sections.len() as u32;

    let mut book_info = extract_metadata_safe(mobi_opt.as_ref(), file_path, &raw_bytes, &image_records);
    book_info.page_count = section_count as i32;

    println!("[mobi-engine] 拆分结果: sections={}, toc={}", section_count, toc.len());

    Ok(MobiPreparedBook { book_info, toc, section_count, sections, resources })
}

// ====================== PDB 解析 ======================

/// 解析 PDB 记录偏移表
fn parse_record_offsets(data: &[u8]) -> Option<Vec<usize>> {
    if data.len() < 82 { return None; }
    let num_records = u16::from_be_bytes([data[76], data[77]]) as usize;
    if num_records < 2 { return None; }

    let mut offsets = Vec::with_capacity(num_records);
    for i in 0..num_records {
        let base = 78 + i * 8;
        if base + 4 > data.len() { return None; }
        let offset = u32::from_be_bytes([data[base], data[base+1], data[base+2], data[base+3]]) as usize;
        offsets.push(offset);
    }
    Some(offsets)
}

/// 从 MOBI Header 检测文本编码
fn detect_encoding(data: &[u8]) -> &'static Encoding {
    if data.len() < 82 { return encoding_rs::UTF_8; }
    let record0_offset = u32::from_be_bytes([data[78], data[79], data[80], data[81]]) as usize;
    // PalmDOC header(16 bytes) + MOBI header 编码字段偏移 0x0C(12)
    let encoding_offset = record0_offset + 16 + 12;
    if encoding_offset + 4 > data.len() { return encoding_rs::UTF_8; }
    let val = u32::from_be_bytes([
        data[encoding_offset], data[encoding_offset + 1],
        data[encoding_offset + 2], data[encoding_offset + 3],
    ]);
    println!("[mobi-engine] 编码字段原始值: {}", val);
    match val {
        65001 => encoding_rs::UTF_8,
        1252 => encoding_rs::WINDOWS_1252,
        1250 => encoding_rs::WINDOWS_1250,
        1251 => encoding_rs::WINDOWS_1251,
        936 => encoding_rs::GBK,
        950 => encoding_rs::BIG5,
        949 => encoding_rs::EUC_KR,
        932 => encoding_rs::SHIFT_JIS,
        _ => encoding_rs::UTF_8,
    }
}

/// 提取并解压所有文本记录，返回原始字节流
fn extract_raw_text_bytes(data: &[u8]) -> Option<Vec<u8>> {
    let offsets = parse_record_offsets(data)?;
    let record0_start = offsets[0];
    if record0_start + 16 > data.len() { return None; }

    let compression = u16::from_be_bytes([data[record0_start], data[record0_start + 1]]);
    let text_record_count = u16::from_be_bytes([data[record0_start + 8], data[record0_start + 9]]) as usize;

    // 解压后文本的总字节数（record0 偏移 4-7）
    let text_length = u32::from_be_bytes([
        data[record0_start + 4], data[record0_start + 5],
        data[record0_start + 6], data[record0_start + 7],
    ]) as usize;

    // 解析 extra_data_flags，用于裁剪每条记录的尾部填充字节
    let extra_flags = parse_extra_data_flags(data, record0_start);
    println!("[mobi-engine] text_length={}, extra_flags=0x{:X}", text_length, extra_flags);

    let mut all_text = Vec::new();
    for i in 1..=text_record_count {
        if i >= offsets.len() { break; }
        let start = offsets[i];
        let end = if i + 1 < offsets.len() { offsets[i + 1] } else { data.len() };
        if start >= data.len() || end > data.len() || start >= end { continue; }

        // 裁剪 extra_data_flags 指定的尾部填充字节
        let record_data = trim_trailing_bytes(&data[start..end], extra_flags);

        match compression {
            1 => all_text.extend_from_slice(record_data),
            2 => all_text.extend(palmdoc_decompress(record_data)),
            _ => all_text.extend_from_slice(record_data),
        }
    }

    // 用 text_length 截断，裁掉解压后多余的填充字节
    if text_length > 0 && text_length < all_text.len() {
        all_text.truncate(text_length);
    }

    Some(all_text)
}

/// 从 MOBI header 解析 extra_data_flags
fn parse_extra_data_flags(data: &[u8], record0_start: usize) -> u16 {
    // MOBI header 起始于 record0 + 16（PalmDOC header 长度）
    let mobi_start = record0_start + 16;
    if mobi_start + 8 > data.len() { return 0; }

    // MOBI header 长度字段在偏移 4-7
    let mobi_len = u32::from_be_bytes([
        data[mobi_start + 4], data[mobi_start + 5],
        data[mobi_start + 6], data[mobi_start + 7],
    ]) as usize;

    // extra_data_flags 在 MOBI header 偏移 0xF2(242) 处（需要 header 长度 >= 0xF4）
    let flags_offset = mobi_start + 0xF2;
    if mobi_len >= 0xF4 && flags_offset + 2 <= data.len() {
        u16::from_be_bytes([data[flags_offset], data[flags_offset + 1]])
    } else {
        0
    }
}

/// 根据 extra_data_flags 裁剪记录尾部的填充字节
fn trim_trailing_bytes<'a>(record: &'a [u8], extra_flags: u16) -> &'a [u8] {
    if extra_flags == 0 || record.is_empty() {
        return record;
    }

    let mut trailing = 0usize;

    // bit 0 表示存在 multibyte overlap 字节，其数量由最后一个字节的低 4 位指示
    if extra_flags & 1 != 0 {
        let last = *record.last().unwrap() as usize;
        // 低 4 位表示需要跳过的字节数（包含本字节）
        trailing += last & 0x0F;
    }

    // bit 1+ 每个 set bit 表示一个变长尾部字段
    let mut flags = extra_flags >> 1;
    let mut pos = record.len().saturating_sub(trailing);
    while flags > 0 {
        if flags & 1 != 0 && pos > 0 {
            // 变长整数编码：从尾部向前读，每字节低 7 位为数据，最高位为继续标志
            let size = calc_variable_length_size(record, pos);
            trailing += size;
            pos = record.len().saturating_sub(trailing);
        }
        flags >>= 1;
    }

    let end = record.len().saturating_sub(trailing);
    &record[..end]
}

/// 计算变长整数编码的尾部字段长度
fn calc_variable_length_size(record: &[u8], pos: usize) -> usize {
    let mut size = 0usize;
    let mut i = pos;
    while i > 0 {
        i -= 1;
        size += 1;
        // 最高位为 1 表示这是最后一个字节
        if record[i] & 0x80 != 0 {
            break;
        }
        // 最多 4 字节
        if size >= 4 {
            break;
        }
    }
    size
}

/// PalmDOC LZ77 解压算法
fn palmdoc_decompress(input: &[u8]) -> Vec<u8> {
    let mut output = Vec::with_capacity(input.len() * 2);
    let mut i = 0;
    while i < input.len() {
        let byte = input[i];
        i += 1;
        match byte {
            0x00 => output.push(0),
            0x01..=0x08 => {
                let count = byte as usize;
                for _ in 0..count {
                    if i >= input.len() { break; }
                    output.push(input[i]);
                    i += 1;
                }
            }
            0x09..=0x7F => output.push(byte),
            0x80..=0xBF => {
                if i >= input.len() { break; }
                let next = input[i] as u16;
                i += 1;
                let pair = ((byte as u16) << 8) | next;
                let distance = ((pair >> 3) & 0x7FF) as usize;
                let length = ((pair & 0x07) + 3) as usize;
                if distance > 0 && distance <= output.len() {
                    let start = output.len() - distance;
                    for j in 0..length {
                        let b = output[start + (j % distance)];
                        output.push(b);
                    }
                }
            }
            0xC0..=0xFF => {
                output.push(b' ');
                output.push(byte ^ 0x80);
            }
        }
    }
    output
}

// ====================== 字节级拆分（核心修复） ======================

/// 在字节流中定位 <body> 内容区域的字节范围
fn find_body_range(raw: &[u8]) -> (usize, usize) {
    let body_start = BODY_OPEN_RE.find(raw).map(|m| m.end()).unwrap_or(0);
    let body_end = BODY_CLOSE_RE.find_at(raw, body_start).map(|m| m.start()).unwrap_or(raw.len());
    (body_start, body_end)
}

/// 在字节范围内定位所有 pagebreak 的位置和长度
fn find_pagebreaks(raw: &[u8], start: usize, end: usize) -> Vec<(usize, usize)> {
    let slice = &raw[start..end];
    SPLIT_BYTES_RE.find_iter(slice)
        .map(|m| (start + m.start(), start + m.end()))
        .collect()
}

/// 根据 pagebreak 位置将 body 区域分割为多个字节范围
fn compute_section_ranges(body_start: usize, body_end: usize, breaks: &[(usize, usize)]) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    let mut prev = body_start;
    for &(brk_start, brk_end) in breaks {
        if brk_start > prev {
            ranges.push((prev, brk_start));
        }
        prev = brk_end;
    }
    if prev < body_end {
        ranges.push((prev, body_end));
    }
    ranges
}

/// 将字节范围解码为 UTF-8 字符串，在精确字节位置插入锚点，替换图片引用，构建 section
fn decode_and_build_section(
    raw_text: &[u8],
    start: usize,
    end: usize,
    encoding: &'static Encoding,
    image_map: &HashMap<usize, String>,
    index: u32,
    filepos_anchors: &[usize],
) -> Option<PreparedSection> {
    let s = start.min(raw_text.len());
    let e = end.min(raw_text.len());
    if s >= e { return None; }

    // 收集落在 [s, e) 范围内的 filepos，按偏移排序去重
    let mut anchors_in_range: Vec<usize> = filepos_anchors.iter()
        .copied()
        .filter(|&fp| fp > s && fp < e)
        .collect();
    anchors_in_range.sort_unstable();
    anchors_in_range.dedup();

    let html = if anchors_in_range.is_empty() {
        let (decoded, _, _) = encoding.decode(&raw_text[s..e]);
        replace_recindex(decoded.trim(), image_map)
    } else {
        // 按锚点位置将字节切片拆分，在切分点插入锚点标签
        let mut result = String::new();
        let mut cur = s;
        for fp in &anchors_in_range {
            let (seg, _, _) = encoding.decode(&raw_text[cur..*fp]);
            result.push_str(&replace_recindex(&seg, image_map));
            result.push_str(&format!(r#"<span id="filepos{}"></span>"#, fp));
            cur = *fp;
        }
        let (tail, _, _) = encoding.decode(&raw_text[cur..e]);
        result.push_str(&replace_recindex(&tail, image_map));
        result
    };

    let trimmed = html.trim();
    if trimmed.is_empty() { return None; }
    Some(build_section(trimmed.to_string(), index))
}

/// 按分页标记拆分章节并提取目录（完全基于字节操作）
fn split_into_sections(
    raw_text: &[u8],
    image_map: &HashMap<usize, String>,
    encoding: &'static Encoding,
) -> (Vec<PreparedSection>, Vec<TocItem>) {
    let (body_start, body_end) = find_body_range(raw_text);

    if body_start >= body_end {
        return (vec![], vec![]);
    }

    println!("[mobi-engine] body 字节范围: {}..{} ({} bytes)", body_start, body_end, body_end - body_start);

    // 在 body 区域查找 pagebreak
    let breaks = find_pagebreaks(raw_text, body_start, body_end);
    println!("[mobi-engine] pagebreak 数量: {}", breaks.len());

    if !breaks.is_empty() {
        let ranges = compute_section_ranges(body_start, body_end, &breaks);

        if ranges.len() > 1 {
            // 先提取 TOC 和 filepos 锚点列表
            let (toc, filepos_anchors) = extract_toc_from_guide(raw_text, encoding, &ranges);
            let anchor_fps: Vec<usize> = filepos_anchors.iter().map(|(_, fp)| *fp).collect();

            // 解码时将锚点精确注入到对应字节位置
            let mut sections = Vec::new();
            let mut valid_ranges = Vec::new();
            for &(start, end) in &ranges {
                let anchors_for_section = if !toc.is_empty() { &anchor_fps[..] } else { &[] };
                if let Some(section) = decode_and_build_section(raw_text, start, end, encoding, image_map, sections.len() as u32, anchors_for_section) {
                    sections.push(section);
                    valid_ranges.push((start, end));
                }
            }

            if !toc.is_empty() {
                return (sections, toc);
            }
            let toc = build_toc_from_sections(&mut sections);
            return (sections, toc);
        }
    }

    // pagebreak 不足，用单 section 解码（无锚点注入）
    if let Some(section) = decode_and_build_section(raw_text, body_start, body_end, encoding, image_map, 0, &[]) {
        let html = &section.html;

        let (sections, toc) = split_by_headings(html);
        println!("[mobi-engine] 标题拆分: {} 段", sections.len());
        if sections.len() > 1 {
            return (sections, toc);
        }

        let (sections, toc) = split_by_chapter_pattern(html);
        println!("[mobi-engine] 章节名拆分: {} 段", sections.len());
        if sections.len() > 1 {
            return (sections, toc);
        }

        // 最终兜底：按固定长度拆分
        return split_by_length(html, 4000);
    }

    (vec![], vec![])
}

// ====================== 目录提取（字节安全） ======================

/// 从字节中解析 ASCII 数字字符串为 usize
fn parse_ascii_number(bytes: &[u8]) -> Option<usize> {
    std::str::from_utf8(bytes).ok().and_then(|s| s.parse().ok())
}

/// 从原始字节流中提取 guide TOC（完全在字节级操作）
fn extract_toc_from_guide(
    raw_text: &[u8],
    encoding: &'static Encoding,
    section_byte_ranges: &[(usize, usize)],
) -> (Vec<TocItem>, Vec<(u32, usize)>) {
    // 在字节流中找 <reference type="toc" filepos="N">
    let toc_filepos = REF_TOC_BYTES_RE.captures(raw_text)
        .or_else(|| REF_TOC_ALT_BYTES_RE.captures(raw_text))
        .and_then(|caps| caps.get(1))
        .and_then(|m| parse_ascii_number(m.as_bytes()))
        .unwrap_or(0);

    // 确定 TOC 页所在的字节区域
    let toc_region = if toc_filepos > 0 && toc_filepos < raw_text.len() {
        // 从 filepos 到下一个 pagebreak 或最多 50KB
        let region_end = SPLIT_BYTES_RE.find_at(raw_text, toc_filepos)
            .map(|m| m.start())
            .unwrap_or_else(|| (toc_filepos + 50000).min(raw_text.len()));
        &raw_text[toc_filepos..region_end]
    } else {
        // 找包含最多 <a filepos> 的 section
        find_best_toc_section(raw_text, section_byte_ranges)
    };

    if toc_region.is_empty() {
        return (vec![], vec![]);
    }

    // 提取所有 <a filepos="N">title</a>
    let mut entries: Vec<(usize, String)> = Vec::new();
    for caps in ANCHOR_BYTES_RE.captures_iter(toc_region) {
        let fp = match caps.get(1).and_then(|m| parse_ascii_number(m.as_bytes())) {
            Some(v) if v > 0 => v,
            _ => continue,
        };

        // 标题字节用实际编码解码
        if let Some(title_match) = caps.get(2) {
            let (decoded_title, _, _) = encoding.decode(title_match.as_bytes());
            let title = strip_html_tags(&decoded_title).trim().to_string();
            if !title.is_empty() {
                entries.push((fp, title));
            }
        }
    }

    if entries.is_empty() {
        return (vec![], vec![]);
    }

    // filepos → section index 映射并构建层级目录
    let mut filepos_anchors = Vec::new();
    let toc = build_toc_with_hierarchy(&entries, section_byte_ranges, &mut filepos_anchors);
    println!("[mobi-engine] guide TOC 提取: {} 项", toc.len());
    (toc, filepos_anchors)
}

/// 找包含最多 <a filepos> 链接的 section（用于定位 TOC 页）
fn find_best_toc_section<'a>(raw_text: &'a [u8], section_byte_ranges: &[(usize, usize)]) -> &'a [u8] {
    let mut best_start = 0usize;
    let mut best_end = 0usize;
    let mut best_count = 0usize;

    for &(start, end) in section_byte_ranges {
        let s = start.min(raw_text.len());
        let e = end.min(raw_text.len());
        let count = ANCHOR_BYTES_RE.captures_iter(&raw_text[s..e]).count();
        if count > best_count {
            best_count = count;
            best_start = s;
            best_end = e;
        }
    }

    if best_count < 3 {
        return &[];
    }
    &raw_text[best_start..best_end]
}

/// 构建带层级的 TOC 列表
/// filepos 精确匹配失败时查找最近的后续 section
fn build_toc_with_hierarchy(
    entries: &[(usize, String)],
    section_byte_ranges: &[(usize, usize)],
    filepos_anchors: &mut Vec<(u32, usize)>,
) -> Vec<TocItem> {
    let mut toc = Vec::new();

    for (filepos, title) in entries {
        // 精确匹配：filepos 落在某个 section 的字节范围内
        let section_index = section_byte_ranges
            .iter()
            .position(|&(start, end)| *filepos >= start && *filepos < end)
            .or_else(|| {
                section_byte_ranges
                    .iter()
                    .enumerate()
                    .filter(|(_, &(start, _))| start > *filepos)
                    .min_by_key(|(_, &(start, _))| start)
                    .map(|(idx, _)| idx)
            })
            .unwrap_or(0) as u32;

        let location = format!("section:{}#filepos{}", section_index, filepos);
        filepos_anchors.push((section_index, *filepos));

        toc.push(TocItem {
            title: Some(title.clone()),
            location: Some(location),
            level: 0,
            children: vec![],
        });
    }
    infer_toc_hierarchy(&mut toc);
    toc
}

// inject_filepos_anchors 已移除，锚点在 decode_and_build_section 中精确注入

/// 根据标题文字模式推断目录层级，并构建嵌套树结构
/// 篇/卷 → level 0（上级），章/节/回 → level 1（子级）
fn infer_toc_hierarchy(toc: &mut Vec<TocItem>) {
    if toc.len() < 2 {
        return;
    }

    // 检查是否同时存在篇/卷级和章/节/回级的标题
    let has_part = toc.iter().any(|item| {
        item.title.as_ref().map_or(false, |t| PART_LEVEL_RE.is_match(t))
    });
    let has_chapter = toc.iter().any(|item| {
        item.title.as_ref().map_or(false, |t| CHAPTER_LEVEL_RE.is_match(t))
    });

    if has_part && has_chapter {
        // 标记 level：篇/卷=0, 章/节/回=1
        for item in toc.iter_mut() {
            if let Some(ref title) = item.title {
                if PART_LEVEL_RE.is_match(title) {
                    item.level = 0;
                } else if CHAPTER_LEVEL_RE.is_match(title) {
                    item.level = 1;
                }
            }
        }
    } else {
        // 利用 heading 标签的 level 差异归一化
        let min_level = toc.iter().map(|item| item.level).min().unwrap_or(0);
        let max_level = toc.iter().map(|item| item.level).max().unwrap_or(0);
        if min_level == max_level {
            return;
        }
        if min_level > 0 {
            for item in toc.iter_mut() {
                item.level -= min_level;
            }
        }
    }

    // 将平级列表按 level 构建为嵌套树
    nest_toc_by_level(toc);
}

/// 将平级 TOC 列表按 level 嵌套为父子树结构
/// level=0 的条目作为顶级节点，后续 level>0 的条目归入最近的上级 children
fn nest_toc_by_level(toc: &mut Vec<TocItem>) {
    // 检查是否存在多级结构
    let has_hierarchy = toc.iter().any(|item| item.level > 0);
    if !has_hierarchy {
        return;
    }

    let items = std::mem::take(toc);
    let mut result: Vec<TocItem> = Vec::new();

    for item in items {
        if item.level == 0 {
            // 顶级条目直接加入结果
            result.push(item);
        } else if let Some(parent) = result.last_mut() {
            // 子级条目归入最近的顶级条目
            parent.children.push(item);
        } else {
            // 没有父级时作为顶级条目兜底
            result.push(item);
        }
    }

    *toc = result;
}

fn build_toc_from_sections(sections: &mut [PreparedSection]) -> Vec<TocItem> {
    let mut toc = Vec::new();
    let section_count = sections.len();

    for (i, section) in sections.iter_mut().enumerate() {
        let original_html = section.html.clone();
        let mut new_html = String::new();
        let mut last_end = 0usize;
        let mut heading_index = 0usize;

        for caps in HEADING_RE.captures_iter(&original_html) {
            let m = match caps.get(0) {
                Some(m) => m,
                None => continue,
            };
            let start = m.start();
            let end = m.end();
            let level: i32 = caps.get(1)
                .and_then(|m| m.as_str().parse().ok())
                .unwrap_or(1);
            let title = strip_html_tags(&caps[2]).trim().to_string();
            if title.is_empty() || title.len() >= 200 {
                continue;
            }

            new_html.push_str(&original_html[last_end..start]);
            let anchor_id = format!("mobi-h-{}-{}", section.index, heading_index);
            heading_index += 1;
            new_html.push_str(&format!(r#"<span id="{}"></span>"#, anchor_id));
            new_html.push_str(&original_html[start..end]);
            last_end = end;

            toc.push(TocItem {
                title: Some(title),
                location: Some(format!("section:{}#{}", section.index, anchor_id)),
                level: (level - 1).min(2),
                children: vec![],
            });
        }

        if heading_index > 0 {
            new_html.push_str(&original_html[last_end..]);
            section.html = new_html;
            continue;
        }

        let first_p_text = FIRST_P_RE.captures(&original_html)
            .and_then(|c| c.get(1))
            .map(|m| strip_html_tags(m.as_str()).trim().to_string())
            .filter(|s| !s.is_empty() && s.len() < 100)
            .filter(|s| is_title_like(s));

        if let Some(text) = first_p_text {
            let display = if text.len() > 50 {
                format!("{}...", &text[..text.char_indices().nth(50).map(|(i, _)| i).unwrap_or(text.len())])
            } else {
                text
            };
            toc.push(TocItem {
                title: Some(display),
                location: Some(format!("section:{}", section.index)),
                level: 0,
                children: vec![],
            });
        } else if section_count <= 20 {
            toc.push(TocItem {
                title: Some(format!("第 {} 章", i + 1)),
                location: Some(format!("section:{}", section.index)),
                level: 0,
                children: vec![],
            });
        }
    }

    // 条目过多时精简为 h1/h2 级别并限制数量
    if toc.len() > 100 {
        println!("[mobi-engine] TOC 条目过多({}), 精简为 h1/h2", toc.len());
        toc = toc.into_iter()
            .filter(|item| item.level <= 1)
            .take(100)
            .collect();
    }

    infer_toc_hierarchy(&mut toc);
    println!("[mobi-engine] 从 sections 解析 TOC: {} 项", toc.len());
    toc
}

// ====================== 降级拆分策略 ======================

/// 按中文/英文章节名模式拆分 HTML
fn split_by_chapter_pattern(html: &str) -> (Vec<PreparedSection>, Vec<TocItem>) {
    let positions: Vec<(usize, String)> = CHAPTER_PATTERN_RE.find_iter(html)
        .map(|m| (m.start(), m.as_str().to_string()))
        .collect();

    if positions.is_empty() {
        return (vec![build_section(html.to_string(), 0)], vec![]);
    }

    let mut sections = Vec::new();
    let mut toc = Vec::new();

    // 章节名前的前言内容
    if positions[0].0 > 0 {
        let preface = html[..positions[0].0].trim();
        if !preface.is_empty() {
            sections.push(build_section(preface.to_string(), 0));
        }
    }

    for (i, (pos, chapter_name)) in positions.iter().enumerate() {
        let end = positions.get(i + 1).map(|(p, _)| *p).unwrap_or(html.len());
        let content = html[*pos..end].trim();
        if content.is_empty() { continue; }

        let index = sections.len() as u32;
        toc.push(TocItem {
            title: Some(chapter_name.clone()),
            location: Some(format!("section:{}", index)),
            level: 0,
            children: vec![],
        });
        sections.push(build_section(content.to_string(), index));
    }

    infer_toc_hierarchy(&mut toc);
    (sections, toc)
}

/// 按 h1-h3 标题拆分 HTML（解码后的 UTF-8 字符串）
fn split_by_headings(html: &str) -> (Vec<PreparedSection>, Vec<TocItem>) {
    let positions: Vec<usize> = HEADING_POS_RE.find_iter(html).map(|m| m.start()).collect();

    if positions.is_empty() {
        return (vec![build_section(html.to_string(), 0)], vec![]);
    }

    let mut sections = Vec::new();

    // 标题前的前言内容
    if positions[0] > 0 {
        let preface = html[..positions[0]].trim();
        if !preface.is_empty() {
            sections.push(build_section(preface.to_string(), 0));
        }
    }

    for (i, &pos) in positions.iter().enumerate() {
        let end = positions.get(i + 1).copied().unwrap_or(html.len());
        let content = html[pos..end].trim();
        if content.is_empty() { continue; }
        sections.push(build_section(content.to_string(), sections.len() as u32));
    }

    let mut sections_mut = sections;
    let toc = build_toc_from_sections(&mut sections_mut);
    (sections_mut, toc)
}

/// 按固定字符长度拆分 HTML（最终兜底策略）
fn split_by_length(html: &str, chunk_size: usize) -> (Vec<PreparedSection>, Vec<TocItem>) {
    let mut sections = Vec::new();
    let mut toc = Vec::new();
    let chars: Vec<char> = html.chars().collect();
    let total = chars.len();
    let mut start = 0;

    while start < total {
        let end = (start + chunk_size).min(total);
        let content: String = chars[start..end].iter().collect();
        if !content.trim().is_empty() {
            let index = sections.len() as u32;
            toc.push(TocItem {
                title: Some(format!("第 {} 页", index + 1)),
                location: Some(format!("section:{}", index)),
                level: 0,
                children: vec![],
            });
            sections.push(build_section(content, index));
        }
        start = end;
    }

    println!("[mobi-engine] 长度拆分: {} 段 (chunk_size={})", sections.len(), chunk_size);
    (sections, toc)
}

// ====================== 图片与资源 ======================

/// 从 PDB 记录中提取所有图片记录，返回 (绝对记录索引, 图片数据)
fn extract_image_records_from_bytes(data: &[u8]) -> Vec<(usize, Vec<u8>)> {
    let offsets = match parse_record_offsets(data) {
        Some(o) => o,
        None => return vec![],
    };

    let mut images = Vec::new();
    for i in 0..offsets.len() {
        let start = offsets[i];
        let end = if i + 1 < offsets.len() { offsets[i + 1] } else { data.len() };
        if start >= data.len() || end > data.len() || start >= end { continue; }
        let record_data = &data[start..end];
        if record_data.len() >= 4 && is_image_data(record_data) {
            images.push((i, record_data.to_vec()));
        }
    }
    images
}

/// 通过 magic bytes 判断数据是否为图片
fn is_image_data(data: &[u8]) -> bool {
    if data.len() < 4 { return false; }
    data[0] == 0xFF && data[1] == 0xD8             // JPEG
        || data.starts_with(&[0x89, 0x50, 0x4E, 0x47]) // PNG
        || data.starts_with(&[0x47, 0x49, 0x46])       // GIF
        || data.starts_with(b"BM")                      // BMP
        || (data.len() > 12 && &data[8..12] == b"WEBP") // WEBP
}

/// 将图片记录构建为资源列表和 recindex 映射
fn build_image_resources(image_records: &[(usize, Vec<u8>)]) -> (Vec<PreparedResource>, HashMap<usize, String>) {
    let mut resources = Vec::new();
    let mut image_map = HashMap::new();

    if image_records.is_empty() {
        return (resources, image_map);
    }

    let first_image_index = image_records[0].0;

    for (abs_index, img_data) in image_records {
        let recindex = abs_index - first_image_index + 1;
        let mime = guess_image_mime(img_data);
        let ext = mime_to_ext(&mime);
        let path = format!("images/img_{}.{}", recindex, ext);

        resources.push(PreparedResource {
            path: path.clone(),
            data: img_data.clone(),
            mime_type: mime,
        });
        image_map.insert(recindex, path);
    }

    (resources, image_map)
}

// ====================== 封面提取（三层策略） ======================

/// 解析 MOBI header 信息（偏移表、EXTH 位置等）
struct MobiHeaderInfo {
    mobi_header_offset: usize,
    mobi_header_len: usize,
    first_image_index: usize,
    exth_start: usize,
    exth_count: usize,
    exth_end: usize,
}

/// 解析 MOBI/EXTH 头部基础信息
fn parse_mobi_header(data: &[u8]) -> Option<MobiHeaderInfo> {
    let offsets = parse_record_offsets(data)?;
    let record0_start = offsets[0];
    let mobi_header_offset = record0_start + 16;
    if mobi_header_offset + 0x74 > data.len() { return None; }

    // MOBI header 长度
    let mobi_header_len = u32::from_be_bytes([
        data[mobi_header_offset + 4], data[mobi_header_offset + 5],
        data[mobi_header_offset + 6], data[mobi_header_offset + 7],
    ]) as usize;

    // first_image_index 在 MOBI header 偏移 0x6C(108) - 相对 PalmDOC header 起始
    let fii_offset = record0_start + 0x6C;
    let first_image_index = if fii_offset + 4 <= data.len() {
        u32::from_be_bytes([data[fii_offset], data[fii_offset+1], data[fii_offset+2], data[fii_offset+3]]) as usize
    } else {
        0
    };

    // EXTH 标志位在 MOBI header 偏移 0x70(112)
    let exth_flag_offset = mobi_header_offset + 0x70;
    if exth_flag_offset + 4 > data.len() { return None; }
    let exth_flag = u32::from_be_bytes([
        data[exth_flag_offset], data[exth_flag_offset + 1],
        data[exth_flag_offset + 2], data[exth_flag_offset + 3],
    ]);
    if exth_flag & 0x40 == 0 {
        println!("[mobi-engine] EXTH 头部不存在");
        return None;
    }

    // EXTH header 紧跟在 MOBI header 之后
    let exth_start = mobi_header_offset + mobi_header_len;
    if exth_start + 12 > data.len() { return None; }
    if &data[exth_start..exth_start + 4] != b"EXTH" {
        println!("[mobi-engine] EXTH magic 不匹配");
        return None;
    }

    let exth_len = u32::from_be_bytes([
        data[exth_start + 4], data[exth_start + 5],
        data[exth_start + 6], data[exth_start + 7],
    ]) as usize;
    let exth_count = u32::from_be_bytes([
        data[exth_start + 8], data[exth_start + 9],
        data[exth_start + 10], data[exth_start + 11],
    ]) as usize;
    let exth_end = (exth_start + exth_len).min(data.len());

    println!("[mobi-engine] EXTH: start={}, count={}, first_image_index={}", exth_start, exth_count, first_image_index);

    Some(MobiHeaderInfo {
        mobi_header_offset,
        mobi_header_len,
        first_image_index,
        exth_start,
        exth_count,
        exth_end,
    })
}

/// 遍历 EXTH 记录，查找指定 type 的值
fn find_exth_record(data: &[u8], info: &MobiHeaderInfo, target_type: u32) -> Option<Vec<u8>> {
    let mut pos = info.exth_start + 12;
    for _ in 0..info.exth_count {
        if pos + 8 > info.exth_end { break; }
        let rec_type = u32::from_be_bytes([data[pos], data[pos+1], data[pos+2], data[pos+3]]);
        let rec_len = u32::from_be_bytes([data[pos+4], data[pos+5], data[pos+6], data[pos+7]]) as usize;
        if rec_len < 8 || pos + rec_len > info.exth_end { break; }

        if rec_type == target_type {
            return Some(data[pos+8..pos+rec_len].to_vec());
        }
        pos += rec_len;
    }
    None
}

/// 从 EXTH 头部提取封面（record type 201 = CoverOffset）
fn extract_cover_from_exth(data: &[u8], image_records: &[(usize, Vec<u8>)]) -> Option<Vec<u8>> {
    let info = parse_mobi_header(data)?;
    let cover_bytes = find_exth_record(data, &info, 201)?;
    if cover_bytes.len() < 4 { return None; }

    let cover_offset = u32::from_be_bytes([
        cover_bytes[0], cover_bytes[1], cover_bytes[2], cover_bytes[3],
    ]) as usize;

    // CoverOffset 相对于 first_image_index（PDB 记录序号）
    let target_record_idx = info.first_image_index + cover_offset;
    println!("[mobi-engine] EXTH 封面: cover_offset={}, target_record={}", cover_offset, target_record_idx);

    image_records.iter()
        .find(|(idx, _)| *idx == target_record_idx)
        .map(|(_, img_data)| img_data.clone())
}

/// 从 guide 中的 cover 引用提取封面
fn extract_cover_from_guide(raw_text: &[u8], image_records: &[(usize, Vec<u8>)]) -> Option<Vec<u8>> {
    let caps = REF_COVER_BYTES_RE.captures(raw_text)?;
    let filepos = caps.get(1).and_then(|m| parse_ascii_number(m.as_bytes()))?;

    if filepos >= raw_text.len() { return None; }

    // 在 filepos 附近 2KB 范围内找 <img recindex="N">
    let search_end = (filepos + 2048).min(raw_text.len());
    let region = &raw_text[filepos..search_end];
    let img_caps = IMG_RECINDEX_BYTES_RE.captures(region)?;
    let recindex: usize = img_caps.get(1).and_then(|m| parse_ascii_number(m.as_bytes()))?;

    if image_records.is_empty() { return None; }
    let first_img_idx = image_records[0].0;
    let target_idx = first_img_idx + recindex - 1;

    image_records.iter()
        .find(|(idx, _)| *idx == target_idx)
        .map(|(_, img_data)| img_data.clone())
}

/// 启发式封面选择：排除小图标，取最大图片
fn extract_cover_heuristic(image_records: &[(usize, Vec<u8>)]) -> Option<Vec<u8>> {
    image_records.iter()
        .filter(|(_, data)| data.len() > 1024) // 排除 < 1KB 的小图标
        .max_by_key(|(_, data)| data.len())
        .map(|(_, data)| data.clone())
}

/// 从 EXTH 头部提取元数据（mobi crate 不可用时的回退策略）
fn extract_metadata_from_exth(data: &[u8], encoding: &'static Encoding) -> (Option<String>, Option<String>, Option<String>, Option<String>) {
    let info = match parse_mobi_header(data) {
        Some(i) => i,
        None => return (None, None, None, None),
    };

    let decode = |bytes: Vec<u8>| -> Option<String> {
        let (decoded, _, _) = encoding.decode(&bytes);
        let s = decoded.trim().to_string();
        if s.is_empty() { None } else { Some(s) }
    };

    let title = find_exth_record(data, &info, 503).and_then(decode);   // 更新标题
    let author = find_exth_record(data, &info, 100).and_then(decode);
    let description = find_exth_record(data, &info, 103).and_then(decode);
    let publisher = find_exth_record(data, &info, 101).and_then(decode);

    println!("[mobi-engine] EXTH 元数据: title={:?}, author={:?}", title, author);
    (title, author, description, publisher)
}

/// 提取元数据（含 mobi crate 回退 + 三层封面策略）
fn extract_metadata_safe(
    mobi_opt: Option<&Mobi>,
    original_path: &str,
    raw_bytes: &[u8],
    image_records: &[(usize, Vec<u8>)],
) -> BookInfo {
    use base64::{engine::general_purpose, Engine as _};

    // 优先用 mobi crate 提取元数据，失败时从 EXTH 直接提取
    let (title, author, description, publisher) = match mobi_opt {
        Some(m) => (
            m.title().cloned().filter(|s| !s.is_empty()),
            m.author().cloned().filter(|s| !s.is_empty()),
            m.description().cloned().filter(|s| !s.is_empty()),
            m.publisher().cloned().filter(|s| !s.is_empty()),
        ),
        None => {
            println!("[mobi-engine] mobi crate 不可用，从 EXTH 提取元数据");
            extract_metadata_from_exth(raw_bytes, detect_encoding(raw_bytes))
        }
    };

    // 三层封面提取策略
    let raw_text = extract_raw_text_bytes(raw_bytes).unwrap_or_default();
    let cover_data = extract_cover_from_exth(raw_bytes, image_records)
        .or_else(|| {
            println!("[mobi-engine] EXTH 封面未找到，尝试 guide 策略");
            extract_cover_from_guide(&raw_text, image_records)
        })
        .or_else(|| {
            println!("[mobi-engine] guide 封面未找到，使用启发式策略");
            extract_cover_heuristic(image_records)
        });

    println!("[mobi-engine] 封面提取: {}", if cover_data.is_some() { "成功" } else { "失败" });

    let cover_image = cover_data.map(|img| {
        let mime = guess_image_mime(&img);
        let encoded = general_purpose::STANDARD.encode(&img);
        format!("data:{};base64,{}", mime, encoded)
    });

    let format = if original_path.to_lowercase().ends_with(".azw3")
        || original_path.to_lowercase().ends_with(".azw")
    {
        "azw3".to_string()
    } else {
        "mobi".to_string()
    };

    BookInfo {
        title,
        author,
        description,
        publisher,
        language: None,
        page_count: 1,
        format,
        cover_image,
    }
}

// ====================== 工具函数 ======================

/// 根据 magic bytes 猜测 MIME 类型
fn guess_image_mime(data: &[u8]) -> String {
    if data.len() < 4 { return "image/jpeg".to_string(); }
    if data.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        "image/png".to_string()
    } else if data.starts_with(&[0x47, 0x49, 0x46]) {
        "image/gif".to_string()
    } else if data.starts_with(b"BM") {
        "image/bmp".to_string()
    } else if data.len() > 12 && &data[8..12] == b"WEBP" {
        "image/webp".to_string()
    } else {
        "image/jpeg".to_string()
    }
}

/// MIME → 扩展名
fn mime_to_ext(mime: &str) -> &str {
    match mime {
        "image/png" => "png",
        "image/gif" => "gif",
        "image/bmp" => "bmp",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        _ => "jpg",
    }
}

/// 提取 HTML 中的资源引用列表（去重）
fn extract_resource_refs(html: &str) -> Vec<String> {
    RES_RE.captures_iter(html)
        .filter_map(|c| c.get(1).map(|m| m.as_str().to_string()))
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect()
}

/// 构建 PreparedSection
fn build_section(content: String, index: u32) -> PreparedSection {
    let resource_refs = extract_resource_refs(&content);
    PreparedSection {
        index,
        html: content,
        styles: vec![],
        resource_refs,
    }
}

/// 替换 recindex 图片引用为资源占位符
fn replace_recindex(html: &str, image_map: &HashMap<usize, String>) -> String {
    RECINDEX_RE.replace_all(html, |caps: &regex::Captures| {
        let before = &caps[1];
        let idx: usize = caps[2].parse().unwrap_or(0);
        let after = &caps[3];
        match image_map.get(&idx) {
            Some(path) => format!("<img {}src=\"__MOBI_RES__:{}\"{}/> ", before, path, after),
            None => caps[0].to_string(),
        }
    }).into_owned()
}

/// 判断文本是否像章节标题（排除对话、叙述等正文内容）
fn is_title_like(text: &str) -> bool {
    // 匹配已知章节模式直接通过
    if CHAPTER_PATTERN_RE.is_match(text) {
        return true;
    }
    // 含对话/引用标记的不是标题
    let dialogue_markers = [':', '：', '"', '\u{201c}', '\u{201d}', '「', '」'];
    if text.contains("——") || dialogue_markers.iter().any(|&c| text.contains(c)) {
        return false;
    }
    // 超过 30 个字符且不含章节关键词的大概率是正文
    if text.chars().count() > 30 {
        return false;
    }
    true
}

/// 去除 HTML 标签
fn strip_html_tags(html: &str) -> String {
    TAG_RE.replace_all(html, "").to_string()
}

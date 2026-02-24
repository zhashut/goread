//! 图片资源提取、封面三层策略、元数据提取

use std::collections::HashMap;

use encoding_rs::Encoding;
use mobi::Mobi;

use super::pdb::{detect_encoding, extract_raw_text_bytes, parse_record_offsets};
use super::utils::{guess_image_mime, mime_to_ext, strip_html_tags};
use super::PreparedResource;
use crate::formats::mobi::cache::BookInfo;

use super::patterns::{IMG_RECINDEX_BYTES_RE, REF_COVER_BYTES_RE};

// ====================== 图片与资源 ======================

/// 从 PDB 记录中提取所有图片记录，返回 (绝对记录索引, 图片数据)
pub(super) fn extract_image_records_from_bytes(data: &[u8]) -> Vec<(usize, Vec<u8>)> {
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
pub(super) fn build_image_resources(image_records: &[(usize, Vec<u8>)]) -> (Vec<PreparedResource>, HashMap<usize, String>) {
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

/// 从字节中解析 ASCII 数字字符串为 usize
fn parse_ascii_number(bytes: &[u8]) -> Option<usize> {
    std::str::from_utf8(bytes).ok().and_then(|s| s.parse().ok())
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
pub(super) fn extract_metadata_safe(
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

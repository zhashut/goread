//! MOBI 解析引擎
//! 策略：所有 filepos/offset 操作直接在 &[u8] 上完成，避免字节偏移与字符索引不一致
//! 流程：提取原始文本字节 → 在字节流上拆分章节 → 按段解码为 UTF-8

#[path = "engine/patterns.rs"]
mod patterns;
#[path = "engine/pdb.rs"]
mod pdb;
#[path = "engine/resource.rs"]
mod resource;
#[path = "engine/section.rs"]
mod section;
#[path = "engine/utils.rs"]
mod utils;

use std::path::Path;

use mobi::Mobi;

use super::cache::{BookInfo, TocItem};

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

    let image_records = resource::extract_image_records_from_bytes(&raw_bytes);
    let (resources, image_map) = resource::build_image_resources(&image_records);

    let encoding = pdb::detect_encoding(&raw_bytes);
    println!("[mobi-engine] 检测编码: {}", encoding.name());

    // 提取原始文本字节（解压后的字节流，保持 filepos 偏移一致）
    let raw_text = match pdb::extract_raw_text_bytes(&raw_bytes) {
        Some(t) if !t.is_empty() => t,
        _ => return Err("无法提取 MOBI 文本内容：原始字节解压失败".to_string()),
    };

    println!("[mobi-engine] 原始文本字节长度: {} bytes", raw_text.len());

    // 打印解码后的内容采样，用于排查乱码
    let sample_end = raw_text.len().min(200);
    let (sample_decoded, _, _) = encoding.decode(&raw_text[..sample_end]);
    println!("[mobi-engine] 解码采样(前200字节): {}", sample_decoded.chars().take(100).collect::<String>());

    // 扫描整个文本寻找无效 UTF-8 序列（乱码诊断）
    pdb::scan_for_encoding_errors(&raw_text, encoding);

    let (sections, toc) = section::split_into_sections(&raw_text, &image_map, encoding);
    let section_count = sections.len() as u32;

    let mut book_info = resource::extract_metadata_safe(mobi_opt.as_ref(), file_path, &raw_bytes, &image_records);
    book_info.page_count = section_count as i32;

    println!("[mobi-engine] 拆分结果: sections={}, toc={}", section_count, toc.len());

    Ok(MobiPreparedBook { book_info, toc, section_count, sections, resources })
}

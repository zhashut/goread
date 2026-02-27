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
use std::time::Instant;

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
    let overall_start = Instant::now();
    println!("[mobi-engine] 开始解析: {}", file_path);

    let path = Path::new(file_path);
    if !path.exists() {
        return Err(format!("MOBI 文件不存在: {}", file_path));
    }

    let read_start = Instant::now();
    let raw_bytes = std::fs::read(file_path).map_err(|e| format!("读取 MOBI 文件字节失败: {}", e))?;
    let read_ms = read_start.elapsed().as_millis();

    println!("[mobi-engine] 文件大小: {} bytes", raw_bytes.len());
    println!("[mobi-engine] 读取文件耗时: {}ms", read_ms);

    // mobi crate 在部分文件上存在卡死风险，这里直接跳过，统一走字节流 + EXTH 元数据解析
    let mobi_start = Instant::now();
    println!("[mobi-engine] 跳过 mobi::Mobi::from_path，使用 EXTH 元数据解析");
    let mobi_opt: Option<Mobi> = None;
    let mobi_ms = mobi_start.elapsed().as_millis();
    println!("[mobi-engine] mobi crate 初始化耗时: {}ms", mobi_ms);

    let resource_start = Instant::now();
    let image_records = resource::extract_image_records_from_bytes(&raw_bytes);
    let (resources, image_map) = resource::build_image_resources(&image_records);
    let resource_ms = resource_start.elapsed().as_millis();
    println!("[mobi-engine] 资源解析耗时: {}ms", resource_ms);

    let encoding_start = Instant::now();
    let encoding = pdb::detect_encoding(&raw_bytes);
    println!("[mobi-engine] 检测编码: {}", encoding.name());
    let encoding_ms = encoding_start.elapsed().as_millis();
    println!("[mobi-engine] 编码检测耗时: {}ms", encoding_ms);

    // 提取原始文本字节（解压后的字节流，保持 filepos 偏移一致）
    let text_start = Instant::now();
    let raw_text = match pdb::extract_raw_text_bytes(&raw_bytes) {
        Some(t) if !t.is_empty() => t,
        _ => return Err("无法提取 MOBI 文本内容：原始字节解压失败".to_string()),
    };
    let text_ms = text_start.elapsed().as_millis();

    println!("[mobi-engine] 原始文本字节长度: {} bytes", raw_text.len());
    println!("[mobi-engine] 解压文本耗时: {}ms", text_ms);

    let split_start = Instant::now();
    let (sections, toc) = section::split_into_sections(&raw_text, &raw_bytes, &image_map, encoding);
    let section_count = sections.len() as u32;
    let split_ms = split_start.elapsed().as_millis();

    let meta_start = Instant::now();
    let mut book_info = resource::extract_metadata_safe(mobi_opt.as_ref(), file_path, &raw_bytes, &image_records);
    book_info.page_count = section_count as i32;
    let meta_ms = meta_start.elapsed().as_millis();

    println!("[mobi-engine] 拆分结果: sections={}, toc={}", section_count, toc.len());
    println!(
        "[mobi-engine] 阶段耗时: read={}ms, mobi_init={}ms, resource={}ms, encoding={}ms, text={}ms, split={}ms, meta={}ms, total={}ms",
        read_ms,
        mobi_ms,
        resource_ms,
        encoding_ms,
        text_ms,
        split_ms,
        meta_ms,
        overall_start.elapsed().as_millis()
    );

    Ok(MobiPreparedBook {
        book_info,
        toc,
        section_count,
        sections,
        resources,
    })
}
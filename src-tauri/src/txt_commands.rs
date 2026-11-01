//! TXT 相关的 Tauri 命令

use crate::formats::txt::{TxtBookMeta, TxtChapterContent, TxtEngine};
use std::time::Instant;
use crate::formats::{BookFormat, BookMetadata, TocItem};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use once_cell::sync::Lazy;

/// 元数据缓存（用于章节加载时复用）
pub(crate) static METADATA_CACHE: Lazy<Mutex<HashMap<String, TxtBookMeta>>> = Lazy::new(|| {
    Mutex::new(HashMap::new())
});

/// 构造元数据缓存键（文件路径 + 章节正则组合，正则变更后自然隔离旧缓存）
///
/// # 参数
/// - `file_path`: TXT 文件路径
/// - `chapter_regex`: 自定义章节识别正则；None 表示使用内置模式
///
/// # 返回值
/// 返回组合缓存键字符串
pub(crate) fn metadata_cache_key(file_path: &str, chapter_regex: Option<&str>) -> String {
    format!("{}\u{0}{}", file_path, chapter_regex.unwrap_or(""))
}

/// 加载 TXT 文档的结果（兼容旧 API）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TxtLoadResult {
    /// TXT 全文内容
    pub content: String,
    /// 检测到的编码
    pub encoding: String,
    /// 文档标题
    pub title: Option<String>,
    /// 识别的章节目录
    pub toc: Vec<TocItem>,
    /// 文档元数据
    pub metadata: BookMetadata,
}

/// 加载 TXT 文档（兼容旧 API，返回完整内容）
#[tauri::command]
pub async fn txt_load_document(
    file_path: String,
    chapter_regex: Option<String>,
) -> Result<TxtLoadResult, String> {
    let engine = TxtEngine::from_file(&file_path).map_err(|e| e.to_string())?;

    // 使用同一正则解析目录，并基于目录推导标题，保证 title/toc/metadata 一致
    let toc = engine.get_toc_with(chapter_regex.as_deref());
    let title = toc
        .first()
        .map(|item| item.title.clone())
        .or_else(|| engine.get_title_from_filename());
    let metadata = BookMetadata {
        title: title.clone(),
        author: None,
        publisher: None,
        language: None,
        description: None,
        cover_image: None,
        page_count: 1, // 前端会进行虚拟分页
        format: Some(BookFormat::Txt),
    };

    Ok(TxtLoadResult {
        content: engine.get_content().to_string(),
        encoding: engine.get_encoding().to_string(),
        title,
        toc,
        metadata,
    })
}

/// 快速加载 TXT 元数据（只解析目录，不返回全文内容）
#[tauri::command]
pub async fn txt_load_metadata(
    file_path: String,
    chapter_regex: Option<String>,
) -> Result<TxtBookMeta, String> {
    // 组合缓存键：文件路径 + 章节正则
    let cache_key = metadata_cache_key(&file_path, chapter_regex.as_deref());

    // 检查缓存
    {
        let cache = METADATA_CACHE.lock().map_err(|e| e.to_string())?;
        if let Some(meta) = cache.get(&cache_key) {
            eprintln!("[TxtCommands] 元数据缓存命中: {}", cache_key);
            return Ok(meta.clone());
        }
    }

    // 解析元数据并记录耗时
    let start = Instant::now();
    let meta = TxtEngine::load_metadata_with(&file_path, chapter_regex.as_deref())
        .map_err(|e| e.to_string())?;
    let elapsed = start.elapsed();
    println!(
        "[TxtCommands] 元数据解析完成: file={}, chapters={}, total_chars={}, total_bytes={}, elapsed_ms={}",
        file_path,
        meta.chapters.len(),
        meta.total_chars,
        meta.total_bytes,
        elapsed.as_millis()
    );

    // 存入缓存
    {
        let mut cache = METADATA_CACHE.lock().map_err(|e| e.to_string())?;
        cache.insert(cache_key, meta.clone());
    }

    Ok(meta)
}

/// 加载指定章节内容
#[tauri::command]
pub async fn txt_load_chapter(
    file_path: String,
    chapter_index: u32,
    extra_chapters: Option<Vec<u32>>,
    chapter_regex: Option<String>,
) -> Result<Vec<TxtChapterContent>, String> {
    // 组合缓存键：文件路径 + 章节正则
    let cache_key = metadata_cache_key(&file_path, chapter_regex.as_deref());

    // 获取元数据
    let meta = {
        let cache = METADATA_CACHE.lock().map_err(|e| e.to_string())?;
        cache.get(&cache_key).cloned()
    };

    let meta = match meta {
        Some(m) => m,
        None => {
            // 如果缓存中没有，先加载元数据
            let m = TxtEngine::load_metadata_with(&file_path, chapter_regex.as_deref())
                .map_err(|e| e.to_string())?;
            let mut cache = METADATA_CACHE.lock().map_err(|e| e.to_string())?;
            cache.insert(cache_key, m.clone());
            m
        }
    };

    // 收集需要加载的章节索引
    let mut indices = vec![chapter_index];
    if let Some(extra) = extra_chapters {
        for idx in extra {
            if !indices.contains(&idx) {
                indices.push(idx);
            }
        }
    }

    // 批量加载章节
    let chapters = TxtEngine::load_chapters(&file_path, &indices, &meta).map_err(|e| e.to_string())?;
    eprintln!("[TxtCommands] 加载章节完成: {} - {} 章", file_path, chapters.len());

    Ok(chapters)
}

/// 清除指定文件的元数据缓存（删除该文件在所有章节正则下的缓存变体）
#[tauri::command]
pub async fn txt_clear_metadata_cache(file_path: String) -> Result<(), String> {
    let mut cache = METADATA_CACHE.lock().map_err(|e| e.to_string())?;
    // 兼容无正则维度的旧键
    cache.remove(&file_path);
    // 按前缀删除所有 "file_path\0regex" 组合键
    let prefix = format!("{}\u{0}", file_path);
    cache.retain(|key, _| !key.starts_with(&prefix));
    eprintln!("[TxtCommands] 元数据缓存已清除: {}", file_path);
    Ok(())
}

/// 获取元数据缓存统计
#[tauri::command]
pub async fn txt_get_cache_stats() -> Result<TxtCacheStats, String> {
    let cache = METADATA_CACHE.lock().map_err(|e| e.to_string())?;
    let total_chapters: usize = cache.values().map(|m| m.chapters.len()).sum();
    Ok(TxtCacheStats {
        cached_books: cache.len(),
        total_chapters,
    })
}

/// 缓存统计信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TxtCacheStats {
    /// 缓存的书籍数量
    pub cached_books: usize,
    /// 总章节数
    pub total_chapters: usize,
}

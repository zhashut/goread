//! TXT 相关的 Tauri 命令

use crate::formats::txt::{TxtBookMeta, TxtChapterContent, TxtEngine};
use std::time::Instant;
use crate::formats::{BookMetadata, TocItem};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use once_cell::sync::Lazy;

/// 元数据缓存（用于章节加载时复用）
static METADATA_CACHE: Lazy<Mutex<HashMap<String, TxtBookMeta>>> = Lazy::new(|| {
    Mutex::new(HashMap::new())
});

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
pub async fn txt_load_document(file_path: String) -> Result<TxtLoadResult, String> {
    let engine = TxtEngine::from_file(&file_path).map_err(|e| e.to_string())?;

    Ok(TxtLoadResult {
        content: engine.get_content().to_string(),
        encoding: engine.get_encoding().to_string(),
        title: engine.get_title(),
        toc: engine.get_toc(),
        metadata: engine.get_metadata(),
    })
}

/// 快速加载 TXT 元数据（只解析目录，不返回全文内容）
#[tauri::command]
pub async fn txt_load_metadata(file_path: String) -> Result<TxtBookMeta, String> {
    // 检查缓存
    {
        let cache = METADATA_CACHE.lock().map_err(|e| e.to_string())?;
        if let Some(meta) = cache.get(&file_path) {
            eprintln!("[TxtCommands] 元数据缓存命中: {}", file_path);
            return Ok(meta.clone());
        }
    }

    // 解析元数据并记录耗时
    let start = Instant::now();
    let meta = TxtEngine::load_metadata(&file_path).map_err(|e| e.to_string())?;
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
        cache.insert(file_path.clone(), meta.clone());
    }

    Ok(meta)
}

/// 加载指定章节内容
#[tauri::command]
pub async fn txt_load_chapter(
    file_path: String,
    chapter_index: u32,
    extra_chapters: Option<Vec<u32>>,
) -> Result<Vec<TxtChapterContent>, String> {
    // 获取元数据
    let meta = {
        let cache = METADATA_CACHE.lock().map_err(|e| e.to_string())?;
        cache.get(&file_path).cloned()
    };

    let meta = match meta {
        Some(m) => m,
        None => {
            // 如果缓存中没有，先加载元数据
            let m = TxtEngine::load_metadata(&file_path).map_err(|e| e.to_string())?;
            let mut cache = METADATA_CACHE.lock().map_err(|e| e.to_string())?;
            cache.insert(file_path.clone(), m.clone());
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

/// 清除指定文件的元数据缓存
#[tauri::command]
pub async fn txt_clear_metadata_cache(file_path: String) -> Result<(), String> {
    let mut cache = METADATA_CACHE.lock().map_err(|e| e.to_string())?;
    cache.remove(&file_path);
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

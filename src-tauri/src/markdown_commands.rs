//! Markdown 相关的 Tauri 命令

use crate::formats::markdown::{MarkdownEngine, MarkdownSearchResult};
use crate::formats::{TocItem, BookMetadata};
use serde::{Deserialize, Serialize};

/// 加载 Markdown 文档的结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarkdownLoadResult {
    /// Markdown 内容
    pub content: String,
    /// 检测到的编码
    pub encoding: String,
    /// 文档标题（来自内容或文件名）
    pub title: Option<String>,
    /// 从标题提取的目录
    pub toc: Vec<TocItem>,
    /// 文档元数据
    pub metadata: BookMetadata,
}

/// 加载 Markdown 文档
#[tauri::command]
pub async fn markdown_load_document(file_path: String) -> Result<MarkdownLoadResult, String> {
    let engine = MarkdownEngine::from_file(&file_path)
        .map_err(|e| e.to_string())?;

    Ok(MarkdownLoadResult {
        content: engine.get_content().to_string(),
        encoding: engine.get_encoding().to_string(),
        title: engine.get_title(),
        toc: engine.get_toc(),
        metadata: engine.get_metadata(),
    })
}

/// 仅获取 Markdown 文档内容
#[tauri::command]
pub async fn markdown_get_content(file_path: String) -> Result<String, String> {
    let engine = MarkdownEngine::from_file(&file_path)
        .map_err(|e| e.to_string())?;
    
    Ok(engine.get_content().to_string())
}

/// 获取 Markdown 文档目录
#[tauri::command]
pub async fn markdown_get_toc(file_path: String) -> Result<Vec<TocItem>, String> {
    let engine = MarkdownEngine::from_file(&file_path)
        .map_err(|e| e.to_string())?;
    
    Ok(engine.get_toc())
}

/// 在 Markdown 文档中搜索文本
#[tauri::command]
pub async fn markdown_search_text(
    file_path: String,
    query: String,
    case_sensitive: Option<bool>,
) -> Result<Vec<MarkdownSearchResult>, String> {
    let engine = MarkdownEngine::from_file(&file_path)
        .map_err(|e| e.to_string())?;
    
    Ok(engine.search_text(&query, case_sensitive.unwrap_or(false)))
}
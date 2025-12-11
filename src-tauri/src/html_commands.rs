//! HTML 相关的 Tauri 命令

use crate::formats::html::HtmlEngine;
use serde::{Deserialize, Serialize};

/// 加载 HTML 文档的结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HtmlLoadResult {
    /// HTML 内容
    pub content: String,
    /// 检测到的编码
    pub encoding: String,
    /// 文档标题（来自 <title> 或文件名）
    pub title: Option<String>,
}

/// 加载 HTML 文档
#[tauri::command]
pub async fn html_load_document(file_path: String) -> Result<HtmlLoadResult, String> {
    let engine = HtmlEngine::from_file(&file_path)
        .map_err(|e| e.to_string())?;

    Ok(HtmlLoadResult {
        content: engine.get_content().to_string(),
        encoding: engine.get_encoding().to_string(),
        title: engine.get_title(),
    })
}

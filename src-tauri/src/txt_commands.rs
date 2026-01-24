//! TXT 相关的 Tauri 命令

use crate::formats::txt::TxtEngine;
use crate::formats::{BookMetadata, TocItem};
use serde::{Deserialize, Serialize};

/// 加载 TXT 文档的结果
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

/// 加载 TXT 文档
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

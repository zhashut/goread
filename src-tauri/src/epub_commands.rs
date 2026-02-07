use crate::formats::epub::{
    BookInfo, EpubCacheManager, EpubInspectResult, MetadataCacheEntry, SectionCacheData, TocItem,
};
use crate::formats::epub::engine::{inspect_epub, prepare_book, EpubPreparedBook};
use serde::Serialize;
use serde_json::Value;
use std::sync::Arc;
use tauri::State;
use tokio::sync::Mutex;
use tokio::task;

/// EPUB 缓存管理器状态
pub type EpubCacheState = Arc<Mutex<EpubCacheManager>>;

#[derive(Debug, Serialize)]
pub struct EpubPrepareResult {
    pub book_info: BookInfo,
    pub toc: Vec<TocItem>,
    pub section_count: u32,
    pub spine: Vec<String>,
}

/// 保存章节缓存到磁盘（包含完整的样式和资源引用信息）
#[tauri::command]
pub async fn epub_save_section(
    book_id: String,
    section_index: u32,
    html_content: String,
    styles: Vec<String>,
    resource_refs: Vec<String>,
    state: State<'_, EpubCacheState>,
) -> Result<bool, String> {
    let manager = state.lock().await;
    match manager
        .save_section(&book_id, section_index, &html_content, styles, resource_refs)
        .await
    {
        Ok(_) => Ok(true),
        Err(e) => {
            eprintln!(
                "[EPUB缓存] 保存章节失败: book_id={}, section_index={}, error={}",
                book_id, section_index, e
            );
            Err(e)
        }
    }
}

/// 从磁盘加载章节缓存（返回完整的 HTML、样式和资源引用）
#[tauri::command]
pub async fn epub_load_section(
    book_id: String,
    section_index: u32,
    state: State<'_, EpubCacheState>,
) -> Result<Option<SectionCacheData>, String> {
    let manager = state.lock().await;
    manager.load_section(&book_id, section_index).await.map_err(|e| {
        eprintln!(
            "[EPUB缓存] 加载章节失败: book_id={}, section_index={}, error={}",
            book_id, section_index, e
        );
        e
    })
}

/// 保存资源缓存到磁盘
#[tauri::command]
pub async fn epub_save_resource(
    book_id: String,
    resource_path: String,
    data: Vec<u8>,
    mime_type: String,
    state: State<'_, EpubCacheState>,
) -> Result<bool, String> {
    let manager = state.lock().await;
    match manager
        .save_resource(&book_id, &resource_path, &data, &mime_type)
        .await
    {
        Ok(_) => Ok(true),
        Err(e) => {
            eprintln!(
                "[EPUB缓存] 保存资源失败: book_id={}, resource_path={}, error={}",
                book_id, resource_path, e
            );
            Err(e)
        }
    }
}

/// 从磁盘加载资源缓存
#[tauri::command]
pub async fn epub_load_resource(
    book_id: String,
    resource_path: String,
    state: State<'_, EpubCacheState>,
) -> Result<Option<(Vec<u8>, String)>, String> {
    let manager = state.lock().await;
    manager.load_resource(&book_id, &resource_path).await.map_err(|e| {
        eprintln!(
            "[EPUB缓存] 加载资源失败: book_id={}, resource_path={}, error={}",
            book_id, resource_path, e
        );
        e
    })
}

/// 设置 EPUB 缓存有效期（天），0 表示不限
#[tauri::command]
pub async fn epub_set_cache_expiry(
    days: u32,
    state: State<'_, EpubCacheState>,
) -> Result<bool, String> {
    let manager = state.lock().await;
    manager.set_expiry_days(days as u64);
    // 立即触发过期清理（设置有效期后按新配置清理存量缓存）
    let _ = manager.cleanup_expired().await;
    Ok(true)
}

/// 清理指定书籍的缓存，包括章节、资源和元数据
#[tauri::command]
pub async fn epub_clear_book_cache(
    book_id: String,
    state: State<'_, EpubCacheState>,
) -> Result<bool, String> {
    let manager = state.lock().await;
    manager.clear_book_cache(&book_id).await?;
    Ok(true)
}

/// 清理所有过期缓存
#[tauri::command]
pub async fn epub_cleanup_expired(state: State<'_, EpubCacheState>) -> Result<usize, String> {
    let manager = state.lock().await;
    manager.cleanup_expired().await
}

/// 获取 EPUB 缓存统计信息
#[tauri::command]
pub async fn epub_get_cache_stats(
    state: State<'_, EpubCacheState>,
) -> Result<crate::formats::epub::CacheStats, String> {
    let manager = state.lock().await;
    manager.get_stats().await
}

// ====================== 元数据缓存命令 ======================

/// 保存书籍元数据到磁盘
#[tauri::command]
pub async fn epub_save_metadata(
    book_id: String,
    book_info: Value,
    toc: Value,
    section_count: u32,
    spine: Vec<String>,
    state: State<'_, EpubCacheState>,
) -> Result<bool, String> {
    let manager = state.lock().await;

    // 解析 book_info
    let book_info: BookInfo = match &book_info {
        Value::String(s) => serde_json::from_str(s)
            .map_err(|e| format!("解析 book_info 失败: {}", e))?,
        Value::Object(_) => serde_json::from_value(book_info.clone())
            .map_err(|e| format!("解析 book_info 失败: {}", e))?,
        _ => return Err("book_info 类型不支持".to_string()),
    };

    // 解析 toc
    let toc: Vec<TocItem> = match &toc {
        Value::String(s) => serde_json::from_str(s)
            .map_err(|e| format!("解析 toc 失败: {}", e))?,
        Value::Array(_) => serde_json::from_value(toc.clone())
            .map_err(|e| format!("解析 toc 失败: {}", e))?,
        _ => return Err("toc 类型不支持".to_string()),
    };

    manager
        .save_metadata(&book_id, book_info, toc, section_count, spine)
        .await?;
    
    println!("[backend] EPUB 元数据保存成功: {}", book_id);
    Ok(true)
}

/// 从磁盘加载书籍元数据
#[tauri::command]
pub async fn epub_load_metadata(
    book_id: String,
    state: State<'_, EpubCacheState>,
) -> Result<Option<MetadataCacheEntry>, String> {
    let manager = state.lock().await;
    manager.load_metadata(&book_id).await
}

#[tauri::command]
pub async fn epub_inspect(file_path: String) -> Result<EpubInspectResult, String> {
    task::spawn_blocking(move || inspect_epub(&file_path))
        .await
        .map_err(|e| format!("EPUB 解析任务失败: {}", e))?
}

#[tauri::command]
pub async fn epub_prepare_book(
    file_path: String,
    book_id: String,
    state: State<'_, EpubCacheState>,
) -> Result<EpubPrepareResult, String> {
    let prepared: EpubPreparedBook = task::spawn_blocking(move || prepare_book(&file_path))
        .await
        .map_err(|e| format!("EPUB 解析任务失败: {}", e))??;

    let manager = state.lock().await;

    manager
        .clear_book_cache(&book_id)
        .await
        .map_err(|e| format!("清理旧缓存失败: {}", e))?;

    for section in prepared.sections {
        manager
            .save_section(
                &book_id,
                section.index,
                &section.html,
                section.styles,
                section.resource_refs,
            )
            .await
            .map_err(|e| format!("保存章节缓存失败: {}", e))?;
    }

    for res in prepared.resources {
        manager
            .save_resource(&book_id, &res.path, &res.data, &res.mime_type)
            .await
            .map_err(|e| format!("保存资源缓存失败: {}", e))?;
    }

    manager
        .save_metadata(
            &book_id,
            prepared.book_info.clone(),
            prepared.toc.clone(),
            prepared.section_count,
            prepared.spine.clone(),
        )
        .await
        .map_err(|e| format!("保存元数据失败: {}", e))?;

    Ok(EpubPrepareResult {
        book_info: prepared.book_info,
        toc: prepared.toc,
        section_count: prepared.section_count,
        spine: prepared.spine,
    })
}

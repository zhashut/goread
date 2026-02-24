//! MOBI 相关的 Tauri 命令
use crate::formats::mobi::cache::{MobiCacheManager, BookInfo, TocItem, MetadataCacheEntry, SectionCacheData};
use crate::formats::mobi::engine::{prepare_book, MobiPreparedBook};
use serde::Serialize;
use serde_json::Value;
use std::sync::Arc;
use tauri::State;
use tokio::sync::Mutex;
use tokio::task;

/// MOBI 缓存管理器状态
pub type MobiCacheState = Arc<Mutex<MobiCacheManager>>;

/// 保存章节缓存到磁盘（包含完整的样式和资源引用信息）
#[tauri::command]
pub async fn mobi_save_section(
    book_id: String,
    section_index: u32,
    html_content: String,
    styles: Vec<String>,
    resource_refs: Vec<String>,
    state: State<'_, MobiCacheState>,
) -> Result<bool, String> {
    let manager = state.lock().await;
    match manager
        .save_section(&book_id, section_index, &html_content, styles, resource_refs)
        .await
    {
        Ok(_) => Ok(true),
        Err(e) => {
            eprintln!(
                "[MOBI缓存] 保存章节失败: book_id={}, section_index={}, error={}",
                book_id, section_index, e
            );
            Err(e)
        }
    }
}

/// 从磁盘加载章节缓存（返回完整的 HTML、样式和资源引用）
#[tauri::command]
pub async fn mobi_load_section(
    book_id: String,
    section_index: u32,
    state: State<'_, MobiCacheState>,
) -> Result<Option<SectionCacheData>, String> {
    let manager = state.lock().await;
    manager.load_section(&book_id, section_index).await.map_err(|e| {
        eprintln!(
            "[MOBI缓存] 加载章节失败: book_id={}, section_index={}, error={}",
            book_id, section_index, e
        );
        e
    })
}

/// 保存资源缓存到磁盘
#[tauri::command]
pub async fn mobi_save_resource(
    book_id: String,
    resource_path: String,
    data: Vec<u8>,
    mime_type: String,
    state: State<'_, MobiCacheState>,
) -> Result<bool, String> {
    let manager = state.lock().await;
    match manager
        .save_resource(&book_id, &resource_path, &data, &mime_type)
        .await
    {
        Ok(_) => Ok(true),
        Err(e) => {
            eprintln!(
                "[MOBI缓存] 保存资源失败: book_id={}, resource_path={}, error={}",
                book_id, resource_path, e
            );
            Err(e)
        }
    }
}

/// 从磁盘加载资源缓存
#[tauri::command]
pub async fn mobi_load_resource(
    book_id: String,
    resource_path: String,
    state: State<'_, MobiCacheState>,
) -> Result<Option<(Vec<u8>, String)>, String> {
    let manager = state.lock().await;
    manager.load_resource(&book_id, &resource_path).await.map_err(|e| {
        eprintln!(
            "[MOBI缓存] 加载资源失败: book_id={}, resource_path={}, error={}",
            book_id, resource_path, e
        );
        e
    })
}

/// 设置 MOBI 缓存有效期（天），0 表示不限
#[tauri::command]
pub async fn mobi_set_cache_expiry(
    days: u32,
    state: State<'_, MobiCacheState>,
) -> Result<bool, String> {
    let manager = state.lock().await;
    manager.set_expiry_days(days as u64);
    // 立即触发过期清理
    let _ = manager.cleanup_expired().await;
    Ok(true)
}

/// 清理指定书籍的缓存，包括章节、资源和元数据
#[tauri::command]
pub async fn mobi_clear_book_cache(
    book_id: String,
    state: State<'_, MobiCacheState>,
) -> Result<bool, String> {
    let manager = state.lock().await;
    manager.clear_book_cache(&book_id).await?;
    Ok(true)
}

/// 清理所有过期缓存
#[tauri::command]
pub async fn mobi_cleanup_expired(state: State<'_, MobiCacheState>) -> Result<usize, String> {
    let manager = state.lock().await;
    manager.cleanup_expired().await
}

/// 获取 MOBI 缓存统计信息
#[tauri::command]
pub async fn mobi_get_cache_stats(
    state: State<'_, MobiCacheState>,
) -> Result<crate::formats::mobi::cache::CacheStats, String> {
    let manager = state.lock().await;
    manager.get_stats().await
}

// ====================== 元数据缓存命令 ======================

/// 保存书籍元数据到磁盘
#[tauri::command]
pub async fn mobi_save_metadata(
    book_id: String,
    book_info: Value,
    toc: Value,
    section_count: u32,
    state: State<'_, MobiCacheState>,
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
        .save_metadata(&book_id, book_info, toc, section_count)
        .await?;
    
    println!("[backend] MOBI 元数据保存成功: {}", book_id);
    Ok(true)
}

/// 从磁盘加载书籍元数据
#[tauri::command]
pub async fn mobi_load_metadata(
    book_id: String,
    state: State<'_, MobiCacheState>,
) -> Result<Option<MetadataCacheEntry>, String> {
    let manager = state.lock().await;
    manager.load_metadata(&book_id).await
}

/// 设置 MOBI 磁盘缓存最大容量（MB），由前端下发
#[tauri::command]
pub async fn mobi_set_cache_max_size(
    max_size_mb: u32,
    state: State<'_, MobiCacheState>,
) -> Result<bool, String> {
    let mut manager = state.lock().await;
    manager.set_max_size((max_size_mb as usize) * 1024 * 1024);
    Ok(true)
}
// ====================== MOBI Rust 解析引擎 ======================

#[derive(Debug, Serialize)]
pub struct MobiPrepareResult {
    pub book_info: BookInfo,
    pub toc: Vec<TocItem>,
    pub section_count: u32,
}

/// 一次性解析 MOBI 文件并将章节/资源/元数据写入磁盘缓存
#[tauri::command]
pub async fn mobi_prepare_book(
    file_path: String,
    book_id: String,
    state: State<'_, MobiCacheState>,
) -> Result<MobiPrepareResult, String> {
    let prepared: MobiPreparedBook = task::spawn_blocking(move || prepare_book(&file_path))
        .await
        .map_err(|e| format!("MOBI 解析任务失败: {}", e))??;

    let manager = state.lock().await;

    // 清理旧缓存
    manager.clear_book_cache(&book_id).await
        .map_err(|e| format!("清理旧缓存失败: {}", e))?;

    // 保存所有章节
    for section in &prepared.sections {
        manager.save_section(
            &book_id,
            section.index,
            &section.html,
            section.styles.clone(),
            section.resource_refs.clone(),
        ).await.map_err(|e| format!("保存章节缓存失败: {}", e))?;
    }

    // 保存所有资源
    for res in &prepared.resources {
        manager.save_resource(&book_id, &res.path, &res.data, &res.mime_type)
            .await.map_err(|e| format!("保存资源缓存失败: {}", e))?;
    }

    // 保存元数据
    manager.save_metadata(
        &book_id,
        prepared.book_info.clone(),
        prepared.toc.clone(),
        prepared.section_count,
    ).await.map_err(|e| format!("保存元数据失败: {}", e))?;

    println!("[backend] MOBI 解析完成: book_id={}, sections={}, resources={}",
        book_id, prepared.section_count, prepared.resources.len());

    Ok(MobiPrepareResult {
        book_info: prepared.book_info,
        toc: prepared.toc,
        section_count: prepared.section_count,
    })
}

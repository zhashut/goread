use tauri::State;
use std::sync::Arc;
use tokio::sync::Mutex;
use serde::{Deserialize, Serialize};

use crate::pdf::{PdfEngineManager};
use crate::pdf::types::*;

// 全局PDF引擎管理器
pub type PdfManagerState = Arc<Mutex<PdfEngineManager>>;

#[derive(Debug, Serialize, Deserialize)]
pub struct LoadPdfResponse {
    pub success: bool,
    pub info: Option<PdfDocumentInfo>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RenderPageResponse {
    pub success: bool,
    pub image_data: Option<Vec<u8>>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TextResponse {
    pub success: bool,
    pub text: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SearchResponse {
    pub success: bool,
    pub results: Option<Vec<SearchResult>>,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn pdf_load_document(
    file_path: String,
    manager: State<'_, PdfManagerState>,
) -> Result<LoadPdfResponse, String> {
    let manager = manager.lock().await;
    
    match manager.get_or_create_engine(&file_path).await {
        Ok(engine) => {
            let engine = engine.read().await;
            let info = engine.get_document_info().cloned();
            
            Ok(LoadPdfResponse {
                success: true,
                info,
                error: None,
            })
        }
        Err(e) => Ok(LoadPdfResponse {
            success: false,
            info: None,
            error: Some(e.to_string()),
        }),
    }
}

#[tauri::command]
pub async fn pdf_render_page(
    file_path: String,
    page_number: u32,
    quality: String,
    width: Option<u32>,
    height: Option<u32>,
    manager: State<'_, PdfManagerState>,
) -> Result<RenderPageResponse, String> {
    let manager = manager.lock().await;
    
    let engine_arc = match manager.get_engine(&file_path).await {
        Some(engine) => engine,
        None => {
            return Ok(RenderPageResponse {
                success: false,
                image_data: None,
                width: None,
                height: None,
                error: Some("PDF文档未加载".to_string()),
            });
        }
    };
    
    let engine = engine_arc.read().await;
    
    let render_quality = match quality.as_str() {
        "thumbnail" => RenderQuality::Thumbnail,
        "standard" => RenderQuality::Standard,
        "high" => RenderQuality::High,
        "best" => RenderQuality::Best,
        _ => RenderQuality::Standard,
    };
    
    let options = RenderOptions {
        quality: render_quality,
        width,
        height,
        background_color: Some([255, 255, 255, 255]),
        fit_to_width: width.is_some(),
        fit_to_height: height.is_some(),
    };
    
    match engine.render_page(page_number, options).await {
        Ok(result) => Ok(RenderPageResponse {
            success: true,
            image_data: Some(result.image_data),
            width: Some(result.width),
            height: Some(result.height),
            error: None,
        }),
        Err(e) => Ok(RenderPageResponse {
            success: false,
            image_data: None,
            width: None,
            height: None,
            error: Some(e.to_string()),
        }),
    }
}

#[tauri::command]
pub async fn pdf_render_page_base64(
    file_path: String,
    page_number: u32,
    quality: String,
    width: Option<u32>,
    height: Option<u32>,
    manager: State<'_, PdfManagerState>,
) -> Result<String, String> {
    let response = pdf_render_page(file_path, page_number, quality, width, height, manager).await?;
    
    if response.success {
        if let Some(image_data) = response.image_data {
            let base64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &image_data);
            Ok(format!("data:image/png;base64,{}", base64))
        } else {
            Err("渲染失败：无图像数据".to_string())
        }
    } else {
        Err(response.error.unwrap_or_else(|| "未知错误".to_string()))
    }
}

#[tauri::command]
pub async fn pdf_get_page_text(
    file_path: String,
    page_number: u32,
    manager: State<'_, PdfManagerState>,
) -> Result<TextResponse, String> {
    let manager = manager.lock().await;
    
    let engine_arc = match manager.get_engine(&file_path).await {
        Some(engine) => engine,
        None => {
            return Ok(TextResponse {
                success: false,
                text: None,
                error: Some("PDF文档未加载".to_string()),
            });
        }
    };
    
    let engine = engine_arc.read().await;
    
    match engine.extract_page_text(page_number) {
        Ok(page_text) => Ok(TextResponse {
            success: true,
            text: Some(page_text.full_text),
            error: None,
        }),
        Err(e) => Ok(TextResponse {
            success: false,
            text: None,
            error: Some(e.to_string()),
        }),
    }
}

#[tauri::command]
pub async fn pdf_search_text(
    file_path: String,
    query: String,
    case_sensitive: bool,
    manager: State<'_, PdfManagerState>,
) -> Result<SearchResponse, String> {
    let manager = manager.lock().await;
    
    let engine_arc = match manager.get_engine(&file_path).await {
        Some(engine) => engine,
        None => {
            return Ok(SearchResponse {
                success: false,
                results: None,
                error: Some("PDF文档未加载".to_string()),
            });
        }
    };
    
    let engine = engine_arc.read().await;
    
    match engine.search_text(&query, case_sensitive) {
        Ok(results) => Ok(SearchResponse {
            success: true,
            results: Some(results),
            error: None,
        }),
        Err(e) => Ok(SearchResponse {
            success: false,
            results: None,
            error: Some(e.to_string()),
        }),
    }
}

#[tauri::command]
pub async fn pdf_get_document_info(
    file_path: String,
    manager: State<'_, PdfManagerState>,
) -> Result<LoadPdfResponse, String> {
    let manager = manager.lock().await;
    
    let engine_arc = match manager.get_engine(&file_path).await {
        Some(engine) => engine,
        None => {
            return Ok(LoadPdfResponse {
                success: false,
                info: None,
                error: Some("PDF文档未加载".to_string()),
            });
        }
    };
    
    let engine = engine_arc.read().await;
    let info = engine.get_document_info().cloned();
    
    Ok(LoadPdfResponse {
        success: true,
        info,
        error: None,
    })
}

#[tauri::command]
pub async fn pdf_clear_cache(
    file_path: Option<String>,
    manager: State<'_, PdfManagerState>,
) -> Result<bool, String> {
    let manager = manager.lock().await;
    
    if let Some(path) = file_path {
        if let Some(engine_arc) = manager.get_engine(&path).await {
            let engine = engine_arc.read().await;
            engine.clear_cache().await;
        }
    } else {
        manager.get_cache_manager().clear().await;
    }
    
    Ok(true)
}

#[tauri::command]
pub async fn pdf_close_document(
    file_path: String,
    manager: State<'_, PdfManagerState>,
) -> Result<bool, String> {
    let manager = manager.lock().await;
    manager.remove_engine(&file_path).await;
    Ok(true)
}

#[tauri::command]
pub async fn pdf_get_cache_stats(
    manager: State<'_, PdfManagerState>,
) -> Result<serde_json::Value, String> {
    let manager = manager.lock().await;
    let stats = manager.get_cache_manager().get_stats().await;
    
    Ok(serde_json::json!({
        "item_count": stats.item_count,
        "total_size": stats.total_size,
        "max_size": stats.max_size,
        "max_items": stats.max_items,
        "hit_rate": stats.hit_rate,
    }))
}

/// 缓存预热
#[tauri::command]
pub async fn pdf_warmup_cache(
    file_path: String,
    strategy: String,
    page_count: Option<u32>,
    manager: State<'_, PdfManagerState>,
) -> Result<bool, String> {
    use crate::pdf::WarmupStrategy;
    
    let manager = manager.lock().await;
    let engine_arc = manager.get_or_create_engine(&file_path).await
        .map_err(|e| e.to_string())?;
    
    let engine = engine_arc.read().await;
    
    let warmup_strategy = match strategy.as_str() {
        "first_pages" => WarmupStrategy::FirstPages {
            count: page_count.unwrap_or(5),
            quality: RenderQuality::Standard,
        },
        "thumbnails" => WarmupStrategy::AllThumbnails,
        "smart" => WarmupStrategy::Smart {
            quality: RenderQuality::Standard,
        },
        _ => WarmupStrategy::FirstPages {
            count: 3,
            quality: RenderQuality::Standard,
        },
    };
    
    engine.warmup_cache(warmup_strategy).await
        .map_err(|e| e.to_string())?;
    
    Ok(true)
}

/// 预加载页面范围
#[tauri::command]
pub async fn pdf_preload_pages(
    file_path: String,
    start_page: u32,
    end_page: u32,
    quality: Option<String>,
    manager: State<'_, PdfManagerState>,
) -> Result<bool, String> {
    let manager = manager.lock().await;
    let engine_arc = manager.get_or_create_engine(&file_path).await
        .map_err(|e| e.to_string())?;
    
    let engine = engine_arc.read().await;
    
    let render_quality = match quality.as_deref() {
        Some("thumbnail") => RenderQuality::Thumbnail,
        Some("high") => RenderQuality::High,
        Some("best") => RenderQuality::Best,
        _ => RenderQuality::Standard,
    };
    
    engine.preload_pages(start_page, end_page, render_quality).await
        .map_err(|e| e.to_string())?;
    
    Ok(true)
}

/// 获取性能指标
#[tauri::command]
pub async fn pdf_get_performance_metrics(
    file_path: String,
    manager: State<'_, PdfManagerState>,
) -> Result<serde_json::Value, String> {
    // use crate::pdf::PerformanceMetrics;
    
    let manager = manager.lock().await;
    let _engine_arc = manager.get_engine(&file_path).await
        .ok_or("PDF未加载")?;
    
    // let engine = engine_arc.read().await;
    
    // 这里需要从renderer获取性能监控器
    // 由于架构限制，我们返回缓存统计作为性能指标的一部分
    let cache_stats = manager.get_cache_manager().get_stats().await;
    
    Ok(serde_json::json!({
        "cache_hit_rate": cache_stats.hit_rate,
        "cache_item_count": cache_stats.item_count,
        "cache_total_size": cache_stats.total_size,
        "cache_max_size": cache_stats.max_size,
    }))
}

/// 获取性能报告
#[tauri::command]
pub async fn pdf_get_performance_report(
    manager: State<'_, PdfManagerState>,
) -> Result<serde_json::Value, String> {
    let manager = manager.lock().await;
    let cache_stats = manager.get_cache_manager().get_stats().await;
    
    let mut recommendations = Vec::new();
    
    if cache_stats.hit_rate < 0.5 {
        recommendations.push("缓存命中率较低，建议增加缓存大小或优化预加载策略");
    }
    
    if cache_stats.total_size as f64 / cache_stats.max_size as f64 > 0.9 {
        recommendations.push("缓存使用率较高，可能需要清理或增加缓存限制");
    }
    
    if recommendations.is_empty() {
        recommendations.push("性能表现良好");
    }
    
    Ok(serde_json::json!({
        "cache_stats": {
            "hit_rate": cache_stats.hit_rate,
            "item_count": cache_stats.item_count,
            "total_size": cache_stats.total_size,
            "max_size": cache_stats.max_size,
        },
        "recommendations": recommendations,
        "timestamp": chrono::Utc::now().to_rfc3339(),
    }))
}

/// 并行渲染多个页面
#[tauri::command]
pub async fn pdf_render_pages_parallel(
    file_path: String,
    page_numbers: Vec<u32>,
    quality: String,
    width: Option<u32>,
    height: Option<u32>,
    manager: State<'_, PdfManagerState>,
) -> Result<Vec<RenderPageResponse>, String> {
    let manager = manager.lock().await;
    
    let engine_arc = match manager.get_engine(&file_path).await {
        Some(engine) => engine,
        None => {
            return Err("PDF文档未加载".to_string());
        }
    };
    
    let engine = engine_arc.read().await;
    
    let render_quality = match quality.as_str() {
        "thumbnail" => RenderQuality::Thumbnail,
        "standard" => RenderQuality::Standard,
        "high" => RenderQuality::High,
        "best" => RenderQuality::Best,
        _ => RenderQuality::Standard,
    };
    
    let options = RenderOptions {
        quality: render_quality,
        width,
        height,
        background_color: Some([255, 255, 255, 255]),
        fit_to_width: width.is_some(),
        fit_to_height: height.is_some(),
    };
    
    // 调用并行渲染
    let results = engine.render_pages_parallel(page_numbers, options).await;
    
    // 转换结果格式
    let responses: Vec<RenderPageResponse> = results
        .into_iter()
        .map(|result| match result {
            Ok(render_result) => RenderPageResponse {
                success: true,
                image_data: Some(render_result.image_data),
                width: Some(render_result.width),
                height: Some(render_result.height),
                error: None,
            },
            Err(e) => RenderPageResponse {
                success: false,
                image_data: None,
                width: None,
                height: None,
                error: Some(e.to_string()),
            },
        })
        .collect();
    
    Ok(responses)
}

/// 并行渲染页面范围
#[tauri::command]
pub async fn pdf_render_page_range_parallel(
    file_path: String,
    start_page: u32,
    end_page: u32,
    quality: String,
    width: Option<u32>,
    height: Option<u32>,
    manager: State<'_, PdfManagerState>,
) -> Result<Vec<RenderPageResponse>, String> {
    let page_numbers: Vec<u32> = (start_page..=end_page).collect();
    pdf_render_pages_parallel(file_path, page_numbers, quality, width, height, manager).await
}

/// 使用自定义线程数并行渲染
#[tauri::command]
pub async fn pdf_render_pages_with_threads(
    file_path: String,
    page_numbers: Vec<u32>,
    quality: String,
    num_threads: usize,
    width: Option<u32>,
    height: Option<u32>,
    manager: State<'_, PdfManagerState>,
) -> Result<Vec<RenderPageResponse>, String> {
    let manager = manager.lock().await;
    
    let engine_arc = match manager.get_engine(&file_path).await {
        Some(engine) => engine,
        None => {
            return Err("PDF文档未加载".to_string());
        }
    };
    
    let engine = engine_arc.read().await;
    
    let render_quality = match quality.as_str() {
        "thumbnail" => RenderQuality::Thumbnail,
        "standard" => RenderQuality::Standard,
        "high" => RenderQuality::High,
        "best" => RenderQuality::Best,
        _ => RenderQuality::Standard,
    };
    
    let options = RenderOptions {
        quality: render_quality,
        width,
        height,
        background_color: Some([255, 255, 255, 255]),
        fit_to_width: width.is_some(),
        fit_to_height: height.is_some(),
    };
    
    // 调用自定义线程池渲染
    let results = engine.render_pages_with_thread_pool(page_numbers, options, num_threads).await;
    
    // 转换结果格式
    let responses: Vec<RenderPageResponse> = results
        .into_iter()
        .map(|result| match result {
            Ok(render_result) => RenderPageResponse {
                success: true,
                image_data: Some(render_result.image_data),
                width: Some(render_result.width),
                height: Some(render_result.height),
                error: None,
            },
            Err(e) => RenderPageResponse {
                success: false,
                image_data: None,
                width: None,
                height: None,
                error: Some(e.to_string()),
            },
        })
        .collect();
    
    Ok(responses)
}

// 初始化PDF管理器
pub fn init_pdf_manager() -> PdfManagerState {
    // 设置缓存限制：100MB，最多50个页面
    let manager = PdfEngineManager::with_cache_limits(100 * 1024 * 1024, 50);
    Arc::new(Mutex::new(manager))
}
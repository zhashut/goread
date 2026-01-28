//! 封面存储模块
//! 负责将书籍封面以文件形式存储到磁盘

use base64::{engine::general_purpose::STANDARD, Engine};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use tokio::fs;

/// 封面文件根目录（基于应用数据目录）
pub fn cover_root(app_handle: &AppHandle) -> PathBuf {
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .expect("Failed to get app data dir");
    app_data_dir.join("covers")
}

/// 根据书籍格式获取封面子目录
fn format_subdir(file_path: &str) -> &'static str {
    let lower = file_path.to_lowercase();
    if lower.ends_with(".epub") {
        "epub"
    } else if lower.ends_with(".pdf") {
        "pdf"
    } else if lower.ends_with(".mobi") || lower.ends_with(".azw3") || lower.ends_with(".azw") {
        "mobi"
    } else if lower.ends_with(".txt") {
        "txt"
    } else if lower.ends_with(".html") || lower.ends_with(".htm") {
        "html"
    } else if lower.ends_with(".md") || lower.ends_with(".markdown") {
        "markdown"
    } else {
        "other"
    }
}

/// 计算文件路径的哈希值（用于生成稳定的封面文件名）
fn compute_path_hash(file_path: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(file_path.as_bytes());
    let result = hasher.finalize();
    // 取前16个字符
    format!("{:x}", result)[..16].to_string()
}

/// 生成封面文件的相对路径
/// 返回格式如：epub/a1b2c3d4e5f6.jpg
pub fn generate_cover_relative_path(file_path: &str) -> String {
    let subdir = format_subdir(file_path);
    let hash = compute_path_hash(file_path);
    format!("{}/{}.jpg", subdir, hash)
}

/// 生成封面文件的完整路径
pub fn generate_cover_full_path(app_handle: &AppHandle, file_path: &str) -> PathBuf {
    let relative = generate_cover_relative_path(file_path);
    cover_root(app_handle).join(relative)
}

/// 判断封面字符串是否为 Base64 格式
/// 判断规则：
/// 1. 以 data: 开头 => data URL
/// 2. 长度超过 200 且只包含 Base64 字符集 => Base64
/// 3. 否则 => 文件路径
pub fn is_base64_cover(cover_image: &str) -> bool {
    if cover_image.starts_with("data:") {
        return false; // data URL 单独处理
    }
    
    // 长度检查：太短的不可能是有效的图片 Base64
    if cover_image.len() < 200 {
        return false;
    }
    
    // 检查是否只包含 Base64 字符集
    cover_image
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/' || c == '=')
}

/// 判断封面字符串是否为 data URL 格式
pub fn is_data_url(cover_image: &str) -> bool {
    cover_image.starts_with("data:")
}

/// 判断封面字符串是否为文件路径格式
pub fn is_file_path(cover_image: &str) -> bool {
    !is_base64_cover(cover_image) && !is_data_url(cover_image)
}

/// 从 data URL 或纯 Base64 字符串中提取图片数据
fn extract_image_data(cover_data: &str) -> Result<Vec<u8>, String> {
    let base64_str = if cover_data.starts_with("data:") {
        // data URL 格式：data:image/jpeg;base64,xxxxx
        cover_data
            .split(',')
            .nth(1)
            .ok_or_else(|| "Invalid data URL format".to_string())?
    } else {
        cover_data
    };
    
    STANDARD
        .decode(base64_str)
        .map_err(|e| format!("Base64 decode error: {}", e))
}

/// 将 Base64 封面数据保存为文件
/// 返回生成的相对路径
pub async fn save_cover_from_base64(
    app_handle: &AppHandle,
    file_path: &str,
    cover_data: &str,
) -> Result<String, String> {
    // 解码 Base64 数据
    let image_bytes = extract_image_data(cover_data)?;
    
    // 生成路径
    let relative_path = generate_cover_relative_path(file_path);
    let full_path = cover_root(app_handle).join(&relative_path);
    
    // 创建目录
    if let Some(parent) = full_path.parent() {
        fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create cover directory: {}", e))?;
    }
    
    // 写入文件
    fs::write(&full_path, &image_bytes)
        .await
        .map_err(|e| format!("Failed to write cover file: {}", e))?;
    
    Ok(relative_path)
}

/// 检查封面文件是否存在
pub async fn cover_file_exists(app_handle: &AppHandle, relative_path: &str) -> bool {
    let full_path = cover_root(app_handle).join(relative_path);
    full_path.exists()
}

/// 获取封面文件的完整路径（用于前端访问）
pub fn get_cover_full_path(app_handle: &AppHandle, relative_path: &str) -> PathBuf {
    cover_root(app_handle).join(relative_path)
}

/// 删除封面文件
pub async fn delete_cover_file(app_handle: &AppHandle, relative_path: &str) -> Result<(), String> {
    let full_path = cover_root(app_handle).join(relative_path);
    if full_path.exists() {
        fs::remove_file(&full_path)
            .await
            .map_err(|e| format!("Failed to delete cover file: {}", e))?;
    }
    Ok(())
}

/// 处理封面数据：如果是 Base64 则保存为文件并返回路径，否则直接返回
pub async fn process_cover_for_storage(
    app_handle: &AppHandle,
    file_path: &str,
    cover_data: Option<&str>,
) -> Result<Option<String>, String> {
    match cover_data {
        None => Ok(None),
        Some(data) if data.is_empty() => Ok(None),
        Some(data) => {
            // 如果已经是路径格式，直接返回
            if is_file_path(data) {
                return Ok(Some(data.to_string()));
            }
            
            // Base64 或 data URL，保存为文件
            let relative_path = save_cover_from_base64(app_handle, file_path, data).await?;
            Ok(Some(relative_path))
        }
    }
}

/// 封面重建结果
#[derive(Debug, Clone)]
pub struct CoverRebuildResult {
    pub book_id: i64,
    pub success: bool,
    pub new_cover_path: Option<String>,
    pub error: Option<String>,
}

/// 判断书籍格式是否支持封面重建
pub fn can_rebuild_cover(file_path: &str) -> bool {
    let lower = file_path.to_lowercase();
    lower.ends_with(".epub") || lower.ends_with(".pdf") || lower.ends_with(".mobi") || lower.ends_with(".azw3") || lower.ends_with(".azw")
}

/// 获取书籍格式类型
pub fn get_book_format(file_path: &str) -> &'static str {
    let lower = file_path.to_lowercase();
    if lower.ends_with(".epub") {
        "epub"
    } else if lower.ends_with(".pdf") {
        "pdf"
    } else if lower.ends_with(".mobi") || lower.ends_with(".azw3") || lower.ends_with(".azw") {
        "mobi"
    } else if lower.ends_with(".txt") {
        "txt"
    } else if lower.ends_with(".html") || lower.ends_with(".htm") {
        "html"
    } else if lower.ends_with(".md") || lower.ends_with(".markdown") {
        "markdown"
    } else {
        "other"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_base64_cover() {
        // 短字符串不是 Base64
        assert!(!is_base64_cover("epub/abc.jpg"));
        assert!(!is_base64_cover(""));
        
        // data URL 不是 Base64（单独分类）
        assert!(!is_base64_cover("data:image/jpeg;base64,xxxx"));
        
        // 长的纯 Base64 字符串
        let long_base64 = "A".repeat(300);
        assert!(is_base64_cover(&long_base64));
    }

    #[test]
    fn test_generate_cover_relative_path() {
        let path = generate_cover_relative_path("/path/to/book.epub");
        assert!(path.starts_with("epub/"));
        assert!(path.ends_with(".jpg"));
        
        let path2 = generate_cover_relative_path("/path/to/book.pdf");
        assert!(path2.starts_with("pdf/"));
    }
}

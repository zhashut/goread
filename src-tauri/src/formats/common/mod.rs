//! 书籍格式公共工具

use std::path::Path;

/// 读取文件字节
pub fn read_file_bytes(path: &str) -> Result<Vec<u8>, std::io::Error> {
    std::fs::read(path)
}

/// 获取文件大小
pub fn get_file_size(path: &str) -> Result<u64, std::io::Error> {
    let metadata = std::fs::metadata(path)?;
    Ok(metadata.len())
}

/// 检查文件是否存在
pub fn file_exists(path: &str) -> bool {
    Path::new(path).exists()
}

/// 从路径提取扩展名
pub fn get_extension(path: &str) -> Option<String> {
    Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|s| s.to_lowercase())
}

/// 标准化路径分隔符
pub fn normalize_path(path: &str) -> String {
    path.replace('\\', "/")
}

/// 生成缓存键
pub fn generate_cache_key(path: &str, page: u32, quality: &str) -> String {
    use std::hash::{Hash, Hasher};
    use std::collections::hash_map::DefaultHasher;
    
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    page.hash(&mut hasher);
    quality.hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_extension() {
        assert_eq!(get_extension("/path/to/book.pdf"), Some("pdf".to_string()));
        assert_eq!(get_extension("book.EPUB"), Some("epub".to_string()));
        assert_eq!(get_extension("README"), None);
    }

    #[test]
    fn test_normalize_path() {
        assert_eq!(normalize_path("C:\\Books\\novel.pdf"), "C:/Books/novel.pdf");
        assert_eq!(normalize_path("/home/user/book.pdf"), "/home/user/book.pdf");
    }
}

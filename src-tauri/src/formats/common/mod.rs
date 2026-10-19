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

/// 缓存命中时“访问时间回写”的节流窗口（毫秒）。
///
/// 章节/资源缓存的主读路径命中后会把 last_access_time 写回 meta.json；TTS 取片会
/// 按章反复读取缓存，逐次回写就是纯额外的写 I/O（而且是热路径）。
/// LRU 与过期都以“天”为粒度，时间戳只需反映“最近是否被访问”，
/// 10 分钟精度足够，同时把回写次数压到可忽略。
pub const ACCESS_TOUCH_MIN_INTERVAL_MILLIS: u64 = 10 * 60 * 1000;

/// 本次命中是否需要把访问时间回写缓存（距上次记录已超过节流窗口）
pub fn should_touch_access(last_access_time: u64, now_millis: u64) -> bool {
    // saturating_sub：系统时钟回拨时不做回写，避免把时间戳写乱
    now_millis.saturating_sub(last_access_time) >= ACCESS_TOUCH_MIN_INTERVAL_MILLIS
}

/// 按节流窗口刷新缓存条目的 meta.json（访问时间）。
///
/// `rebuild` 由调用方给出（各自给自己类型的 meta 打新时间戳），
/// 这样章节/资源的 meta 类型不同也能共用同一套“判定 + 序列化 + 落盘”逻辑。
pub async fn refresh_meta_access_time<T, F>(
    meta_path: &Path,
    last_access_time: u64,
    now_millis: u64,
    rebuild: F,
) where
    T: serde::Serialize,
    F: FnOnce(u64) -> T,
{
    if !should_touch_access(last_access_time, now_millis) {
        return;
    }
    if let Ok(json) = serde_json::to_string(&rebuild(now_millis)) {
        // 回写失败只影响缓存淘汰顺序，不影响本次读取
        let _ = tokio::fs::write(meta_path, json).await;
    }
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

    #[test]
    fn test_should_touch_access_throttles_recent_reads() {
        let now = 10_000_000u64;
        // 刚访问过：不重写 meta（TTS 按章反复读取的典型情况）
        assert!(!should_touch_access(now - 1_000, now));
        assert!(!should_touch_access(now, now));
        // 超过窗口：回写一次
        assert!(should_touch_access(now - ACCESS_TOUCH_MIN_INTERVAL_MILLIS, now));
        assert!(should_touch_access(now - ACCESS_TOUCH_MIN_INTERVAL_MILLIS - 1, now));
        // 时钟回拨（记录的时间戳比 now 还新）：不回写
        assert!(!should_touch_access(now + 5_000, now));
    }
}

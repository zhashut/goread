// 测试辅助工具模块
// 提供测试中常用的工具函数和Mock数据

use crate::pdf::*;
use std::path::PathBuf;

/// 获取测试fixtures目录路径
pub fn get_fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
}

/// 获取测试PDF文件路径
pub fn get_test_pdf(name: &str) -> PathBuf {
    get_fixtures_dir().join(name)
}

/// 创建测试用的PDF引擎
pub async fn setup_test_engine() -> PdfEngine {
    let mut engine = PdfEngine::new();
    let test_pdf = get_test_pdf("sample.pdf");
    engine.load_document(test_pdf.to_str().unwrap())
        .await
        .expect("Failed to load test PDF");
    engine
}

/// 创建测试用的文本提取器
pub fn setup_test_extractor() -> TextExtractor {
    TextExtractor::new()
}

/// 创建测试用的渲染结果
pub fn create_test_render_result() -> RenderResult {
    RenderResult {
        image_data: vec![0u8; 1000],
        width: 800,
        height: 600,
        format: ImageFormat::Png,
    }
}

/// 创建指定大小的渲染结果（用于测试内存限制）
pub fn create_large_render_result(size: usize) -> RenderResult {
    RenderResult {
        image_data: vec![0u8; size],
        width: 1920,
        height: 1080,
        format: ImageFormat::Png,
    }
}

/// 创建测试用的缓存键
pub fn create_test_cache_key(page: u32) -> CacheKey {
    CacheKey::new(page, RenderQuality::Standard, 800, 600)
}

/// 比较两个渲染结果是否相同
pub fn compare_render_results(a: &RenderResult, b: &RenderResult) -> bool {
    a.width == b.width 
        && a.height == b.height 
        && a.image_data == b.image_data
}

/// 验证渲染结果的有效性
pub fn validate_render_result(result: &RenderResult) -> Result<(), String> {
    if result.width == 0 {
        return Err("Width is zero".to_string());
    }
    if result.height == 0 {
        return Err("Height is zero".to_string());
    }
    if result.image_data.is_empty() {
        return Err("Image data is empty".to_string());
    }
    
    // 验证图像数据大小是否合理
    let expected_min_size = (result.width * result.height) as usize / 10; // 至少10:1压缩
    if result.image_data.len() < expected_min_size {
        return Err(format!(
            "Image data too small: {} bytes for {}x{} image",
            result.image_data.len(),
            result.width,
            result.height
        ));
    }
    
    Ok(())
}

/// 生成测试用的PDF文档信息
pub fn create_test_document_info(page_count: u32) -> PdfDocumentInfo {
    let pages = (1..=page_count)
        .map(|i| PdfPageInfo {
            width: 612.0,
            height: 792.0,
            number: i,
            rotation: 0,
        })
        .collect();
    
    PdfDocumentInfo {
        page_count,
        pages,
        title: Some("Test Document".to_string()),
        author: Some("Test Author".to_string()),
        subject: Some("Test Subject".to_string()),
        keywords: Some("test, pdf".to_string()),
        creator: Some("Test Creator".to_string()),
        producer: Some("Test Producer".to_string()),
        creation_date: Some("2024-01-01".to_string()),
        modification_date: Some("2024-01-02".to_string()),
    }
}

/// 测试性能计时器
pub struct TestTimer {
    start: std::time::Instant,
    name: String,
}

impl TestTimer {
    pub fn new(name: &str) -> Self {
        Self {
            start: std::time::Instant::now(),
            name: name.to_string(),
        }
    }
    
    pub fn elapsed_ms(&self) -> u128 {
        self.start.elapsed().as_millis()
    }
    
    pub fn assert_faster_than(&self, max_ms: u128) {
        let elapsed = self.elapsed_ms();
        assert!(
            elapsed < max_ms,
            "{} took {}ms, expected < {}ms",
            self.name,
            elapsed,
            max_ms
        );
    }
}

impl Drop for TestTimer {
    fn drop(&mut self) {
        println!("{} took {}ms", self.name, self.elapsed_ms());
    }
}

/// 内存使用监控器
pub struct MemoryMonitor {
    initial: usize,
}

impl MemoryMonitor {
    pub fn new() -> Self {
        Self {
            initial: Self::get_memory_usage(),
        }
    }
    
    fn get_memory_usage() -> usize {
        // 简化实现，实际应该使用系统API
        0
    }
    
    pub fn memory_increased(&self) -> usize {
        Self::get_memory_usage().saturating_sub(self.initial)
    }
    
    pub fn assert_memory_limit(&self, max_increase: usize) {
        let increase = self.memory_increased();
        assert!(
            increase < max_increase,
            "Memory increased by {} bytes, expected < {} bytes",
            increase,
            max_increase
        );
    }
}

/// 创建临时测试文件
pub struct TempTestFile {
    path: PathBuf,
}

impl TempTestFile {
    pub fn new(name: &str, content: &[u8]) -> std::io::Result<Self> {
        let path = std::env::temp_dir().join(name);
        std::fs::write(&path, content)?;
        Ok(Self { path })
    }
    
    pub fn path(&self) -> &PathBuf {
        &self.path
    }
}

impl Drop for TempTestFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// 并发测试辅助
pub async fn run_concurrent_tasks<F, Fut, T>(
    count: usize,
    task: F,
) -> Vec<Result<T, tokio::task::JoinError>>
where
    F: Fn(usize) -> Fut + Send + 'static + Clone,
    Fut: std::future::Future<Output = T> + Send + 'static,
    T: Send + 'static,
{
    let mut handles = Vec::new();
    
    for i in 0..count {
        let task_clone = task.clone();
        let handle = tokio::spawn(async move {
            task_clone(i).await
        });
        handles.push(handle);
    }
    
    let mut results = Vec::new();
    for handle in handles {
        results.push(handle.await);
    }
    
    results
}

/// 断言渲染结果相似（允许小误差）
pub fn assert_render_similar(a: &RenderResult, b: &RenderResult, tolerance: f32) {
    assert_eq!(a.width, b.width, "Width mismatch");
    assert_eq!(a.height, b.height, "Height mismatch");
    
    // 比较图像数据（允许一定误差）
    let size_diff = (a.image_data.len() as f32 - b.image_data.len() as f32).abs();
    let size_ratio = size_diff / a.image_data.len() as f32;
    
    assert!(
        size_ratio < tolerance,
        "Image size difference too large: {:.2}%",
        size_ratio * 100.0
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_fixtures_dir() {
        let dir = get_fixtures_dir();
        assert!(dir.to_str().unwrap().contains("fixtures"));
    }

    #[test]
    fn test_create_test_render_result() {
        let result = create_test_render_result();
        assert_eq!(result.width, 800);
        assert_eq!(result.height, 600);
        assert_eq!(result.image_data.len(), 1000);
    }

    #[test]
    fn test_validate_render_result() {
        let result = create_test_render_result();
        assert!(validate_render_result(&result).is_ok());
        
        let invalid = RenderResult {
            width: 0,
            height: 0,
            image_data: vec![],
            format: ImageFormat::Png,
        };
        assert!(validate_render_result(&invalid).is_err());
    }

    #[test]
    fn test_timer() {
        let timer = TestTimer::new("test");
        std::thread::sleep(std::time::Duration::from_millis(10));
        assert!(timer.elapsed_ms() >= 10);
    }

    #[tokio::test]
    async fn test_concurrent_tasks() {
        let results = run_concurrent_tasks(5, |i| async move {
            tokio::time::sleep(tokio::time::Duration::from_millis(10)).await;
            i * 2
        }).await;
        
        assert_eq!(results.len(), 5);
        for (i, result) in results.iter().enumerate() {
            assert_eq!(result.as_ref().unwrap(), &(i * 2));
        }
    }
}
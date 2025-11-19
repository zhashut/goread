use lopdf::{Document, Object, ObjectId};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::pdf::cache::CacheManager;
use crate::pdf::renderer::PdfRenderer;
use crate::pdf::text_extractor::TextExtractor;
use crate::pdf::types::*;

pub type PdfFile = Document;

pub struct PdfEngine {
    document: Option<Arc<PdfFile>>,
    file_path: String,
    document_info: Option<PdfDocumentInfo>,
    renderer: PdfRenderer,
    text_extractor: Option<TextExtractor>,
}

impl PdfEngine {
    pub fn new() -> Self {
        Self {
            document: None,
            file_path: String::new(),
            document_info: None,
            renderer: PdfRenderer::new(),
            text_extractor: None,
        }
    }

    pub fn with_cache(cache: CacheManager) -> Self {
        Self {
            document: None,
            file_path: String::new(),
            document_info: None,
            renderer: PdfRenderer::with_cache(cache),
            text_extractor: None,
        }
    }

    pub async fn load_document(&mut self, path: &str) -> Result<PdfDocumentInfo, PdfError> {
        let document = Document::load(path).map_err(|e| PdfError::FileNotFound {
            path: path.to_string(),
            source: e.to_string(),
        })?;

        let document_info = self.extract_document_info(&document)?;

        self.text_extractor = Some(TextExtractor::new());
        self.document = Some(Arc::new(document));
        self.file_path = path.to_string();
        self.document_info = Some(document_info.clone());

        Ok(document_info)
    }

    fn extract_document_info(&self, document: &PdfFile) -> Result<PdfDocumentInfo, PdfError> {
        let pages_map = document.get_pages();
        let page_count = pages_map.len() as u32;
        let mut pages = Vec::new();

        for i in 1..=page_count {
            if let Some(page_id) = pages_map.get(&i) {
                let page_obj = document.get_object(*page_id).map_err(|e| {
                    PdfError::parse_error(Some(i), "读取页面对象失败", e.to_string())
                })?;
                let dict = page_obj.as_dict()?;

                let mut width = 612.0f32;
                let mut height = 792.0f32;
                if let Ok(media_box_obj) = dict.get(b"MediaBox") {
                    if let Ok(arr) = media_box_obj.as_array() {
                        let nums: Vec<f32> = arr
                            .iter()
                            .filter_map(|o| match o {
                                Object::Integer(v) => Some(*v as f32),
                                Object::Real(v) => Some(*v as f32),
                                _ => None,
                            })
                            .collect();
                        if nums.len() >= 4 {
                            width = (nums[2] - nums[0]).abs();
                            height = (nums[3] - nums[1]).abs();
                        }
                    }
                }

                let rotation = match dict.get(b"Rotate") {
                    Ok(Object::Integer(v)) => *v as i32,
                    _ => 0,
                };

                pages.push(PdfPageInfo {
                    width,
                    height,
                    number: i,
                    rotation,
                });
            }
        }

        let mut title = None;
        let mut author = None;
        let mut subject = None;
        let mut keywords = None;
        let mut creator = None;
        let mut producer = None;
        let mut creation_date = None;
        let mut modification_date = None;

        if let Ok(info_obj) = document.trailer.get(b"Info") {
            if let Object::Reference(id) = info_obj {
                if let Ok(Object::Dictionary(info_dict)) = document.get_object(*id) {
                    let to_str = |o: &Object| match o {
                        Object::String(bytes, _) => String::from_utf8(bytes.clone()).ok(),
                        Object::Name(name) => Some(String::from_utf8_lossy(name).to_string()),
                        _ => None,
                    };
                    title = info_dict.get(b"Title").ok().and_then(|o| to_str(o));
                    author = info_dict.get(b"Author").ok().and_then(|o| to_str(o));
                    subject = info_dict.get(b"Subject").ok().and_then(|o| to_str(o));
                    keywords = info_dict.get(b"Keywords").ok().and_then(|o| to_str(o));
                    creator = info_dict.get(b"Creator").ok().and_then(|o| to_str(o));
                    producer = info_dict.get(b"Producer").ok().and_then(|o| to_str(o));
                    creation_date = info_dict.get(b"CreationDate").ok().and_then(|o| to_str(o));
                    modification_date = info_dict.get(b"ModDate").ok().and_then(|o| to_str(o));
                }
            }
        }

        Ok(PdfDocumentInfo {
            page_count,
            pages,
            title,
            author,
            subject,
            keywords,
            creator,
            producer,
            creation_date,
            modification_date,
        })
    }

    pub async fn render_page(
        &self,
        page_number: u32,
        options: RenderOptions,
    ) -> Result<RenderResult, PdfError> {
        let document = self.document.as_ref().ok_or(PdfError::ParseError {
            page: None,
            message: "PDF文档未加载".to_string(),
            source: String::new(),
        })?;

        if page_number < 1 || page_number > self.get_page_count() {
            return Err(PdfError::PageNotFound {
                page: page_number,
                total_pages: self.get_page_count(),
            });
        }

        self.renderer
            .render_page(document, page_number, options)
            .await
    }

    pub async fn render_page_range(
        &self,
        start_page: u32,
        end_page: u32,
        options: RenderOptions,
    ) -> Result<Vec<RenderResult>, PdfError> {
        let document = self.document.as_ref().ok_or(PdfError::ParseError {
            page: None,
            message: "PDF文档未加载".to_string(),
            source: String::new(),
        })?;

        let page_count = self.get_page_count();
        let start = start_page.max(1);
        let end = end_page.min(page_count);

        let mut results = Vec::new();
        for page_num in start..=end {
            let result = self
                .renderer
                .render_page(document, page_num, options.clone())
                .await?;
            results.push(result);
        }

        Ok(results)
    }

    pub async fn render_pages_parallel(
        &self,
        page_numbers: Vec<u32>,
        options: RenderOptions,
    ) -> Vec<Result<RenderResult, PdfError>> {
        let document = match self.document.as_ref() {
            Some(doc) => doc,
            None => {
                let error = PdfError::ParseError {
                    page: None,
                    message: "PDF文档未加载".to_string(),
                    source: String::new(),
                };
                return (0..page_numbers.len())
                    .map(|_| Err(error.clone()))
                    .collect();
            }
        };

        self.renderer
            .render_pages_parallel(document, page_numbers, options)
            .await
    }

    pub async fn render_page_range_parallel(
        &self,
        start_page: u32,
        end_page: u32,
        options: RenderOptions,
    ) -> Vec<Result<RenderResult, PdfError>> {
        let document = match self.document.as_ref() {
            Some(doc) => doc,
            None => {
                return vec![Err(PdfError::ParseError {
                    page: None,
                    message: "PDF文档未加载".to_string(),
                    source: String::new(),
                })];
            }
        };

        self.renderer
            .render_page_range_parallel(document, start_page, end_page, options)
            .await
    }

    pub async fn render_pages_with_thread_pool(
        &self,
        page_numbers: Vec<u32>,
        options: RenderOptions,
        num_threads: usize,
    ) -> Vec<Result<RenderResult, PdfError>> {
        let document = match self.document.as_ref() {
            Some(doc) => doc,
            None => {
                let error = PdfError::ParseError {
                    page: None,
                    message: "PDF文档未加载".to_string(),
                    source: String::new(),
                };
                return (0..page_numbers.len())
                    .map(|_| Err(error.clone()))
                    .collect();
            }
        };

        self.renderer
            .render_pages_with_thread_pool(document, page_numbers, options, num_threads)
            .await
    }

    pub async fn preload_pages_with_strategy(
        &self,
        current_page: u32,
        strategy: PreloadStrategy,
    ) -> Result<(), PdfError> {
        let page_count = self.get_page_count();

        let start = current_page.saturating_sub(strategy.behind_count).max(1);
        let end = (current_page + strategy.ahead_count).min(page_count);

        let options = RenderOptions {
            quality: strategy.quality,
            ..Default::default()
        };

        // 直接在当前上下文中预加载，避免clone engine导致的问题
        for page_num in start..=end {
            if page_num != current_page {
                // 忽略错误，继续预加载其他页面
                let _ = self.render_page(page_num, options.clone()).await;
            }
        }

        Ok(())
    }

    pub fn extract_page_text(&self, page_number: u32) -> Result<PageText, PdfError> {
        let extractor = self.text_extractor.as_ref().ok_or(PdfError::ParseError {
            page: None,
            message: "文本提取器未初始化".to_string(),
            source: String::new(),
        })?;

        let document = self.document.as_ref().ok_or(PdfError::ParseError {
            page: None,
            message: "PDF文档未加载".to_string(),
            source: String::new(),
        })?;

        if page_number < 1 || page_number > self.get_page_count() {
            return Err(PdfError::PageNotFound {
                page: page_number,
                total_pages: self.get_page_count(),
            });
        }

        extractor.extract_page_text(document, page_number)
    }

    pub fn search_text(
        &self,
        query: &str,
        case_sensitive: bool,
    ) -> Result<Vec<SearchResult>, PdfError> {
        let extractor = self.text_extractor.as_ref().ok_or(PdfError::ParseError {
            page: None,
            message: "文本提取器未初始化".to_string(),
            source: String::new(),
        })?;

        let document = self.document.as_ref().ok_or(PdfError::ParseError {
            page: None,
            message: "PDF文档未加载".to_string(),
            source: String::new(),
        })?;

        extractor.search_text(document, query, case_sensitive)
    }

    pub fn extract_all_text(&self) -> Result<String, PdfError> {
        let extractor = self.text_extractor.as_ref().ok_or(PdfError::ParseError {
            page: None,
            message: "文本提取器未初始化".to_string(),
            source: String::new(),
        })?;

        let document = self.document.as_ref().ok_or(PdfError::ParseError {
            page: None,
            message: "PDF文档未加载".to_string(),
            source: String::new(),
        })?;

        extractor.extract_all_text(document)
    }

    pub fn get_text_at_position(
        &self,
        page_number: u32,
        x: f32,
        y: f32,
    ) -> Result<Option<String>, PdfError> {
        let extractor = self.text_extractor.as_ref().ok_or(PdfError::ParseError {
            page: None,
            message: "文本提取器未初始化".to_string(),
            source: String::new(),
        })?;

        let document = self.document.as_ref().ok_or(PdfError::ParseError {
            page: None,
            message: "PDF文档未加载".to_string(),
            source: String::new(),
        })?;

        extractor.get_text_at_position(document, page_number, x, y)
    }

    pub fn get_outline(&self) -> Result<PdfOutline, PdfError> {
        let _document = self.document.as_ref().ok_or(PdfError::ParseError {
            page: None,
            message: "PDF文档未加载".to_string(),
            source: String::new(),
        })?;

        let bookmarks = Vec::new();
        Ok(PdfOutline { bookmarks })
    }

    pub fn get_page_info(&self, page_number: u32) -> Result<PdfPageInfo, PdfError> {
        let info = self.document_info.as_ref().ok_or(PdfError::ParseError {
            page: None,
            message: "文档信息未加载".to_string(),
            source: String::new(),
        })?;

        info.pages
            .iter()
            .find(|p| p.number == page_number)
            .cloned()
            .ok_or(PdfError::PageNotFound {
                page: page_number,
                total_pages: self.get_page_count(),
            })
    }

    pub fn get_document_info(&self) -> Option<&PdfDocumentInfo> {
        self.document_info.as_ref()
    }

    pub fn get_page_count(&self) -> u32 {
        self.document_info
            .as_ref()
            .map(|info| info.page_count)
            .unwrap_or(0)
    }

    pub fn is_loaded(&self) -> bool {
        self.document.is_some()
    }

    pub fn get_file_path(&self) -> &str {
        &self.file_path
    }

    pub async fn clear_cache(&self) {
        self.renderer.clear_cache().await;
    }

    pub async fn clear_page_cache(&self, page_number: u32) {
        self.renderer.clear_page_cache(page_number).await;
    }

    pub fn close(&mut self) {
        self.document = None;
        self.document_info = None;
        self.text_extractor = None;
        self.file_path.clear();
    }

    pub async fn warmup_cache(&self, strategy: WarmupStrategy) -> Result<(), PdfError> {
        let document = self
            .document
            .as_ref()
            .ok_or_else(|| PdfError::parse_error(None, "PDF文档未加载", ""))?;

        let page_count = self.get_page_count();
        let pages_to_render = strategy.get_pages_to_render(page_count);

        for page in pages_to_render {
            let options = RenderOptions {
                quality: strategy.quality(),
                ..Default::default()
            };
            let _ = self.renderer.render_page(document, page, options).await;
        }

        Ok(())
    }

    pub async fn preload_pages(
        &self,
        start_page: u32,
        end_page: u32,
        quality: RenderQuality,
    ) -> Result<(), PdfError> {
        let document = self
            .document
            .as_ref()
            .ok_or_else(|| PdfError::parse_error(None, "PDF文档未加载", ""))?;

        let page_count = self.get_page_count();
        let start = start_page.max(1);
        let end = end_page.min(page_count);

        for page in start..=end {
            let options = RenderOptions {
                quality: quality.clone(),
                ..Default::default()
            };
            let _ = self.renderer.render_page(document, page, options).await;
        }

        Ok(())
    }

    pub async fn render_page_progressive<F>(
        &self,
        page_number: u32,
        options: RenderOptions,
        callback: F,
    ) -> Result<(), PdfError>
    where
        F: FnMut(RenderQuality, RenderResult) + Send,
    {
        let document = self
            .document
            .as_ref()
            .ok_or_else(|| PdfError::parse_error(None, "PDF文档未加载", ""))?;

        let page_count = self.get_page_count();
        if page_number < 1 || page_number > page_count {
            return Err(PdfError::page_not_found(page_number, page_count));
        }

        self.renderer
            .render_page_progressive(document, page_number, options, callback)
            .await
    }

    pub async fn render_pages_batch(
        &self,
        page_numbers: Vec<u32>,
        options: RenderOptions,
    ) -> Vec<Result<RenderResult, PdfError>> {
        let document = match self.document.as_ref() {
            Some(doc) => doc,
            None => {
                let err = PdfError::parse_error(None, "PDF文档未加载", "");
                return vec![Err(err); page_numbers.len()];
            }
        };

        self.renderer
            .render_pages_batch(document, page_numbers, options)
            .await
    }
}

#[derive(Debug, Clone)]
pub enum WarmupStrategy {
    FirstPages {
        count: u32,
        quality: RenderQuality,
    },
    SpecificPages {
        pages: Vec<u32>,
        quality: RenderQuality,
    },
    AllThumbnails,
    Smart {
        quality: RenderQuality,
    },
}

impl WarmupStrategy {
    fn get_pages_to_render(&self, total_pages: u32) -> Vec<u32> {
        match self {
            WarmupStrategy::FirstPages { count, .. } => (1..=(*count).min(total_pages)).collect(),
            WarmupStrategy::SpecificPages { pages, .. } => pages
                .iter()
                .filter(|&&p| p >= 1 && p <= total_pages)
                .copied()
                .collect(),
            WarmupStrategy::AllThumbnails => (1..=total_pages).collect(),
            WarmupStrategy::Smart { .. } => {
                let mut pages = vec![1];
                for i in 2..=5.min(total_pages) {
                    pages.push(i);
                }
                if total_pages > 10 {
                    pages.push(total_pages / 2);
                }
                pages
            }
        }
    }

    fn quality(&self) -> RenderQuality {
        match self {
            WarmupStrategy::FirstPages { quality, .. } => quality.clone(),
            WarmupStrategy::SpecificPages { quality, .. } => quality.clone(),
            WarmupStrategy::AllThumbnails => RenderQuality::Thumbnail,
            WarmupStrategy::Smart { quality } => quality.clone(),
        }
    }
}

impl Clone for PdfEngine {
    fn clone(&self) -> Self {
        Self {
            document: self.document.clone(),
            file_path: self.file_path.clone(),
            document_info: self.document_info.clone(),
            renderer: self.renderer.clone(),
            // TextExtractor是无状态的，可以创建新实例
            text_extractor: self.text_extractor.as_ref().map(|_| TextExtractor::new()),
        }
    }
}

pub struct PdfEngineManager {
    engines: Arc<RwLock<HashMap<String, Arc<RwLock<PdfEngine>>>>>,
    cache_manager: CacheManager,
}

impl PdfEngineManager {
    pub fn new() -> Self {
        Self {
            engines: Arc::new(RwLock::new(HashMap::new())),
            cache_manager: CacheManager::new(),
        }
    }

    pub fn with_cache_limits(max_size: usize, max_items: usize) -> Self {
        Self {
            engines: Arc::new(RwLock::new(HashMap::new())),
            cache_manager: CacheManager::with_limits(max_size, max_items),
        }
    }

    pub async fn get_or_create_engine(
        &self,
        file_path: &str,
    ) -> Result<Arc<RwLock<PdfEngine>>, PdfError> {
        let engines = self.engines.read().await;

        if let Some(engine) = engines.get(file_path) {
            return Ok(Arc::clone(engine));
        }

        drop(engines);

        let mut engine = PdfEngine::with_cache(self.cache_manager.clone());
        engine.load_document(file_path).await?;

        let engine_arc = Arc::new(RwLock::new(engine));

        let mut engines = self.engines.write().await;
        engines.insert(file_path.to_string(), Arc::clone(&engine_arc));

        Ok(engine_arc)
    }

    pub async fn get_engine(&self, file_path: &str) -> Option<Arc<RwLock<PdfEngine>>> {
        let engines = self.engines.read().await;
        engines.get(file_path).map(Arc::clone)
    }

    pub async fn remove_engine(&self, file_path: &str) -> Option<Arc<RwLock<PdfEngine>>> {
        let mut engines = self.engines.write().await;
        engines.remove(file_path)
    }

    pub async fn clear_all(&self) {
        let mut engines = self.engines.write().await;
        engines.clear();
        self.cache_manager.clear().await;
    }

    pub async fn get_loaded_files(&self) -> Vec<String> {
        let engines = self.engines.read().await;
        engines.keys().cloned().collect()
    }

    pub fn get_cache_manager(&self) -> &CacheManager {
        &self.cache_manager
    }
}

impl Clone for PdfEngineManager {
    fn clone(&self) -> Self {
        Self {
            engines: Arc::clone(&self.engines),
            cache_manager: self.cache_manager.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_engine_manager() {
        let _manager = PdfEngineManager::new();
    }
}

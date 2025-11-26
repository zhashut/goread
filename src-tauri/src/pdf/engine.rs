use pdfium_render::prelude::*;
use std::sync::Arc;
use tokio::sync::RwLock;
use std::collections::HashMap;

use crate::pdf::cache::CacheManager;
use crate::pdf::renderer::PdfRenderer;
use crate::pdf::types::*;

/// PDF 引擎，负责文档加载和管理
pub struct PdfEngine {
    file_path: String,
    document_info: Option<PdfDocumentInfo>,
    cache: CacheManager,
}

impl PdfEngine {
    /// 创建新的 PDF 引擎实例
    pub fn new() -> Result<Self, PdfError> {
        Ok(Self {
            file_path: String::new(),
            document_info: None,
            cache: CacheManager::with_limits(50 * 1024 * 1024, 20),
        })
    }

    /// 使用指定的缓存管理器创建引擎
    pub fn with_cache(cache: CacheManager) -> Result<Self, PdfError> {
        Ok(Self {
            file_path: String::new(),
            document_info: None,
            cache,
        })
    }

    /// 创建 Pdfium 实例（内部使用）
    fn create_pdfium() -> Result<Pdfium, PdfError> {
        let mut candidates: Vec<String> = Vec::new();
        if let Ok(dir) = std::env::var("PDFIUM_LIB_DIR") { candidates.push(dir); }
        if let Ok(exe) = std::env::current_exe() { if let Some(p) = exe.parent() { candidates.push(p.to_string_lossy().to_string()); } }
        if let Ok(cwd) = std::env::current_dir() { candidates.push(cwd.to_string_lossy().to_string()); }
        candidates.push("./resources".to_string());
        candidates.push("./pdfium".to_string());
        #[cfg(target_os = "windows")] {
            candidates.push("./pdfium/windows".to_string());
            candidates.push("./src/pdfium/windows".to_string());
        }
        #[cfg(target_os = "linux")] {
            candidates.push("./pdfium/linux".to_string());
            candidates.push("./src/pdfium/linux".to_string());
        }
        #[cfg(target_os = "macos")] {
            candidates.push("./pdfium/macos".to_string());
            candidates.push("./src/pdfium/macos".to_string());
        }
        #[cfg(target_os = "android")] {
            candidates.push("./pdfium/android".to_string());
            candidates.push("./src/pdfium/android".to_string());
        }
        #[cfg(target_os = "ios")] {
            candidates.push("./pdfium/ios".to_string());
            candidates.push("./src/pdfium/ios".to_string());
        }

        for dir in candidates {
            if let Ok(bindings) = Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path(&dir)) {
                return Ok(Pdfium::new(bindings));
            }
        }

        Ok(Pdfium::new(
            Pdfium::bind_to_system_library().map_err(|e| PdfError::ParseError {
                page: None,
                message: "无法加载 Pdfium 库".to_string(),
                source: e.to_string(),
            })?,
        ))
    }

    /// 执行需要文档的操作（内部使用）
    fn with_document<F, R>(&self, f: F) -> Result<R, PdfError>
    where
        F: FnOnce(&Pdfium, &PdfDocument<'_>) -> Result<R, PdfError>,
    {
        let pdfium = Self::create_pdfium()?;
        let document = pdfium
            .load_pdf_from_file(&self.file_path, None)
            .map_err(|e| PdfError::FileNotFound {
                path: self.file_path.clone(),
                source: e.to_string(),
            })?;
        f(&pdfium, &document)
    }

    /// 加载 PDF 文档
    pub async fn load_document(&mut self, path: &str) -> Result<PdfDocumentInfo, PdfError> {
        // 如果切换到不同的文档，清理旧文档的缓存
        if !self.file_path.is_empty() && self.file_path != path {
            self.cache.clear().await;
        }
        
        let pdfium = Self::create_pdfium()?;
        let document = pdfium
            .load_pdf_from_file(path, None)
            .map_err(|e| PdfError::FileNotFound {
                path: path.to_string(),
                source: e.to_string(),
            })?;

        let document_info = self.extract_document_info(&document)?;

        self.file_path = path.to_string();
        self.document_info = Some(document_info.clone());

        Ok(document_info)
    }

    /// 提取文档信息
    fn extract_document_info(&self, document: &PdfDocument<'_>) -> Result<PdfDocumentInfo, PdfError> {
        let pages = document.pages();
        let page_count = pages.len() as u32;
        
        let mut page_infos = Vec::new();
        for i in 0..page_count {
            let page = pages.get(i as u16).map_err(|e| {
                PdfError::parse_error(Some(i + 1), "读取页面失败", e.to_string())
            })?;

            let width = page.width().value;
            let height = page.height().value;
            let rotation = match page.rotation() {
                Ok(PdfPageRenderRotation::None) => 0,
                Ok(PdfPageRenderRotation::Degrees90) => 90,
                Ok(PdfPageRenderRotation::Degrees180) => 180,
                Ok(PdfPageRenderRotation::Degrees270) => 270,
                Err(_) => 0, // 默认无旋转
            };

            page_infos.push(PdfPageInfo {
                width,
                height,
                number: i + 1,
                rotation,
            });
        }

        // 提取元数据
        // 暂时设置为 None，避免 pdfium-render 不同版本的 trait bound 问题
        let title = None;
        let author = None;
        let subject = None;
        let keywords = None;
        let creator = None;
        let producer = None;
        let creation_date = None;
        let modification_date = None;

        Ok(PdfDocumentInfo {
            page_count,
            pages: page_infos,
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

    /// 渲染单个页面
    pub async fn render_page(
        &self,
        page_number: u32,
        options: RenderOptions,
    ) -> Result<RenderResult, PdfError> {
        if page_number < 1 || page_number > self.get_page_count() {
            return Err(PdfError::PageNotFound {
                page: page_number,
                total_pages: self.get_page_count(),
            });
        }

        // 提前检查缓存（在加载文档之前）
        if let Some(page_info) = self.document_info.as_ref().and_then(|info| info.pages.get((page_number - 1) as usize)) {
            let base_width = page_info.width;
            let base_height = page_info.height;
            
            // 计算目标尺寸（与 renderer 中的逻辑一致）
            let (target_width, target_height) = if let Some(w) = options.width {
                let aspect_ratio = base_height / base_width;
                (w, (w as f32 * aspect_ratio) as u32)
            } else if let Some(h) = options.height {
                let aspect_ratio = base_width / base_height;
                ((h as f32 * aspect_ratio) as u32, h)
            } else {
                (base_width as u32, base_height as u32)
            };
            
            let cache_key = CacheKey::new(
                self.file_path.clone(),
                page_number,
                options.quality.clone(),
                target_width,
                target_height,
            );
            
            // 检查缓存
            if let Some(cached) = self.cache.get(&cache_key).await {
                println!("[backend] 页面 {} 从缓存加载（跳过文档加载）", page_number);
                return Ok(cached);
            }
        }

        let file_path = self.file_path.clone();
        let cache = self.cache.clone();
        
        tokio::task::spawn_blocking(move || {
            let start = std::time::Instant::now();
            
            let pdfium = Arc::new(Self::create_pdfium()?);
            let document = pdfium
                .load_pdf_from_file(&file_path, None)
                .map_err(|e| PdfError::FileNotFound {
                    path: file_path.clone(),
                    source: e.to_string(),
                })?;
            
            let load_time = start.elapsed();
            println!("[backend] 页面 {} 文档加载耗时: {}ms", page_number, load_time.as_millis());
            
            let render_start = std::time::Instant::now();
            let renderer = PdfRenderer::with_cache(file_path.clone(), pdfium.clone(), cache);
            let result = renderer.render_page_sync(&document, page_number, options)?;
            
            let render_time = render_start.elapsed();
            let total_time = start.elapsed();
            println!("[backend] 页面 {} 渲染耗时: {}ms, 总耗时: {}ms", 
                page_number, render_time.as_millis(), total_time.as_millis());
            
            Ok(result)
        })
        .await
        .map_err(|e| PdfError::render_error(page_number, "render_page", format!("渲染任务失败: {}", e)))?
    }

    pub async fn render_page_to_file(
        &self,
        page_number: u32,
        options: RenderOptions,
    ) -> Result<String, PdfError> {
        if page_number < 1 || page_number > self.get_page_count() {
            return Err(PdfError::PageNotFound { page: page_number, total_pages: self.get_page_count() });
        }

        let (target_width, target_height) = if let Some(info) = self.document_info.as_ref().and_then(|i| i.pages.get((page_number - 1) as usize)) {
            let base_width = info.width;
            let base_height = info.height;
            if let Some(w) = options.width {
                let aspect = base_height / base_width;
                (w, (w as f32 * aspect) as u32)
            } else if let Some(h) = options.height {
                let aspect = base_width / base_height;
                ((h as f32 * aspect) as u32, h)
            } else {
                let scale = options.quality.scale_factor();
                ((base_width * scale) as u32, (base_height * scale) as u32)
            }
        } else {
            (options.width.unwrap_or(800), options.height.unwrap_or(1000))
        };

        let quality_str = match options.quality { RenderQuality::Thumbnail => "thumb", RenderQuality::Standard => "std", RenderQuality::High => "high", RenderQuality::Best => "best" };
        let cache_key = CacheKey::new(self.file_path.clone(), page_number, options.quality.clone(), target_width, target_height);

        // 命中缓存：用缓存的格式命名文件
        if let Some(cached) = self.cache.get(&cache_key).await {
            let ext = cached.format.extension();
            let quality_str = match options.quality { RenderQuality::Thumbnail => "thumb", RenderQuality::Standard => "std", RenderQuality::High => "high", RenderQuality::Best => "best" };
            let temp_dir = std::env::temp_dir();
            let path = temp_dir.join(format!("goread_{}_{}_{}x{}.{}", page_number, quality_str, target_width, target_height, ext));
            if std::path::Path::new(&path).exists() {
                return Ok(path.to_string_lossy().to_string());
            }
            std::fs::write(&path, &cached.image_data).map_err(|e| PdfError::io_error(Some(path.to_string_lossy().to_string()), e))?;
            return Ok(path.to_string_lossy().to_string());
        }

        // 未命中缓存：先渲染，再按输出格式命名文件
        let result = self.render_page(page_number, options).await?;
        let ext = result.format.extension();
        let temp_dir = std::env::temp_dir();
        let path = temp_dir.join(format!("goread_{}_{}_{}x{}.{}", page_number, quality_str, target_width, target_height, ext));
        std::fs::write(&path, &result.image_data).map_err(|e| PdfError::io_error(Some(path.to_string_lossy().to_string()), e))?;
        Ok(path.to_string_lossy().to_string())
    }

    /// 渲染页面分块
    pub async fn render_page_tile(
        &self,
        page_number: u32,
        region: RenderRegion,
        options: RenderOptions,
    ) -> Result<RenderResult, PdfError> {
        if page_number < 1 || page_number > self.get_page_count() {
            return Err(PdfError::PageNotFound { page: page_number, total_pages: self.get_page_count() });
        }

        let file_path = self.file_path.clone();
        let cache = self.cache.clone();

        tokio::task::spawn_blocking(move || {
            let pdfium = Arc::new(Self::create_pdfium()?);
            let document = pdfium
                .load_pdf_from_file(&file_path, None)
                .map_err(|e| PdfError::FileNotFound { path: file_path.clone(), source: e.to_string() })?;

            let renderer = PdfRenderer::with_cache(file_path.clone(), pdfium.clone(), cache);
            renderer.render_page_tile_sync(&document, page_number, region, options)
        })
        .await
        .map_err(|e| PdfError::render_error(page_number, "render_page_tile", format!("渲染任务失败: {}", e)))?
    }

    /// 渲染页面范围
    pub async fn render_page_range(
        &self,
        start_page: u32,
        end_page: u32,
        options: RenderOptions,
    ) -> Result<Vec<RenderResult>, PdfError> {
        let page_count = self.get_page_count();
        let start = start_page.max(1);
        let end = end_page.min(page_count);

        let file_path = self.file_path.clone();
        let cache = self.cache.clone();
        
        tokio::task::spawn_blocking(move || {
            let pdfium = Arc::new(Self::create_pdfium()?);
            let document = pdfium
                .load_pdf_from_file(&file_path, None)
                .map_err(|e| PdfError::FileNotFound {
                    path: file_path.clone(),
                    source: e.to_string(),
                })?;
            
            let renderer = PdfRenderer::with_cache(file_path.clone(), pdfium.clone(), cache);
            let mut results = Vec::new();
            for page_num in start..=end {
                let result = renderer.render_page_sync(&document, page_num, options.clone())?;
                results.push(result);
            }
            Ok(results)
        })
        .await
        .map_err(|e| PdfError::render_error(0, "render_page_range", format!("渲染任务失败: {}", e)))?
    }

    /// 并行渲染多个页面
    pub async fn render_pages_parallel(
        &self,
        page_numbers: Vec<u32>,
        options: RenderOptions,
    ) -> Vec<Result<RenderResult, PdfError>> {
        let file_path = self.file_path.clone();
        let cache = self.cache.clone();
        
        let handles: Vec<_> = page_numbers
            .into_iter()
            .map(|page_num| {
                let file_path = file_path.clone();
                let cache = cache.clone();
                let options = options.clone();
                
                tokio::task::spawn_blocking(move || {
                    let pdfium = Arc::new(Self::create_pdfium()?);
                    let document = pdfium
                        .load_pdf_from_file(&file_path, None)
                        .map_err(|e| PdfError::FileNotFound {
                            path: file_path.clone(),
                            source: e.to_string(),
                        })?;
                    
                    let renderer = PdfRenderer::with_cache(file_path.clone(), pdfium.clone(), cache);
                    renderer.render_page_sync(&document, page_num, options)
                })
            })
            .collect();

        let mut results = Vec::new();
        for handle in handles {
            let result = handle
                .await
                .map_err(|e| PdfError::render_error(0, "render_pages_parallel", format!("渲染任务失败: {}", e)))
                .and_then(|r| r);
            results.push(result);
        }

        results
    }

    /// 提取页面文本
    pub fn extract_page_text(&self, page_number: u32) -> Result<PageText, PdfError> {
        if page_number < 1 || page_number > self.get_page_count() {
            return Err(PdfError::PageNotFound {
                page: page_number,
                total_pages: self.get_page_count(),
            });
        }

        self.with_document(|_pdfium, document| {
            let page = document.pages().get((page_number - 1) as u16).map_err(|e| {
                PdfError::parse_error(Some(page_number), "获取页面失败", e.to_string())
            })?;

            let text = page.text().map_err(|e| {
                PdfError::parse_error(Some(page_number), "提取文本失败", e.to_string())
            })?;

            let full_text = text.all();
            
            let mut blocks = Vec::new();
            for segment in text.segments().iter() {
                let segment_text = segment.text();
                // 只添加非空文本
                if !segment_text.trim().is_empty() {
                    let bounds = segment.bounds();
                    blocks.push(TextBlock {
                        text: segment_text,
                        position: TextPosition {
                            x: bounds.left.value,
                            y: bounds.top.value,
                            width: bounds.width().value,
                            height: bounds.height().value,
                        },
                        font_size: 12.0, // 暂定默认值，Pdfium 复杂 API 可获取准确值
                        font_name: None,
                    });
                }
            }

            Ok(PageText {
                page_number,
                blocks,
                full_text,
            })
        })
    }

    /// 搜索文本
    pub fn search_text(
        &self,
        query: &str,
        case_sensitive: bool,
    ) -> Result<Vec<SearchResult>, PdfError> {
        self.with_document(|_pdfium, document| {
            let mut results = Vec::new();
            let pages = document.pages();
            
            for page_index in 0..pages.len() {
                let page = pages.get(page_index as u16).map_err(|e| {
                    PdfError::parse_error(Some(page_index as u32 + 1), "获取页面失败", e.to_string())
                })?;

                let text = page.text().map_err(|e| {
                    PdfError::parse_error(Some(page_index as u32 + 1), "提取文本失败", e.to_string())
                })?;

                let page_text = text.all();
                let search_text = if case_sensitive {
                    page_text.clone()
                } else {
                    page_text.to_lowercase()
                };
                let search_query = if case_sensitive {
                    query.to_string()
                } else {
                    query.to_lowercase()
                };

                let mut start = 0;
                while let Some(pos) = search_text[start..].find(&search_query) {
                    let actual_pos = start + pos;
                    let context_start = actual_pos.saturating_sub(30);
                    let context_end = (actual_pos + query.len() + 30).min(page_text.len());
                    let context = page_text[context_start..context_end].to_string();

                    results.push(SearchResult {
                        page_number: page_index as u32 + 1,
                        text: page_text[actual_pos..actual_pos + query.len()].to_string(),
                        position: TextPosition {
                            x: 0.0,
                            y: 0.0,
                            width: 0.0,
                            height: 0.0,
                        },
                        context,
                    });

                    start = actual_pos + 1;
                }
            }

            Ok(results)
        })
    }

    /// 提取所有文本
    pub fn extract_all_text(&self) -> Result<String, PdfError> {
        self.with_document(|_pdfium, document| {
            let mut all_text = String::new();
            let pages = document.pages();
            
            for page_index in 0..pages.len() {
                let page = pages.get(page_index as u16).map_err(|e| {
                    PdfError::parse_error(Some(page_index as u32 + 1), "获取页面失败", e.to_string())
                })?;

                let text = page.text().map_err(|e| {
                    PdfError::parse_error(Some(page_index as u32 + 1), "提取文本失败", e.to_string())
                })?;

                all_text.push_str(&text.all());
                all_text.push('\n');
            }

            Ok(all_text)
        })
    }

    /// 获取文档大纲（书签）
    pub fn get_outline(&self) -> Result<PdfOutline, PdfError> {
        self.with_document(|_pdfium, document| {
            let bookmarks = self.extract_bookmarks(&document)?;
            Ok(PdfOutline { bookmarks })
        })
    }

    /// 提取书签
    /// 直接通过 `PdfBookmark::children()` 递归构建树，避免依赖 `children_len()` 在部分文档上返回不准确导致层级被扁平化
    fn extract_bookmarks(&self, document: &PdfDocument<'_>) -> Result<Vec<Bookmark>, PdfError> {
        let mut roots = Vec::new();
        let bookmarks = document.bookmarks();
        if let Some(root) = bookmarks.root() {
            fn add_node<'a>(engine: &PdfEngine, roots: &mut Vec<Bookmark>, bm: &PdfBookmark<'a>) -> Result<(), PdfError> {
                let node = engine.build_bookmark_tree(bm, 0)?;
                let duplicated = roots
                    .iter()
                    .any(|b: &Bookmark| b.title == node.title && b.page_number == node.page_number);
                if !duplicated {
                    roots.push(node);
                }
                Ok(())
            }

            add_node(self, &mut roots, &root)?;

            for top in root.iter_siblings() {
                add_node(self, &mut roots, &top)?;
            }

            if roots.is_empty() {
                for child in root.iter_direct_children() {
                    add_node(self, &mut roots, &child)?;
                }
            }
        }
        Ok(roots)
    }

    /// 递归构建书签树
    fn build_bookmark_tree<'a>(&self, pdf_bookmark: &PdfBookmark<'a>, level: u32) -> Result<Bookmark, PdfError> {
        let title = pdf_bookmark.title().unwrap_or_default();
        let page_number = if let Some(dest) = pdf_bookmark.destination() {
            dest.page_index().unwrap_or(0) as u32 + 1
        } else {
            0
        };

        let mut children = Vec::new();
        for child in pdf_bookmark.iter_direct_children() {
            children.push(self.build_bookmark_tree(&child, level + 1)?);
        }

        Ok(Bookmark { title, page_number, level, children })
    }

    /// 获取页面信息
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

    /// 获取文档信息
    pub fn get_document_info(&self) -> Option<&PdfDocumentInfo> {
        self.document_info.as_ref()
    }

    /// 获取页面总数
    pub fn get_page_count(&self) -> u32 {
        self.document_info
            .as_ref()
            .map(|info| info.page_count)
            .unwrap_or(0)
    }

    /// 检查文档是否已加载
    pub fn is_loaded(&self) -> bool {
        !self.file_path.is_empty() && self.document_info.is_some()
    }

    /// 获取文件路径
    pub fn get_file_path(&self) -> &str {
        &self.file_path
    }

    /// 清除缓存
    pub async fn clear_cache(&self) {
        self.cache.clear().await;
    }

    /// 清除指定页面的缓存
    pub async fn clear_page_cache(&self, page_number: u32) {
        self.cache.clear_page(&self.file_path, page_number).await;
    }

    /// 关闭文档
    pub fn close(&mut self) {
        self.document_info = None;
        self.file_path.clear();
    }

    /// 预热缓存
    pub async fn warmup_cache(&self, strategy: WarmupStrategy) -> Result<(), PdfError> {
        let file_path = self.file_path.clone();
        let cache = self.cache.clone();
        let page_count = self.get_page_count();
        let pages_to_render = strategy.get_pages_to_render(page_count);
        let quality = strategy.quality();

        tokio::task::spawn_blocking(move || {
            let pdfium = Arc::new(Self::create_pdfium()?);
            let document = pdfium
                .load_pdf_from_file(&file_path, None)
                .map_err(|e| PdfError::FileNotFound {
                    path: file_path.clone(),
                    source: e.to_string(),
                })?;
            
            let renderer = PdfRenderer::with_cache(file_path.clone(), pdfium.clone(), cache);
            for page in pages_to_render {
                let options = RenderOptions {
                    quality: quality.clone(),
                    ..Default::default()
                };
                let _ = renderer.render_page_sync(&document, page, options);
            }
            Ok(())
        })
        .await
        .map_err(|e| PdfError::render_error(0, "warmup_cache", format!("预热任务失败: {}", e)))?
    }

    /// 预加载页面
    pub async fn preload_pages(
        &self,
        start_page: u32,
        end_page: u32,
        quality: RenderQuality,
    ) -> Result<(), PdfError> {
        let file_path = self.file_path.clone();
        let cache = self.cache.clone();
        let page_count = self.get_page_count();
        let start = start_page.max(1);
        let end = end_page.min(page_count);

        tokio::task::spawn_blocking(move || {
            let pdfium = Arc::new(Self::create_pdfium()?);
            let document = pdfium
                .load_pdf_from_file(&file_path, None)
                .map_err(|e| PdfError::FileNotFound {
                    path: file_path.clone(),
                    source: e.to_string(),
                })?;
            
            let renderer = PdfRenderer::with_cache(file_path.clone(), pdfium.clone(), cache);
            for page in start..=end {
                let options = RenderOptions {
                    quality: quality.clone(),
                    ..Default::default()
                };
                let _ = renderer.render_page_sync(&document, page, options);
            }
            Ok(())
        })
        .await
        .map_err(|e| PdfError::render_error(0, "preload_pages", format!("预加载任务失败: {}", e)))?
    }

    /// 渐进式渲染页面
    pub async fn render_page_progressive<F>(
        &self,
        page_number: u32,
        options: RenderOptions,
        mut callback: F,
    ) -> Result<(), PdfError>
    where
        F: FnMut(RenderQuality, RenderResult) + Send + 'static,
    {
        let page_count = self.get_page_count();
        if page_number < 1 || page_number > page_count {
            return Err(PdfError::page_not_found(page_number, page_count));
        }

        let file_path = self.file_path.clone();
        let cache = self.cache.clone();
        
        tokio::task::spawn_blocking(move || {
            let pdfium = Arc::new(Self::create_pdfium()?);
            let document = pdfium
                .load_pdf_from_file(&file_path, None)
                .map_err(|e| PdfError::FileNotFound {
                    path: file_path.clone(),
                    source: e.to_string(),
                })?;
            
            let renderer = PdfRenderer::with_cache(file_path.clone(), pdfium.clone(), cache);
            
            // 渐进式渲染：先低质量，再高质量
            let qualities = vec![RenderQuality::Thumbnail, RenderQuality::Standard, RenderQuality::High];
            for quality in qualities {
                let mut opts = options.clone();
                opts.quality = quality.clone();
                let result = renderer.render_page_sync(&document, page_number, opts)?;
                callback(quality, result);
            }
            
            Ok(())
        })
        .await
        .map_err(|e| PdfError::render_error(page_number, "render_page_progressive", format!("渐进式渲染任务失败: {}", e)))?
    }

    /// 批量渲染页面
    pub async fn render_pages_batch(
        &self,
        page_numbers: Vec<u32>,
        options: RenderOptions,
    ) -> Vec<Result<RenderResult, PdfError>> {
        let file_path = self.file_path.clone();
        let cache = self.cache.clone();
        
        match tokio::task::spawn_blocking(move || {
            let pdfium = Arc::new(Self::create_pdfium()?);
            let document = pdfium
                .load_pdf_from_file(&file_path, None)
                .map_err(|e| PdfError::FileNotFound {
                    path: file_path.clone(),
                    source: e.to_string(),
                })?;
            
            let renderer = PdfRenderer::with_cache(file_path.clone(), pdfium.clone(), cache);
            let mut results = Vec::new();
            for page_num in page_numbers {
                let result = renderer.render_page_sync(&document, page_num, options.clone());
                results.push(result);
            }
            Ok::<Vec<Result<RenderResult, PdfError>>, PdfError>(results)
        })
        .await
        {
            Ok(Ok(results)) => results,
            Ok(Err(err)) => vec![Err(err)],
            Err(err) => vec![Err(PdfError::render_error(0, "render_pages_batch", format!("批量渲染任务失败: {}", err)))],
        }
    }

    /// 使用自定义线程池渲染页面
    pub async fn render_pages_with_thread_pool(
        &self,
        page_numbers: Vec<u32>,
        options: RenderOptions,
        _num_threads: usize,
    ) -> Vec<Result<RenderResult, PdfError>> {
        // 由于 PdfDocument 不是 Send，我们使用并行渲染而不是线程池
        // 这里忽略 num_threads 参数，使用默认的并行策略
        self.render_pages_parallel(page_numbers, options).await
    }
}

/// 预热策略
#[derive(Debug, Clone)]
pub enum WarmupStrategy {
    /// 预热前 N 页
    FirstPages {
        count: u32,
        quality: RenderQuality,
    },
    /// 预热指定页面
    SpecificPages {
        pages: Vec<u32>,
        quality: RenderQuality,
    },
    /// 预热所有缩略图
    AllThumbnails,
    /// 智能预热
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

/// PDF 引擎管理器
pub struct PdfEngineManager {
    engines: Arc<RwLock<HashMap<String, Arc<RwLock<PdfEngine>>>>>,
    cache_manager: CacheManager,
}

impl PdfEngineManager {
    /// 创建新的引擎管理器
    pub fn new() -> Result<Self, PdfError> {
        Ok(Self {
            engines: Arc::new(RwLock::new(HashMap::new())),
            cache_manager: CacheManager::new(),
        })
    }

    /// 使用指定的缓存限制创建管理器
    pub fn with_cache_limits(max_size: usize, max_items: usize) -> Result<Self, PdfError> {
        Ok(Self {
            engines: Arc::new(RwLock::new(HashMap::new())),
            cache_manager: CacheManager::with_limits(max_size, max_items),
        })
    }

    /// 获取或创建引擎
    pub async fn get_or_create_engine(
        &self,
        file_path: &str,
    ) -> Result<Arc<RwLock<PdfEngine>>, PdfError> {
        let engines = self.engines.read().await;

        if let Some(engine) = engines.get(file_path) {
            return Ok(Arc::clone(engine));
        }

        drop(engines);

        let mut engine = PdfEngine::with_cache(self.cache_manager.clone())?;
        engine.load_document(file_path).await?;

        let engine_arc = Arc::new(RwLock::new(engine));

        let mut engines = self.engines.write().await;
        engines.insert(file_path.to_string(), Arc::clone(&engine_arc));

        Ok(engine_arc)
    }

    /// 获取引擎
    pub async fn get_engine(&self, file_path: &str) -> Option<Arc<RwLock<PdfEngine>>> {
        let engines = self.engines.read().await;
        engines.get(file_path).map(Arc::clone)
    }

    /// 移除引擎
    pub async fn remove_engine(&self, file_path: &str) -> Option<Arc<RwLock<PdfEngine>>> {
        let mut engines = self.engines.write().await;
        engines.remove(file_path)
    }

    /// 清除所有引擎
    pub async fn clear_all(&self) {
        let mut engines = self.engines.write().await;
        engines.clear();
        self.cache_manager.clear().await;
    }

    /// 获取已加载的文件列表
    pub async fn get_loaded_files(&self) -> Vec<String> {
        let engines = self.engines.read().await;
        engines.keys().cloned().collect()
    }

    /// 获取缓存管理器
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

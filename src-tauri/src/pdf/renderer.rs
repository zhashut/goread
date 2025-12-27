use pdfium_render::prelude::*;
use image::{RgbaImage, Rgba};
use std::sync::Arc;
use webp::Encoder;

use crate::pdf::types::{
    CacheKey, ImageFormat, PdfError, RenderOptions, RenderQuality, RenderResult,
};
use crate::pdf::cache::CacheManager;
use crate::pdf::performance::{PerformanceMonitor, PerformanceTimer};

/// PDF 渲染器，负责将 PDF 页面渲染为图像
pub struct PdfRenderer {
    file_path: String,
    cache: CacheManager,
    thumb_cache: CacheManager,
    performance_monitor: Option<PerformanceMonitor>,
    pdfium: Arc<Pdfium>,
}

impl PdfRenderer {
    /// 创建新的渲染器
    pub fn new(file_path: String, pdfium: Arc<Pdfium>) -> Self {
        Self {
            file_path,
            cache: CacheManager::new(),
            thumb_cache: CacheManager::with_limits(16 * 1024 * 1024, 64),
            performance_monitor: Some(PerformanceMonitor::new()),
            pdfium,
        }
    }

    /// 使用指定的缓存管理器创建渲染器
    pub fn with_cache(file_path: String, pdfium: Arc<Pdfium>, cache: CacheManager) -> Self {
        Self {
            file_path,
            cache,
            thumb_cache: CacheManager::with_limits(16 * 1024 * 1024, 64),
            performance_monitor: Some(PerformanceMonitor::new()),
            pdfium,
        }
    }

    /// 设置性能监控器
    pub fn with_performance_monitor(mut self, monitor: PerformanceMonitor) -> Self {
        self.performance_monitor = Some(monitor);
        self
    }

    /// 禁用性能监控
    pub fn without_performance_monitor(mut self) -> Self {
        self.performance_monitor = None;
        self
    }

    /// 获取性能监控器
    pub fn get_performance_monitor(&self) -> Option<&PerformanceMonitor> {
        self.performance_monitor.as_ref()
    }

    /// 渲染单个页面（同步版本）- 优化：优先检查缓存，快速返回
    pub fn render_page_sync(
        &self,
        document: &PdfDocument<'_>,
        page_number: u32,
        options: RenderOptions,
    ) -> Result<RenderResult, PdfError> {
        // 获取页面
        let page = document
            .pages()
            .get((page_number - 1) as u16)
            .map_err(|e| {
                PdfError::parse_error(Some(page_number), "获取页面失败", e.to_string())
            })?;

        let base_width = page.width().value;
        let base_height = page.height().value;

        let (target_width, target_height) =
            self.calculate_dimensions(base_width, base_height, &options);

        let theme_key = options
            .theme
            .clone()
            .unwrap_or_else(|| "light".to_string());
        let cache_key = CacheKey::new(
            self.file_path.clone(),
            page_number,
            options.quality.clone(),
            target_width,
            target_height,
            theme_key,
        );

        // 使用 tokio 的 block_in_place 来同步访问缓存
        let cached = tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(async {
                if matches!(options.quality, RenderQuality::Thumbnail) {
                    self.thumb_cache.get(&cache_key).await
                } else {
                    self.cache.get(&cache_key).await
                }
            })
        });

        if let Some(result) = cached {
            return Ok(result);
        }

        // 渲染页面
        let image = self.render_page_to_image(&page, page_number, target_width, target_height, &options)?;

        // 编码图像（按质量选择格式）
        let out_format = match options.quality {
            RenderQuality::Thumbnail => ImageFormat::Png,
            RenderQuality::Standard => ImageFormat::WebP,
            RenderQuality::High => ImageFormat::WebP,
            RenderQuality::Best => ImageFormat::Png,
        };
        let image_data = self.encode_image(&image, out_format.clone())?;

        let result = RenderResult {
            image_data,
            width: target_width,
            height: target_height,
            format: out_format,
        };

        // 异步缓存结果（不阻塞返回）
        let cache_key_clone = cache_key.clone();
        let result_clone = result.clone();
        let cache = if matches!(options.quality, RenderQuality::Thumbnail) {
            self.thumb_cache.clone()
        } else {
            self.cache.clone()
        };
        
        tokio::task::spawn(async move {
            let _ = cache.put(cache_key_clone, result_clone).await;
        });

        Ok(result)
    }

    /// 渲染单个页面
    pub async fn render_page(
        &self,
        document: &PdfDocument<'_>,
        page_number: u32,
        options: RenderOptions,
    ) -> Result<RenderResult, PdfError> {
        let timer = self
            .performance_monitor
            .as_ref()
            .map(|m| PerformanceTimer::with_monitor(m.clone()))
            .unwrap_or_else(|| PerformanceTimer::new());

        // 获取页面
        let page = document
            .pages()
            .get((page_number - 1) as u16)
            .map_err(|e| {
                PdfError::parse_error(Some(page_number), "获取页面失败", e.to_string())
            })?;

        let base_width = page.width().value;
        let base_height = page.height().value;

        let (target_width, target_height) =
            self.calculate_dimensions(base_width, base_height, &options);

        let theme_key = options
            .theme
            .clone()
            .unwrap_or_else(|| "light".to_string());
        let cache_key = CacheKey::new(
            self.file_path.clone(),
            page_number,
            options.quality.clone(),
            target_width,
            target_height,
            theme_key,
        );

        let use_thumb_cache = matches!(options.quality, RenderQuality::Thumbnail);
        if use_thumb_cache {
            if let Some(cached) = self.thumb_cache.get(&cache_key).await {
                if let Some(monitor) = &self.performance_monitor {
                    monitor.record_cache_hit().await;
                }
                return Ok(cached);
            }
        } else if let Some(cached) = self.cache.get(&cache_key).await {
            if let Some(monitor) = &self.performance_monitor {
                monitor.record_cache_hit().await;
            }
            return Ok(cached);
        }

        if let Some(monitor) = &self.performance_monitor {
            monitor.record_cache_miss().await;
        }

        // 渲染页面
        let image = self.render_page_to_image(&page, page_number, target_width, target_height, &options)?;

        // 编码图像（按质量选择格式）
        let out_format = match options.quality {
            RenderQuality::Thumbnail => ImageFormat::Png,
            RenderQuality::Standard => ImageFormat::WebP,
            RenderQuality::High => ImageFormat::WebP,
            RenderQuality::Best => ImageFormat::Png,
        };
        let image_data = self.encode_image(&image, out_format.clone())?;

        let result = RenderResult {
            image_data,
            width: target_width,
            height: target_height,
            format: out_format,
        };

        // 缓存结果
        if use_thumb_cache {
            self.thumb_cache.put(cache_key, result.clone()).await?;
        } else {
            self.cache.put(cache_key, result.clone()).await?;
        }

        timer.finish().await;

        Ok(result)
    }

    /// 将 PDF 页面渲染为图像
    fn render_page_to_image(
        &self,
        page: &PdfPage,
        page_number: u32,
        width: u32,
        height: u32,
        options: &RenderOptions,
    ) -> Result<RgbaImage, PdfError> {
        // 配置渲染选项
        let config = PdfRenderConfig::new()
            .set_target_width(width as i32)
            .set_target_height(height as i32)
            .rotate_if_landscape(PdfPageRenderRotation::None, false);

        // 渲染为位图
        let bitmap = page.render_with_config(&config).map_err(|e| {
            PdfError::render_error(
                page_number,
                "render_with_config",
                e.to_string(),
            )
        })?;

        // 转换为 RGBA 图像
        let rgba_image = self.bitmap_to_rgba_image(&bitmap, page_number, width, height, options)?;

        Ok(rgba_image)
    }

    pub fn render_page_tile_sync(
        &self,
        document: &PdfDocument<'_>,
        page_number: u32,
        region: crate::pdf::types::RenderRegion,
        options: RenderOptions,
    ) -> Result<RenderResult, PdfError> {
        let page = document
            .pages()
            .get((page_number - 1) as u16)
            .map_err(|e| {
                PdfError::parse_error(Some(page_number), "获取页面失败", e.to_string())
            })?;

        let base_width = page.width().value;
        let base_height = page.height().value;
        let (target_width, target_height) = self.calculate_dimensions(base_width, base_height, &options);

        let region_px_x = ((region.x / base_width) * target_width as f32).round() as u32;
        let region_px_y = ((region.y / base_height) * target_height as f32).round() as u32;
        let region_px_w = ((region.width / base_width) * target_width as f32).round() as u32;
        let region_px_h = ((region.height / base_height) * target_height as f32).round() as u32;

        let config = PdfRenderConfig::new()
            .set_target_width(target_width as i32)
            .set_target_height(target_height as i32)
            .rotate_if_landscape(PdfPageRenderRotation::None, false);

        let bitmap = page.render_with_config(&config).map_err(|e| {
            PdfError::render_error(page_number, "render_with_config", e.to_string())
        })?;

        let sub_image = self.bitmap_to_rgba_subimage(
            &bitmap,
            page_number,
            target_width,
            target_height,
            region_px_x,
            region_px_y,
            region_px_w,
            region_px_h,
            &options,
        )?;

        let image_data = self.encode_image(&sub_image, ImageFormat::Png)?;

        Ok(RenderResult { image_data, width: region_px_w, height: region_px_h, format: ImageFormat::Png })
    }

    /// 将 Pdfium 位图转换为 RGBA 图像
    /// 优化：使用直接字节操作替代逐像素 put_pixel，提高性能，并手动计算 stride
    fn bitmap_to_rgba_image(
        &self,
        bitmap: &PdfBitmap,
        page_number: u32,
        width: u32,
        height: u32,
        options: &RenderOptions,
    ) -> Result<RgbaImage, PdfError> {
        let buffer = bitmap.as_bytes();
        
        // 修复：处理 Result 类型，获取具体的格式枚举
        let format = bitmap.format().map_err(|e| PdfError::render_error(
            page_number,
            "bitmap_format",
            format!("无法获取位图格式: {}", e),
        ))?;

        // 1. 确定每像素字节数
        let bytes_per_pixel = match format {
            PdfBitmapFormat::BGRA => 4,
            PdfBitmapFormat::BGR => 3,
            PdfBitmapFormat::Gray => 1,
            _ => 4, // 默认或未知格式按 4 处理
        };

        // 2. 计算 stride (行跨度)
        // Pdfium 通常将 stride 对齐到 4 字节
        let stride = ((width * bytes_per_pixel + 3) & !3) as usize;

        // 3. 准备目标缓冲区
        let target_size = (width * height * 4) as usize;
        let mut rgba_data = Vec::with_capacity(target_size);

        // 4. 按行遍历并转换
        match format {
            PdfBitmapFormat::BGRA => {
                // BGRA -> RGBA
                for row in 0..height {
                    let start = (row as usize) * stride;
                    let end = start + (width as usize) * 4;
                    
                    // 安全检查：确保缓冲区足够
                    if end > buffer.len() { break; }
                    
                    let row_data = &buffer[start..end];
                    
                    // 使用 chunks_exact 优化循环
                    for chunk in row_data.chunks_exact(4) {
                        rgba_data.push(chunk[0]); // R
                        rgba_data.push(chunk[1]); // G
                        rgba_data.push(chunk[2]); // B
                        rgba_data.push(chunk[3]); // A
                    }
                }
            }
            PdfBitmapFormat::BGR => {
                // BGR -> RGBA
                for row in 0..height {
                    let start = (row as usize) * stride;
                    let end = start + (width as usize) * 3;
                    
                    if end > buffer.len() { break; }
                    
                    let row_data = &buffer[start..end];
                    
                    for chunk in row_data.chunks_exact(3) {
                        rgba_data.push(chunk[0]); // R
                        rgba_data.push(chunk[1]); // G
                        rgba_data.push(chunk[2]); // B
                        rgba_data.push(255);      // A
                    }
                }
            }
            PdfBitmapFormat::Gray => {
                // Gray -> RGBA
                for row in 0..height {
                    let start = (row as usize) * stride;
                    let end = start + (width as usize); // 1 byte per pixel
                    
                    if end > buffer.len() { break; }
                    
                    let row_data = &buffer[start..end];
                    
                    for &val in row_data {
                        rgba_data.push(val); // R
                        rgba_data.push(val); // G
                        rgba_data.push(val); // B
                        rgba_data.push(255); // A
                    }
                }
            }
            _ => {
                return Err(PdfError::render_error(
                    page_number,
                    "位图格式转换",
                    format!("不支持的位图格式: {:?}", format),
                ));
            }
        }

        // 如果由于 stride 计算或截断导致数据不足，补齐（防止 crash）
        if rgba_data.len() < target_size {
            rgba_data.resize(target_size, 0);
        }

        if let Some(theme) = options.theme.as_deref() {
            if theme == "dark" {
                let mut i = 0usize;
                while i + 3 < rgba_data.len() {
                    let r = rgba_data[i];
                    let g = rgba_data[i + 1];
                    let b = rgba_data[i + 2];
                    let a = rgba_data[i + 3];
                    rgba_data[i] = 255u8.saturating_sub(r);
                    rgba_data[i + 1] = 255u8.saturating_sub(g);
                    rgba_data[i + 2] = 255u8.saturating_sub(b);
                    rgba_data[i + 3] = a;
                    i += 4;
                }
            }
        }

        RgbaImage::from_vec(width, height, rgba_data).ok_or_else(|| {
            PdfError::render_error(
                page_number,
                "image_creation",
                "无法从数据创建图像缓冲区".to_string(),
            )
        })
    }

    fn bitmap_to_rgba_subimage(
        &self,
        bitmap: &PdfBitmap,
        page_number: u32,
        full_width: u32,
        full_height: u32,
        x: u32,
        y: u32,
        w: u32,
        h: u32,
        options: &RenderOptions,
    ) -> Result<RgbaImage, PdfError> {
        let buffer = bitmap.as_bytes();
        let format = bitmap.format().map_err(|e| PdfError::render_error(
            page_number,
            "bitmap_format",
            format!("无法获取位图格式: {}", e),
        ))?;

        let bytes_per_pixel = match format {
            PdfBitmapFormat::BGRA => 4,
            PdfBitmapFormat::BGR => 3,
            PdfBitmapFormat::Gray => 1,
            _ => 4,
        };
        let stride = ((full_width * bytes_per_pixel + 3) & !3) as usize;

        let mut rgba_data = Vec::with_capacity((w * h * 4) as usize);

        match format {
            PdfBitmapFormat::BGRA => {
                for row in 0..h {
                    let sy = y + row;
                    for col in 0..w {
                        let sx = x + col;
                        let idx = (sy as usize) * stride + (sx as usize) * 4;
                        if idx + 3 >= buffer.len() { rgba_data.extend_from_slice(&[0,0,0,0]); continue; }
                        rgba_data.push(buffer[idx + 0]);
                        rgba_data.push(buffer[idx + 1]);
                        rgba_data.push(buffer[idx + 2]);
                        rgba_data.push(buffer[idx + 3]);
                    }
                }
            }
            PdfBitmapFormat::BGR => {
                for row in 0..h {
                    let sy = y + row;
                    for col in 0..w {
                        let sx = x + col;
                        let idx = (sy as usize) * stride + (sx as usize) * 3;
                        if idx + 2 >= buffer.len() { rgba_data.extend_from_slice(&[0,0,0,255]); continue; }
                        rgba_data.push(buffer[idx + 0]);
                        rgba_data.push(buffer[idx + 1]);
                        rgba_data.push(buffer[idx + 2]);
                        rgba_data.push(255);
                    }
                }
            }
            PdfBitmapFormat::Gray => {
                for row in 0..h {
                    let sy = y + row;
                    for col in 0..w {
                        let sx = x + col;
                        let idx = (sy as usize) * stride + (sx as usize);
                        if idx >= buffer.len() { rgba_data.extend_from_slice(&[0,0,0,255]); continue; }
                        let v = buffer[idx];
                        rgba_data.push(v);
                        rgba_data.push(v);
                        rgba_data.push(v);
                        rgba_data.push(255);
                    }
                }
            }
            _ => {
                return Err(PdfError::render_error(0, "位图格式转换", format!("不支持的位图格式: {:?}", format)));
            }
        }

        if let Some(theme) = options.theme.as_deref() {
            if theme == "dark" {
                let mut i = 0usize;
                while i + 3 < rgba_data.len() {
                    let r = rgba_data[i];
                    let g = rgba_data[i + 1];
                    let b = rgba_data[i + 2];
                    let a = rgba_data[i + 3];
                    rgba_data[i] = 255u8.saturating_sub(r);
                    rgba_data[i + 1] = 255u8.saturating_sub(g);
                    rgba_data[i + 2] = 255u8.saturating_sub(b);
                    rgba_data[i + 3] = a;
                    i += 4;
                }
            }
        }

        RgbaImage::from_vec(w, h, rgba_data).ok_or_else(|| {
            PdfError::render_error(page_number, "image_creation", "无法从数据创建图像缓冲区".to_string())
        })
    }

    /// 计算目标尺寸
    fn calculate_dimensions(
        &self,
        base_width: f32,
        base_height: f32,
        options: &RenderOptions,
    ) -> (u32, u32) {
        let scale = options.quality.scale_factor();

        // 防止尺寸为 0
        let safe_width = |w: f32| w.max(1.0) as u32;
        let safe_height = |h: f32| h.max(1.0) as u32;

        if let Some(width) = options.width {
            if options.fit_to_width {
                let height = base_height * width as f32 / base_width;
                return (safe_width(width as f32), safe_height(height));
            }
        }

        if let Some(height) = options.height {
            if options.fit_to_height {
                let width = base_width * height as f32 / base_height;
                return (safe_width(width), safe_height(height as f32));
            }
        }

        let width = base_width * scale;
        let height = base_height * scale;

        (safe_width(width), safe_height(height))
    }

    /// 编码图像
    fn encode_image(&self, image: &RgbaImage, format: ImageFormat) -> Result<Vec<u8>, PdfError> {
        let mut buffer = Vec::new();
        let (width, height) = image.dimensions();

        match format {
            ImageFormat::Png => {
                let encoder = image::codecs::png::PngEncoder::new_with_quality(
                    &mut buffer,
                    image::codecs::png::CompressionType::Best,
                    image::codecs::png::FilterType::Adaptive,
                );
                use image::ImageEncoder;
                encoder
                    .write_image(image.as_raw(), width, height, image::ColorType::Rgba8)
                    .map_err(|e| PdfError::render_error(0, "PNG编码", e.to_string()))?;
            }
            ImageFormat::Jpeg => {
                let rgb_image = self.convert_rgba_to_rgb(image);
                let quality = self.calculate_jpeg_quality(width, height);
                let mut encoder =
                    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buffer, quality);
                encoder
                    .encode(rgb_image.as_raw(), width, height, image::ColorType::Rgb8)
                    .map_err(|e| PdfError::render_error(0, "JPEG编码", e.to_string()))?;
            }
            ImageFormat::WebP => {
                let quality = self.calculate_webp_quality(width, height);
                let encoder = Encoder::from_rgba(image.as_raw(), width, height);
                let webp_data = if quality >= 95.0 {
                    encoder.encode_lossless()
                } else {
                    encoder.encode(quality)
                };
                buffer = webp_data.to_vec();
            }
        }

        Ok(buffer)
    }

    /// 将 RGBA 图像转换为 RGB
    fn convert_rgba_to_rgb(&self, rgba_image: &RgbaImage) -> image::RgbImage {
        let (width, height) = rgba_image.dimensions();
        let mut rgb_image = image::RgbImage::new(width, height);
        for y in 0..height {
            for x in 0..width {
                let p = rgba_image.get_pixel(x, y);
                let a = p[3] as f32 / 255.0;
                let r = ((p[0] as f32 * a) + (255.0 * (1.0 - a))) as u8;
                let g = ((p[1] as f32 * a) + (255.0 * (1.0 - a))) as u8;
                let b = ((p[2] as f32 * a) + (255.0 * (1.0 - a))) as u8;
                rgb_image.put_pixel(x, y, image::Rgb([r, g, b]));
            }
        }
        rgb_image
    }

    /// 计算 JPEG 质量
    fn calculate_jpeg_quality(&self, width: u32, height: u32) -> u8 {
        let pixels = width * height;
        if pixels > 2_000_000 {
            75
        } else if pixels > 1_000_000 {
            85
        } else {
            90
        }
    }

    /// 计算 WebP 质量
    fn calculate_webp_quality(&self, width: u32, height: u32) -> f32 {
        let pixels = width * height;
        if pixels > 2_000_000 {
            80.0
        } else if pixels > 1_000_000 {
            85.0
        } else if pixels > 500_000 {
            90.0
        } else {
            95.0
        }
    }

    /// 并行渲染多个页面
    pub async fn render_pages_parallel(
        &self,
        document: &PdfDocument<'_>,
        page_numbers: Vec<u32>,
        options: RenderOptions,
    ) -> Vec<Result<RenderResult, PdfError>> {
        let mut tasks = Vec::new();
        for page_num in page_numbers {
            let task = self.render_page(document, page_num, options.clone());
            tasks.push(task);
        }

        futures::future::join_all(tasks).await
    }

    /// 渐进式渲染页面
    pub async fn render_page_progressive<F>(
        &self,
        document: &PdfDocument<'_>,
        page_number: u32,
        base_options: RenderOptions,
        mut callback: F,
    ) -> Result<(), PdfError>
    where
        F: FnMut(RenderQuality, RenderResult) + Send,
    {
        let stages = vec![
            RenderQuality::Thumbnail,
            RenderQuality::Standard,
            base_options.quality.clone(),
        ];

        for quality in stages {
            let options = RenderOptions {
                quality: quality.clone(),
                ..base_options.clone()
            };
            let result = self.render_page(document, page_number, options).await?;
            callback(quality, result);
        }

        Ok(())
    }

    /// 批量渲染页面
    pub async fn render_pages_batch(
        &self,
        document: &PdfDocument<'_>,
        page_numbers: Vec<u32>,
        options: RenderOptions,
    ) -> Vec<Result<RenderResult, PdfError>> {
        let mut results = Vec::new();
        for page_number in page_numbers {
            let result = self.render_page(document, page_number, options.clone()).await;
            results.push(result);
        }
        results
    }

    /// 清除所有缓存
    pub async fn clear_cache(&self) {
        self.cache.clear().await;
    }

    /// 清除指定页面的缓存
    pub async fn clear_page_cache(&self, page_number: u32) {
        self.cache.clear_page(&self.file_path, page_number).await;
    }
}

impl Clone for PdfRenderer {
    fn clone(&self) -> Self {
        Self {
            file_path: self.file_path.clone(),
            cache: self.cache.clone(),
            thumb_cache: self.thumb_cache.clone(),
            performance_monitor: self.performance_monitor.clone(),
            pdfium: Arc::clone(&self.pdfium),
        }
    }
}

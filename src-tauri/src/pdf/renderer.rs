use lopdf::content::{Content, Operation};
use lopdf::{Document, Object, ObjectId};
use crate::pdf::engine::PdfFile;
fn as_f32(o: Option<&Object>) -> Option<f32> {
    match o {
        Some(Object::Integer(v)) => Some(*v as f32),
        Some(Object::Real(v)) => Some(*v as f32),
        _ => None,
    }
}

use image::{ImageBuffer, Rgba, RgbaImage};
use crate::pdf::types::{RenderOptions, RenderResult, ImageFormat, PdfError, CacheKey, RenderQuality};
use crate::pdf::cache::CacheManager;
use crate::pdf::performance::{PerformanceMonitor, PerformanceTimer};
use std::sync::Arc;
use webp::Encoder;

pub struct PdfRenderer {
    cache: CacheManager,
    performance_monitor: Option<PerformanceMonitor>,
}

impl PdfRenderer {
    pub fn new() -> Self {
        Self {
            cache: CacheManager::new(),
            performance_monitor: Some(PerformanceMonitor::new()),
        }
    }

    pub fn with_cache(cache: CacheManager) -> Self {
        Self { 
            cache,
            performance_monitor: Some(PerformanceMonitor::new()),
        }
    }

    pub fn with_performance_monitor(mut self, monitor: PerformanceMonitor) -> Self {
        self.performance_monitor = Some(monitor);
        self
    }

    pub fn without_performance_monitor(mut self) -> Self {
        self.performance_monitor = None;
        self
    }

    pub fn get_performance_monitor(&self) -> Option<&PerformanceMonitor> {
        self.performance_monitor.as_ref()
    }

    pub async fn render_page(
        &self,
        document: &PdfFile,
        page_number: u32,
        options: RenderOptions,
    ) -> Result<RenderResult, PdfError> {
        let timer = self.performance_monitor.as_ref()
            .map(|m| PerformanceTimer::with_monitor(m.clone()))
            .unwrap_or_else(|| PerformanceTimer::new());

        let pages_map = document.get_pages();
        let page_id = pages_map.get(&page_number)
            .ok_or_else(|| PdfError::page_not_found(page_number, pages_map.len() as u32))?;

        let page_obj = document.get_object(*page_id)
            .map_err(|e| PdfError::parse_error(Some(page_number), "读取页面对象失败", e.to_string()))?;
        let dict = page_obj.as_dict()?;

        let (base_width, base_height) = if let Ok(media_box_obj) = dict.get(b"MediaBox") {
            if let Ok(arr) = media_box_obj.as_array() {
                let nums: Vec<f32> = arr.iter().filter_map(|o| match o { Object::Integer(v) => Some(*v as f32), Object::Real(v) => Some(*v as f32), _ => None }).collect();
                if nums.len() >= 4 { ((nums[2]-nums[0]).abs(), (nums[3]-nums[1]).abs()) } else { (612.0, 792.0) }
            } else { (612.0, 792.0) }
        } else { (612.0, 792.0) };

        let (target_width, target_height) = self.calculate_dimensions(
            base_width,
            base_height,
            &options,
        );

        let cache_key = CacheKey::new(
            page_number,
            options.quality.clone(),
            target_width,
            target_height,
        );

        if let Some(cached) = self.cache.get(&cache_key).await {
            if let Some(monitor) = &self.performance_monitor {
                monitor.record_cache_hit().await;
            }
            return Ok(cached);
        }

        if let Some(monitor) = &self.performance_monitor {
            monitor.record_cache_miss().await;
        }

        let mut image = ImageBuffer::from_pixel(
            target_width,
            target_height,
            options.background_rgba(),
        );

        self.render_page_internal(document, *page_id, &mut image, base_width, base_height, target_width, target_height)?;

        let image_data = self.encode_image(&image, ImageFormat::Png)?;

        let result = RenderResult {
            image_data,
            width: target_width,
            height: target_height,
            format: ImageFormat::Png,
        };

        self.cache.put(cache_key, result.clone()).await?;

        timer.finish().await;

        Ok(result)
    }

    pub async fn render_pages_parallel(
        &self,
        document: &PdfFile,
        page_numbers: Vec<u32>,
        options: RenderOptions,
    ) -> Vec<Result<RenderResult, PdfError>> {
        // 使用futures并发执行，而不是rayon的线程池
        let mut tasks = Vec::new();
        for page_num in page_numbers {
            let task = self.render_page(document, page_num, options.clone());
            tasks.push(task);
        }
        
        // 并发执行所有任务
        futures::future::join_all(tasks).await
    }

    pub async fn render_page_range_parallel(
        &self,
        document: &PdfFile,
        start_page: u32,
        end_page: u32,
        options: RenderOptions,
    ) -> Vec<Result<RenderResult, PdfError>> {
        let page_numbers: Vec<u32> = (start_page..=end_page).collect();
        self.render_pages_parallel(document, page_numbers, options).await
    }

    pub async fn render_pages_with_thread_pool(
        &self,
        document: &PdfFile,
        page_numbers: Vec<u32>,
        options: RenderOptions,
        num_threads: usize,
    ) -> Vec<Result<RenderResult, PdfError>> {
        // 使用tokio的semaphore来限制并发数
        use tokio::sync::Semaphore;
        let semaphore = Arc::new(Semaphore::new(num_threads));
        
        let mut tasks = Vec::new();
        for page_num in page_numbers {
            let permit = semaphore.clone().acquire_owned().await.unwrap();
            let value = options.clone();
            let task = async move {
                let result = self.render_page(document, page_num, value).await;
                drop(permit); // 释放许可
                result
            };
            tasks.push(task);
        }
        
        futures::future::join_all(tasks).await
    }

    fn calculate_dimensions(
        &self,
        base_width: f32,
        base_height: f32,
        options: &RenderOptions,
    ) -> (u32, u32) {
        let scale = options.quality.scale_factor();

        if let Some(width) = options.width {
            if options.fit_to_width {
                let height = (base_height * width as f32 / base_width) as u32;
                return (width, height);
            }
        }

        if let Some(height) = options.height {
            if options.fit_to_height {
                let width = (base_width * height as f32 / base_height) as u32;
                return (width, height);
            }
        }

        let width = options.width.unwrap_or((base_width * scale) as u32);
        let height = options.height.unwrap_or((base_height * scale) as u32);

        (width, height)
    }

    fn render_page_internal(
        &self,
        document: &PdfFile,
        page_id: ObjectId,
        image: &mut RgbaImage,
        base_width: f32,
        base_height: f32,
        target_width: u32,
        target_height: u32,
    ) -> Result<(), PdfError> {
        let scale_x = target_width as f32 / base_width;
        let scale_y = target_height as f32 / base_height;

        let content_data = document.get_page_content(page_id).unwrap_or_default();
        if !content_data.is_empty() {
            let content = Content::decode(&content_data)
                .map_err(|e| PdfError::render_error(0, "内容解析", e.to_string()))?;
            self.render_content_stream(&content, image, scale_x, scale_y)?;
        }

        Ok(())
    }

    fn render_content_stream(
        &self,
        content: &Content,
        image: &mut RgbaImage,
        scale_x: f32,
        scale_y: f32,
    ) -> Result<(), PdfError> {
        let mut graphics_state = GraphicsState::default();

        for op in &content.operations {
            let name = op.operator.as_str();
            match name {
                "m" => {
                    let x = as_f32(op.operands.get(0));
                    let y = as_f32(op.operands.get(1));
                    if let (Some(x), Some(y)) = (x, y) { graphics_state.current_path.move_to(x, y); }
                }
                "l" => {
                    let x = as_f32(op.operands.get(0));
                    let y = as_f32(op.operands.get(1));
                    if let (Some(x), Some(y)) = (x, y) { graphics_state.current_path.line_to(x, y); }
                }
                "c" => {
                    let x1 = as_f32(op.operands.get(0));
                    let y1 = as_f32(op.operands.get(1));
                    let x2 = as_f32(op.operands.get(2));
                    let y2 = as_f32(op.operands.get(3));
                    let x3 = as_f32(op.operands.get(4));
                    let y3 = as_f32(op.operands.get(5));
                    if let (Some(x1), Some(y1), Some(x2), Some(y2), Some(x3), Some(y3)) = (x1,y1,x2,y2,x3,y3) {
                        graphics_state.current_path.curve_to(x1,y1,x2,y2,x3,y3);
                    }
                }
                "re" => {
                    let x = as_f32(op.operands.get(0));
                    let y = as_f32(op.operands.get(1));
                    let w = as_f32(op.operands.get(2));
                    let h = as_f32(op.operands.get(3));
                    if let (Some(x), Some(y), Some(w), Some(h)) = (x,y,w,h) { graphics_state.current_path.rectangle(x,y,w,h); }
                }
                "S" => {
                    self.stroke_path(&graphics_state, image, scale_x, scale_y)?;
                }
                "f" | "F" => {
                    self.fill_path(&graphics_state, image, scale_x, scale_y)?;
                }
                "B" | "B*" => {
                    self.fill_path(&graphics_state, image, scale_x, scale_y)?;
                    self.stroke_path(&graphics_state, image, scale_x, scale_y)?;
                }
                "rg" => {
                    let r = as_f32(op.operands.get(0)).unwrap_or(0.0);
                    let g = as_f32(op.operands.get(1)).unwrap_or(0.0);
                    let b = as_f32(op.operands.get(2)).unwrap_or(0.0);
                    graphics_state.fill_color = image::Rgba([(r*255.0) as u8, (g*255.0) as u8, (b*255.0) as u8, 255]);
                }
                "RG" => {
                    let r = as_f32(op.operands.get(0)).unwrap_or(0.0);
                    let g = as_f32(op.operands.get(1)).unwrap_or(0.0);
                    let b = as_f32(op.operands.get(2)).unwrap_or(0.0);
                    graphics_state.stroke_color = image::Rgba([(r*255.0) as u8, (g*255.0) as u8, (b*255.0) as u8, 255]);
                }
                "g" => {
                    let gv = as_f32(op.operands.get(0)).unwrap_or(0.0);
                    let v = (gv*255.0) as u8;
                    graphics_state.fill_color = image::Rgba([v,v,v,255]);
                }
                "G" => {
                    let gv = as_f32(op.operands.get(0)).unwrap_or(0.0);
                    let v = (gv*255.0) as u8;
                    graphics_state.stroke_color = image::Rgba([v,v,v,255]);
                }
                "w" => {
                    let w = as_f32(op.operands.get(0)).unwrap_or(1.0);
                    graphics_state.line_width = w;
                }
                "q" => graphics_state.save(),
                "Q" => graphics_state.restore(),
                _ => {}
            }
        }

        Ok(())
    }

    fn color_to_rgba_cmyk(&self, c: f32, m: f32, y: f32, k: f32) -> Rgba<u8> {
        let r = (1.0 - c) * (1.0 - k);
        let g = (1.0 - m) * (1.0 - k);
        let b = (1.0 - y) * (1.0 - k);
        Rgba([(r * 255.0) as u8, (g * 255.0) as u8, (b * 255.0) as u8, 255])
    }

    fn close_path(&self, state: &mut GraphicsState) -> Result<(), PdfError> {
        state.current_path.close();
        Ok(())
    }

    fn stroke_path(
        &self,
        state: &GraphicsState,
        image: &mut RgbaImage,
        scale_x: f32,
        scale_y: f32,
    ) -> Result<(), PdfError> {
        let color = state.stroke_color;
        let line_width = (state.line_width * scale_x.max(scale_y)).max(1.0) as u32;

        for segment in &state.current_path.segments {
            match segment {
                PathSegment::Line { from, to } => {
                    self.draw_line(
                        image,
                        (from.0 * scale_x) as i32,
                        (from.1 * scale_y) as i32,
                        (to.0 * scale_x) as i32,
                        (to.1 * scale_y) as i32,
                        color,
                        line_width,
                    );
                }
                PathSegment::Rectangle { x, y, width, height } => {
                    self.draw_rectangle(
                        image,
                        (*x * scale_x) as u32,
                        (*y * scale_y) as u32,
                        (*width * scale_x) as u32,
                        (*height * scale_y) as u32,
                        color,
                        line_width,
                        false,
                    );
                }
                _ => {}
            }
        }

        Ok(())
    }

    fn fill_path(
        &self,
        state: &GraphicsState,
        image: &mut RgbaImage,
        scale_x: f32,
        scale_y: f32,
    ) -> Result<(), PdfError> {
        let color = state.fill_color;

        for segment in &state.current_path.segments {
            if let PathSegment::Rectangle { x, y, width, height } = segment {
                self.draw_rectangle(
                    image,
                    (*x * scale_x) as u32,
                    (*y * scale_y) as u32,
                    (*width * scale_x) as u32,
                    (*height * scale_y) as u32,
                    color,
                    1,
                    true,
                );
            }
        }

        Ok(())
    }

    // Resources rendering (images, forms) omitted in lopdf conversion

    // Image XObject rendering omitted in lopdf conversion

    // Image decoding omitted in lopdf conversion

    // RGB decode omitted

    // Gray decode omitted

    fn draw_line(
        &self,
        image: &mut RgbaImage,
        x0: i32,
        y0: i32,
        x1: i32,
        y1: i32,
        color: Rgba<u8>,
        width: u32,
    ) {
        let dx = (x1 - x0).abs();
        let dy = (y1 - y0).abs();
        let sx = if x0 < x1 { 1 } else { -1 };
        let sy = if y0 < y1 { 1 } else { -1 };
        let mut err = dx - dy;
        let mut x = x0;
        let mut y = y0;

        loop {
            for dy in -(width as i32 / 2)..=(width as i32 / 2) {
                for dx in -(width as i32 / 2)..=(width as i32 / 2) {
                    let px = (x + dx) as u32;
                    let py = (y + dy) as u32;
                    if px < image.width() && py < image.height() {
                        image.put_pixel(px, py, color);
                    }
                }
            }

            if x == x1 && y == y1 {
                break;
            }

            let e2 = 2 * err;
            if e2 > -dy {
                err -= dy;
                x += sx;
            }
            if e2 < dx {
                err += dx;
                y += sy;
            }
        }
    }

    fn draw_rectangle(
        &self,
        image: &mut RgbaImage,
        x: u32,
        y: u32,
        width: u32,
        height: u32,
        color: Rgba<u8>,
        line_width: u32,
        filled: bool,
    ) {
        let x_end = (x + width).min(image.width());
        let y_end = (y + height).min(image.height());

        if filled {
            for py in y..y_end {
                for px in x..x_end {
                    image.put_pixel(px, py, color);
                }
            }
        } else {
            for py in y..y.saturating_add(line_width).min(y_end) {
                for px in x..x_end {
                    image.put_pixel(px, py, color);
                }
            }
            for py in y_end.saturating_sub(line_width)..y_end {
                for px in x..x_end {
                    image.put_pixel(px, py, color);
                }
            }
            for py in y..y_end {
                for px in x..x.saturating_add(line_width).min(x_end) {
                    image.put_pixel(px, py, color);
                }
            }
            for py in y..y_end {
                for px in x_end.saturating_sub(line_width)..x_end {
                    image.put_pixel(px, py, color);
                }
            }
        }
    }

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
                encoder.write_image(
                    image.as_raw(),
                    width,
                    height,
                    image::ColorType::Rgba8,
                ).map_err(|e| PdfError::render_error(0, "PNG编码", e.to_string()))?;
            }
            ImageFormat::Jpeg => {
                let rgb_image = self.convert_rgba_to_rgb(image);
                let quality = self.calculate_jpeg_quality(width, height);
                let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buffer, quality);
                encoder.encode(
                    rgb_image.as_raw(),
                    width,
                    height,
                    image::ColorType::Rgb8,
                ).map_err(|e| PdfError::render_error(0, "JPEG编码", e.to_string()))?;
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

    fn convert_rgba_to_rgb(&self, rgba_image: &RgbaImage) -> image::RgbImage {
        let (width, height) = rgba_image.dimensions();
        let mut rgb_image = image::RgbImage::new(width, height);
        
        for y in 0..height {
            for x in 0..width {
                let pixel = rgba_image.get_pixel(x, y);
                let alpha = pixel[3] as f32 / 255.0;
                
                let r = ((pixel[0] as f32 * alpha) + (255.0 * (1.0 - alpha))) as u8;
                let g = ((pixel[1] as f32 * alpha) + (255.0 * (1.0 - alpha))) as u8;
                let b = ((pixel[2] as f32 * alpha) + (255.0 * (1.0 - alpha))) as u8;
                
                rgb_image.put_pixel(x, y, image::Rgb([r, g, b]));
            }
        }
        
        rgb_image
    }

    fn calculate_jpeg_quality(&self, width: u32, height: u32) -> u8 {
        let pixels = width * height;
        if pixels > 2_000_000 { 75 } else if pixels > 1_000_000 { 85 } else { 90 }
    }

    fn calculate_webp_quality(&self, width: u32, height: u32) -> f32 {
        let pixels = width * height;
        if pixels > 2_000_000 { 80.0 } else if pixels > 1_000_000 { 85.0 } else if pixels > 500_000 { 90.0 } else { 95.0 }
    }

    pub async fn clear_cache(&self) {
        self.cache.clear().await;
    }

    pub async fn clear_page_cache(&self, page_number: u32) {
        self.cache.clear_page(page_number).await;
    }

    pub async fn render_page_progressive<F>(
        &self,
        document: &PdfFile,
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

    pub async fn render_pages_batch(
        &self,
        document: &PdfFile,
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
}

impl Clone for PdfRenderer {
    fn clone(&self) -> Self {
        Self {
            cache: self.cache.clone(),
            performance_monitor: self.performance_monitor.clone(),
        }
    }
}

#[derive(Debug, Clone)]
struct GraphicsState {
    current_path: Path,
    fill_color: Rgba<u8>,
    stroke_color: Rgba<u8>,
    line_width: f32,
    saved_states: Vec<SavedState>,
}

impl Default for GraphicsState {
    fn default() -> Self {
        Self {
            current_path: Path::new(),
            fill_color: Rgba([0, 0, 0, 255]),
            stroke_color: Rgba([0, 0, 0, 255]),
            line_width: 1.0,
            saved_states: Vec::new(),
        }
    }
}

impl GraphicsState {
    fn save(&mut self) {
        self.saved_states.push(SavedState {
            fill_color: self.fill_color,
            stroke_color: self.stroke_color,
            line_width: self.line_width,
        });
    }

    fn restore(&mut self) {
        if let Some(saved) = self.saved_states.pop() {
            self.fill_color = saved.fill_color;
            self.stroke_color = saved.stroke_color;
            self.line_width = saved.line_width;
        }
    }
}

#[derive(Debug, Clone)]
struct SavedState {
    fill_color: Rgba<u8>,
    stroke_color: Rgba<u8>,
    line_width: f32,
}

#[derive(Debug, Clone)]
struct Path {
    segments: Vec<PathSegment>,
    current_point: Option<(f32, f32)>,
}

impl Path {
    fn new() -> Self {
        Self {
            segments: Vec::new(),
            current_point: None,
        }
    }

    fn move_to(&mut self, x: f32, y: f32) {
        self.current_point = Some((x, y));
    }

    fn line_to(&mut self, x: f32, y: f32) {
        if let Some(from) = self.current_point {
            self.segments.push(PathSegment::Line {
                from,
                to: (x, y),
            });
            self.current_point = Some((x, y));
        }
    }

    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x3: f32, y3: f32) {
        if let Some(from) = self.current_point {
            self.segments.push(PathSegment::Curve {
                from,
                control1: (x1, y1),
                control2: (x2, y2),
                to: (x3, y3),
            });
            self.current_point = Some((x3, y3));
        }
    }

    fn rectangle(&mut self, x: f32, y: f32, width: f32, height: f32) {
        self.segments.push(PathSegment::Rectangle {
            x,
            y,
            width,
            height,
        });
        self.current_point = Some((x, y));
    }

    fn close(&mut self) {
        if let Some(first_point) = self.segments.first().and_then(|s| s.start_point()) {
            if let Some(current) = self.current_point {
                if current != first_point {
                    self.segments.push(PathSegment::Line {
                        from: current,
                        to: first_point,
                    });
                }
            }
        }
    }
}

#[derive(Debug, Clone)]
enum PathSegment {
    Line { from: (f32, f32), to: (f32, f32) },
    Curve { from: (f32, f32), control1: (f32, f32), control2: (f32, f32), to: (f32, f32) },
    Rectangle { x: f32, y: f32, width: f32, height: f32 },
}

impl PathSegment {
    fn start_point(&self) -> Option<(f32, f32)> {
        match self {
            PathSegment::Line { from, .. } => Some(*from),
            PathSegment::Curve { from, .. } => Some(*from),
            PathSegment::Rectangle { x, y, .. } => Some((*x, *y)),
        }
    }
}
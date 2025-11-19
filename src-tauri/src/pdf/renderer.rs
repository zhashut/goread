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
            self.render_content_stream(document, page_id, &content, image, scale_x, scale_y)?;
        }

        Ok(())
    }

    fn render_content_stream(
        &self,
        document: &PdfFile,
        page_id: ObjectId,
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
                "sc" => {
                    let c = as_f32(op.operands.get(0)).unwrap_or(0.0);
                    let m = as_f32(op.operands.get(1)).unwrap_or(0.0);
                    let y = as_f32(op.operands.get(2)).unwrap_or(0.0);
                    let k = as_f32(op.operands.get(3)).unwrap_or(0.0);
                    graphics_state.fill_color = self.color_to_rgba_cmyk(c, m, y, k);
                }
                "SC" => {
                    let c = as_f32(op.operands.get(0)).unwrap_or(0.0);
                    let m = as_f32(op.operands.get(1)).unwrap_or(0.0);
                    let y = as_f32(op.operands.get(2)).unwrap_or(0.0);
                    let k = as_f32(op.operands.get(3)).unwrap_or(0.0);
                    graphics_state.stroke_color = self.color_to_rgba_cmyk(c, m, y, k);
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
                "cm" => {
                    let a = as_f32(op.operands.get(0)).unwrap_or(1.0);
                    let b = as_f32(op.operands.get(1)).unwrap_or(0.0);
                    let c = as_f32(op.operands.get(2)).unwrap_or(0.0);
                    let d = as_f32(op.operands.get(3)).unwrap_or(1.0);
                    let e = as_f32(op.operands.get(4)).unwrap_or(0.0);
                    let f = as_f32(op.operands.get(5)).unwrap_or(0.0);
                    graphics_state.ctm = multiply_ctm(graphics_state.ctm, [a, b, c, d, e, f]);
                }
                "h" => {
                    let _ = self.close_path(&mut graphics_state);
                }
                "n" => {
                    graphics_state.current_path.clear();
                }
                "v" => { // curveto with 1 control
                    let x2 = as_f32(op.operands.get(0));
                    let y2 = as_f32(op.operands.get(1));
                    let x3 = as_f32(op.operands.get(2));
                    let y3 = as_f32(op.operands.get(3));
                    if let (Some(x2), Some(y2), Some(x3), Some(y3)) = (x2, y2, x3, y3) {
                        if let Some((x1, y1)) = graphics_state.current_path.current_point {
                            graphics_state.current_path.curve_to(x1, y1, x2, y2, x3, y3);
                        }
                    }
                }
                "y" => { // curveto with 1 control
                    let x1 = as_f32(op.operands.get(0));
                    let y1 = as_f32(op.operands.get(1));
                    let x3 = as_f32(op.operands.get(2));
                    let y3 = as_f32(op.operands.get(3));
                    if let (Some(x1), Some(y1), Some(x3), Some(y3)) = (x1, y1, x3, y3) {
                        if let Some((from_x, from_y)) = graphics_state.current_path.current_point {
                            graphics_state.current_path.curve_to(x1, y1, x3, y3, x3, y3);
                            graphics_state.current_path.current_point = Some((x3, y3));
                        }
                    }
                }
                "Do" => {
                    if let Some(Object::Name(name)) = op.operands.get(0) {
                        self.handle_do(document, page_id, name, image, scale_x, scale_y, &graphics_state)?;
                    }
                }
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
                    let (x0, y0) = self.transform_point(state, from.0, from.1, scale_x, scale_y);
                    let (x1, y1) = self.transform_point(state, to.0, to.1, scale_x, scale_y);
                    self.draw_line(image, x0, y0, x1, y1, color, line_width);
                }
                PathSegment::Curve { from, control1, control2, to } => {
                    let mut last = (from.0, from.1);
                    let steps = 24;
                    for i in 1..=steps {
                        let t = i as f32 / steps as f32;
                        let p = cubic_bezier(last, *control1, *control2, *to, t);
                        let (x0, y0) = self.transform_point(state, last.0, last.1, scale_x, scale_y);
                        let (x1, y1) = self.transform_point(state, p.0, p.1, scale_x, scale_y);
                        self.draw_line(image, x0, y0, x1, y1, color, line_width);
                        last = p;
                    }
                }
                PathSegment::Rectangle { x, y, width, height } => {
                    let (rx, ry) = self.transform_point(state, *x, *y, scale_x, scale_y);
                    let w = ((state.ctm[0] * *width) * scale_x).abs() as u32;
                    let h = ((state.ctm[3] * *height) * scale_y).abs() as u32;
                    self.draw_rectangle(image, rx.max(0) as u32, ry.max(0) as u32, w.max(1), h.max(1), color, line_width, false);
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

        // Collect polygon points
        let mut points: Vec<(i32, i32)> = Vec::new();
        for segment in &state.current_path.segments {
            match segment {
                PathSegment::Line { from, to } => {
                    let (x0, y0) = self.transform_point(state, from.0, from.1, scale_x, scale_y);
                    let (x1, y1) = self.transform_point(state, to.0, to.1, scale_x, scale_y);
                    if points.is_empty() { points.push((x0, y0)); }
                    points.push((x1, y1));
                }
                PathSegment::Curve { from, control1, control2, to } => {
                    let steps = 24;
                    let mut last = (from.0, from.1);
                    for i in 1..=steps {
                        let t = i as f32 / steps as f32;
                        let p = cubic_bezier(last, *control1, *control2, *to, t);
                        let (x1, y1) = self.transform_point(state, p.0, p.1, scale_x, scale_y);
                        if points.is_empty() {
                            let (x0, y0) = self.transform_point(state, last.0, last.1, scale_x, scale_y);
                            points.push((x0, y0));
                        }
                        points.push((x1, y1));
                        last = p;
                    }
                }
                PathSegment::Rectangle { x, y, width, height } => {
                    let corners = [
                        (*x, *y),
                        (*x + *width, *y),
                        (*x + *width, *y + *height),
                        (*x, *y + *height),
                    ];
                    for (cx, cy) in corners.iter() {
                        let (tx, ty) = self.transform_point(state, *cx, *cy, scale_x, scale_y);
                        points.push((tx, ty));
                    }
                }
            }
        }
        if points.len() >= 3 { self.fill_polygon(image, &points, color); }

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

    fn handle_do(
        &self,
        document: &PdfFile,
        page_id: ObjectId,
        name: &[u8],
        canvas: &mut RgbaImage,
        scale_x: f32,
        scale_y: f32,
        state: &GraphicsState,
    ) -> Result<(), PdfError> {
        let page_obj = document.get_object(page_id).map_err(|e| PdfError::render_error(0, "页面对象", e.to_string()))?;
        let page_dict = page_obj.as_dict()?;
        let resources_obj = page_dict.get(b"Resources").ok();
        let resources_dict = match resources_obj {
            Some(Object::Dictionary(d)) => Some(d),
            Some(Object::Reference(id)) => match document.get_object(*id) { Ok(Object::Dictionary(d)) => Some(d), _ => None },
            _ => None,
        };
        if let Some(res) = resources_dict {
            if let Ok(xobj_obj) = res.get(b"XObject") {
                let xobj_dict = match xobj_obj {
                    Object::Dictionary(d) => Some(d),
                    Object::Reference(id) => match document.get_object(*id) { Ok(Object::Dictionary(d)) => Some(d), _ => None },
                    _ => None,
                };
                if let Some(xdict) = xobj_dict {
                    if let Ok(obj) = xdict.get(name) {
                        match obj {
                            Object::Reference(id) => {
                                if let Ok(Object::Stream(stream)) = document.get_object(*id) {
                                    return self.render_xobject_stream(document, page_id, &stream, canvas, scale_x, scale_y, state);
                                }
                            }
                            Object::Stream(stream) => {
                                return self.render_xobject_stream(document, page_id, stream, canvas, scale_x, scale_y, state);
                            }
                            _ => {}
                        }
                    }
                }
            }
        }
        Ok(())
    }

    fn render_xobject_stream(
        &self,
        document: &PdfFile,
        page_id: ObjectId,
        stream: &lopdf::Stream,
        canvas: &mut RgbaImage,
        scale_x: f32,
        scale_y: f32,
        state: &GraphicsState,
    ) -> Result<(), PdfError> {
        if let Ok(subtype) = stream.dict.get(b"Subtype") {
            if let Object::Name(name) = subtype {
                if name == b"Image" {
                    return self.render_image_xobject(stream, canvas, scale_x, scale_y, state);
                } else if name == b"Form" {
                    return self.render_form_xobject(document, page_id, stream, canvas, scale_x, scale_y, state);
                }
            }
        }
        Ok(())
    }

    fn render_image_xobject(
        &self,
        stream: &lopdf::Stream,
        canvas: &mut RgbaImage,
        scale_x: f32,
        scale_y: f32,
        state: &GraphicsState,
    ) -> Result<(), PdfError> {
        let target_w = (state.ctm[0].abs() * scale_x).max(1.0) as u32;
        let target_h = (state.ctm[3].abs() * scale_y).max(1.0) as u32;
        let pos_x = (state.ctm[4] * scale_x).round() as i32;
        let pos_y = (state.ctm[5] * scale_y).round() as i32;

        let filter_names = match stream.dict.get(b"Filter").ok() {
            Some(Object::Name(n)) => vec![n.clone()],
            Some(Object::Array(arr)) => arr.iter().filter_map(|o| if let Object::Name(n) = o { Some(n.clone()) } else { None }).collect(),
            _ => Vec::new(),
        };

        let mut image_rgba: Option<RgbaImage> = None;
        let mut alpha_mask: Option<RgbaImage> = None;

        if filter_names.iter().any(|n| n == b"DCTDecode") {
            let dyn_img = image::load_from_memory(&stream.content).map_err(|e| PdfError::render_error(0, "图像解码", e.to_string()))?;
            image_rgba = Some(dyn_img.to_rgba8());
        } else if filter_names.iter().any(|n| n == b"FlateDecode") {
            use flate2::read::ZlibDecoder;
            use std::io::Read;
            let mut d = ZlibDecoder::new(&stream.content[..]);
            let mut decoded = Vec::new();
            d.read_to_end(&mut decoded).map_err(|e| PdfError::render_error(0, "Flate解码", e.to_string()))?;
            let width = match stream.dict.get(b"Width").ok() { Some(Object::Integer(v)) => *v as u32, Some(Object::Real(v)) => *v as u32, _ => 0 };
            let height = match stream.dict.get(b"Height").ok() { Some(Object::Integer(v)) => *v as u32, Some(Object::Real(v)) => *v as u32, _ => 0 };
            let bpc = match stream.dict.get(b"BitsPerComponent").ok() { Some(Object::Integer(v)) => *v as u32, _ => 8 };
            let cs = stream.dict.get(b"ColorSpace").ok();
            if width > 0 && height > 0 && bpc == 8 {
                let mut rgba = RgbaImage::new(width, height);
                match cs {
                    Some(Object::Name(n)) if n == b"DeviceRGB" => {
                        for y in 0..height {
                            for x in 0..width {
                                let idx = ((y * width + x) * 3) as usize;
                                let r = decoded.get(idx).copied().unwrap_or(0);
                                let g = decoded.get(idx + 1).copied().unwrap_or(0);
                                let b = decoded.get(idx + 2).copied().unwrap_or(0);
                                rgba.put_pixel(x, y, Rgba([r, g, b, 255]));
                            }
                        }
                    }
                    Some(Object::Name(n)) if n == b"DeviceGray" => {
                        for y in 0..height {
                            for x in 0..width {
                                let idx = ((y * width + x) * 1) as usize;
                                let v = decoded.get(idx).copied().unwrap_or(0);
                                rgba.put_pixel(x, y, Rgba([v, v, v, 255]));
                            }
                        }
                    }
                    Some(Object::Name(n)) if n == b"DeviceCMYK" => {
                        for y in 0..height {
                            for x in 0..width {
                                let idx = ((y * width + x) * 4) as usize;
                                let c = decoded.get(idx).copied().unwrap_or(0) as f32 / 255.0;
                                let m = decoded.get(idx + 1).copied().unwrap_or(0) as f32 / 255.0;
                                let yv = decoded.get(idx + 2).copied().unwrap_or(0) as f32 / 255.0;
                                let k = decoded.get(idx + 3).copied().unwrap_or(0) as f32 / 255.0;
                                let px = self.color_to_rgba_cmyk(c, m, yv, k);
                                rgba.put_pixel(x, y, px);
                            }
                        }
                    }
                    _ => {}
                }
                image_rgba = Some(rgba);
            } else if width > 0 && height > 0 && bpc == 1 {
                let is_mask = match stream.dict.get(b"ImageMask").ok() { Some(Object::Boolean(b)) => *b, _ => false };
                if is_mask {
                    let mut alpha = RgbaImage::new(width, height);
                    let mut bit_idx = 0usize;
                    for y in 0..height {
                        for x in 0..width {
                            let byte = decoded.get(bit_idx / 8).copied().unwrap_or(0);
                            let bit = 7 - (bit_idx % 8);
                            let on = ((byte >> bit) & 1) != 0;
                            let a = if on { 255 } else { 0 };
                            alpha.put_pixel(x, y, Rgba([0, 0, 0, a]));
                            bit_idx += 1;
                        }
                    }
                    alpha_mask = Some(alpha);
                    let fill = state.fill_color;
                    let mut rgba = RgbaImage::new(width, height);
                    for y in 0..height { for x in 0..width { rgba.put_pixel(x, y, fill); } }
                    image_rgba = Some(rgba);
                }
            }
        } else if filter_names.iter().any(|n| n == b"JPXDecode") {
            let dyn_img = image::load_from_memory(&stream.content).map_err(|e| PdfError::render_error(0, "JPX解码", e.to_string()))?;
            image_rgba = Some(dyn_img.to_rgba8());
        } else {
            if let Ok(dyn_img) = image::load_from_memory(&stream.content) {
                image_rgba = Some(dyn_img.to_rgba8());
            }
        }

        if alpha_mask.is_none() {
            if let Some(smask_obj) = stream.dict.get(b"SMask").ok() {
                match smask_obj {
                    Object::Stream(s) => {
                        if let Ok(di) = image::load_from_memory(&s.content) { alpha_mask = Some(di.to_rgba8()); }
                    }
                    Object::Reference(id) => {
                        // try to load referenced smask stream as image
                        // if not decodable, ignore
                    }
                    _ => {}
                }
            }
        }

        if let Some(img) = image_rgba {
            let resized = image::imageops::resize(&img, target_w.max(1), target_h.max(1), image::imageops::Lanczos3);
            if let Some(alpha) = alpha_mask {
                let a_resized = image::imageops::resize(&alpha, target_w.max(1), target_h.max(1), image::imageops::Lanczos3);
                let mut merged = RgbaImage::new(resized.width(), resized.height());
                for y in 0..resized.height() {
                    for x in 0..resized.width() {
                        let mut px = *resized.get_pixel(x, y);
                        px[3] = a_resized.get_pixel(x, y)[3];
                        merged.put_pixel(x, y, px);
                    }
                }
                self.blit_image(canvas, &merged, pos_x, pos_y);
            } else {
                self.blit_image(canvas, &resized, pos_x, pos_y);
            }
        }

        Ok(())
    }

    fn render_form_xobject(
        &self,
        document: &PdfFile,
        page_id: ObjectId,
        stream: &lopdf::Stream,
        canvas: &mut RgbaImage,
        scale_x: f32,
        scale_y: f32,
        state: &GraphicsState,
    ) -> Result<(), PdfError> {
        if let Ok(data) = Content::decode(&stream.content) {
            let mut gs = state.clone();
            if let Ok(matrix_obj) = stream.dict.get(b"Matrix") {
                if let Object::Array(arr) = matrix_obj {
                    let a = as_f32(arr.get(0)).unwrap_or(1.0);
                    let b = as_f32(arr.get(1)).unwrap_or(0.0);
                    let c = as_f32(arr.get(2)).unwrap_or(0.0);
                    let d = as_f32(arr.get(3)).unwrap_or(1.0);
                    let e = as_f32(arr.get(4)).unwrap_or(0.0);
                    let f = as_f32(arr.get(5)).unwrap_or(0.0);
                    gs.ctm = [a, b, c, d, e, f];
                }
            }
            let _bbox = match stream.dict.get(b"BBox").ok() { Some(Object::Array(a)) => a.clone(), _ => Vec::new() };
            self.render_content_stream(document, page_id, &data, canvas, scale_x, scale_y)?;
        }
        Ok(())
    }

    fn blit_image(&self, canvas: &mut RgbaImage, src: &RgbaImage, x: i32, y: i32) {
        for j in 0..src.height() {
            for i in 0..src.width() {
                let tx = x + i as i32;
                let ty = y + j as i32;
                if tx >= 0 && ty >= 0 {
                    let ux = tx as u32;
                    let uy = ty as u32;
                    if ux < canvas.width() && uy < canvas.height() {
                        canvas.put_pixel(ux, uy, *src.get_pixel(i as u32, j as u32));
                    }
                }
            }
        }
    }

    fn fill_polygon(&self, image: &mut RgbaImage, points: &[(i32, i32)], color: Rgba<u8>) {
        if points.len() < 3 { return; }
        let (min_y, max_y) = points.iter().fold((i32::MAX, i32::MIN), |acc, &p| (acc.0.min(p.1), acc.1.max(p.1)));
        for y in min_y..=max_y {
            let mut xs: Vec<i32> = Vec::new();
            for i in 0..points.len() {
                let (x0, y0) = points[i];
                let (x1, y1) = points[(i + 1) % points.len()];
                if (y0 <= y && y1 > y) || (y1 <= y && y0 > y) {
                    let t = (y - y0) as f32 / (y1 - y0) as f32;
                    let x = (x0 as f32 + t * (x1 - x0) as f32).round() as i32;
                    xs.push(x);
                }
            }
            xs.sort_unstable();
            for pair in xs.chunks(2) {
                if pair.len() == 2 {
                    let x_start = pair[0].max(0) as u32;
                    let x_end = pair[1].min(image.width() as i32).max(pair[0]) as u32;
                    if y >= 0 && (y as u32) < image.height() {
                        for x in x_start..x_end { image.put_pixel(x, y as u32, color); }
                    }
                }
            }
        }
    }

    fn multiply_ctm(a: [f32; 6], b: [f32; 6]) -> [f32; 6] { multiply_ctm(a, b) }

    fn transform_point(&self, state: &GraphicsState, x: f32, y: f32, scale_x: f32, scale_y: f32) -> (i32, i32) {
        let nx = state.ctm[0] * x + state.ctm[2] * y + state.ctm[4];
        let ny = state.ctm[1] * x + state.ctm[3] * y + state.ctm[5];
        ((nx * scale_x).round() as i32, (ny * scale_y).round() as i32)
    }

}

fn multiply_ctm(ctm: [f32; 6], m: [f32; 6]) -> [f32; 6] {
    let a = ctm[0] * m[0] + ctm[2] * m[1];
    let b = ctm[1] * m[0] + ctm[3] * m[1];
    let c = ctm[0] * m[2] + ctm[2] * m[3];
    let d = ctm[1] * m[2] + ctm[3] * m[3];
    let e = ctm[0] * m[4] + ctm[2] * m[5] + ctm[4];
    let f = ctm[1] * m[4] + ctm[3] * m[5] + ctm[5];
    [a, b, c, d, e, f]
}

fn cubic_bezier(p0: (f32, f32), c1: (f32, f32), c2: (f32, f32), p3: (f32, f32), t: f32) -> (f32, f32) {
    let u = 1.0 - t;
    let tt = t * t;
    let uu = u * u;
    let uuu = uu * u;
    let ttt = tt * t;
    let x = uuu * p0.0 + 3.0 * uu * t * c1.0 + 3.0 * u * tt * c2.0 + ttt * p3.0;
    let y = uuu * p0.1 + 3.0 * uu * t * c1.1 + 3.0 * u * tt * c2.1 + ttt * p3.1;
    (x, y)
}

#[derive(Debug, Clone)]
struct GraphicsState {
    current_path: Path,
    fill_color: Rgba<u8>,
    stroke_color: Rgba<u8>,
    line_width: f32,
    saved_states: Vec<SavedState>,
    ctm: [f32; 6],
}

impl Default for GraphicsState {
    fn default() -> Self {
        Self {
            current_path: Path::new(),
            fill_color: Rgba([0, 0, 0, 255]),
            stroke_color: Rgba([0, 0, 0, 255]),
            line_width: 1.0,
            saved_states: Vec::new(),
            ctm: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
        }
    }
}

impl GraphicsState {
    fn save(&mut self) {
        self.saved_states.push(SavedState {
            fill_color: self.fill_color,
            stroke_color: self.stroke_color,
            line_width: self.line_width,
            ctm: self.ctm,
        });
    }

    fn restore(&mut self) {
        if let Some(saved) = self.saved_states.pop() {
            self.fill_color = saved.fill_color;
            self.stroke_color = saved.stroke_color;
            self.line_width = saved.line_width;
            self.ctm = saved.ctm;
        }
    }
}

#[derive(Debug, Clone)]
struct SavedState {
    fill_color: Rgba<u8>,
    stroke_color: Rgba<u8>,
    line_width: f32,
    ctm: [f32; 6],
}

#[derive(Debug, Clone)]
struct Path {
    segments: Vec<PathSegment>,
    current_point: Option<(f32, f32)>,
}

impl Path {
    fn new() -> Self {
        Self { segments: Vec::new(), current_point: None }
    }

    fn move_to(&mut self, x: f32, y: f32) { self.current_point = Some((x, y)); }

    fn line_to(&mut self, x: f32, y: f32) {
        if let Some(from) = self.current_point {
            self.segments.push(PathSegment::Line { from, to: (x, y) });
            self.current_point = Some((x, y));
        }
    }

    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x3: f32, y3: f32) {
        if let Some(from) = self.current_point {
            self.segments.push(PathSegment::Curve { from, control1: (x1, y1), control2: (x2, y2), to: (x3, y3) });
            self.current_point = Some((x3, y3));
        }
    }

    fn rectangle(&mut self, x: f32, y: f32, width: f32, height: f32) {
        self.segments.push(PathSegment::Rectangle { x, y, width, height });
        self.current_point = Some((x, y));
    }

    fn close(&mut self) {
        if let Some(first_point) = self.segments.first().and_then(|s| s.start_point()) {
            if let Some(current) = self.current_point {
                if current != first_point {
                    self.segments.push(PathSegment::Line { from: current, to: first_point });
                }
            }
        }
    }

    fn clear(&mut self) { self.segments.clear(); self.current_point = None; }
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

impl Clone for PdfRenderer {
    fn clone(&self) -> Self {
        Self { cache: self.cache.clone(), performance_monitor: self.performance_monitor.clone() }
    }
}

impl PdfRenderer {
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

    fn calculate_jpeg_quality(&self, width: u32, height: u32) -> u8 {
        let pixels = width * height;
        if pixels > 2_000_000 { 75 } else if pixels > 1_000_000 { 85 } else { 90 }
    }

    fn calculate_webp_quality(&self, width: u32, height: u32) -> f32 {
        let pixels = width * height;
        if pixels > 2_000_000 { 80.0 } else if pixels > 1_000_000 { 85.0 } else if pixels > 500_000 { 90.0 } else { 95.0 }
    }

    pub async fn clear_cache(&self) { self.cache.clear().await; }
    pub async fn clear_page_cache(&self, page_number: u32) { self.cache.clear_page(page_number).await; }

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
        let stages = vec![RenderQuality::Thumbnail, RenderQuality::Standard, base_options.quality.clone()];
        for quality in stages {
            let options = RenderOptions { quality: quality.clone(), ..base_options.clone() };
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
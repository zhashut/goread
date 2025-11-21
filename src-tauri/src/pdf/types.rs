use image::Rgba;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PdfPageInfo {
    pub width: f32,
    pub height: f32,
    pub number: u32,
    pub rotation: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PdfDocumentInfo {
    pub page_count: u32,
    pub pages: Vec<PdfPageInfo>,
    pub title: Option<String>,
    pub author: Option<String>,
    pub subject: Option<String>,
    pub keywords: Option<String>,
    pub creator: Option<String>,
    pub producer: Option<String>,
    pub creation_date: Option<String>,
    pub modification_date: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum RenderQuality {
    Thumbnail, // 缩略图，快速预览 (0.5x)
    Standard,  // 标准质量，正常阅读 (1.0x)
    High,      // 高质量，缩放查看 (1.5x)
    Best,      // 最佳质量，打印预览 (2.0x)
}

impl RenderQuality {
    pub fn scale_factor(&self) -> f32 {
        match self {
            RenderQuality::Thumbnail => 0.5,
            RenderQuality::Standard => 1.0,
            RenderQuality::High => 1.5,
            RenderQuality::Best => 2.0,
        }
    }

    pub fn from_scale(scale: f32) -> Self {
        if scale <= 0.75 {
            RenderQuality::Thumbnail
        } else if scale <= 1.25 {
            RenderQuality::Standard
        } else if scale <= 1.75 {
            RenderQuality::High
        } else {
            RenderQuality::Best
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenderOptions {
    pub quality: RenderQuality,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub background_color: Option<[u8; 4]>,
    pub fit_to_width: bool,
    pub fit_to_height: bool,
}

impl Default for RenderOptions {
    fn default() -> Self {
        Self {
            quality: RenderQuality::Standard,
            width: None,
            height: None,
            background_color: Some([255, 255, 255, 255]),
            fit_to_width: false,
            fit_to_height: false,
        }
    }
}

impl RenderOptions {
    pub fn background_rgba(&self) -> Rgba<u8> {
        let color = self.background_color.unwrap_or([255, 255, 255, 255]);
        Rgba(color)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenderRegion {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TileKey {
    pub page_number: u32,
    pub quality: RenderQuality,
    pub tile_x: u32,
    pub tile_y: u32,
    pub tile_width: u32,
    pub tile_height: u32,
}

impl TileKey {
    pub fn new(page_number: u32, quality: RenderQuality, tile_x: u32, tile_y: u32, tile_width: u32, tile_height: u32) -> Self {
        Self { page_number, quality, tile_x, tile_y, tile_width, tile_height }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextPosition {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextBlock {
    pub text: String,
    pub position: TextPosition,
    pub font_size: f32,
    pub font_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PageText {
    pub page_number: u32,
    pub blocks: Vec<TextBlock>,
    pub full_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    pub page_number: u32,
    pub text: String,
    pub position: TextPosition,
    pub context: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bookmark {
    pub title: String,
    pub page_number: u32,
    pub level: u32,
    pub children: Vec<Bookmark>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PdfOutline {
    pub bookmarks: Vec<Bookmark>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CacheKey {
    pub page_number: u32,
    pub quality: RenderQuality,
    pub width: u32,
    pub height: u32,
}

impl CacheKey {
    pub fn new(page_number: u32, quality: RenderQuality, width: u32, height: u32) -> Self {
        Self {
            page_number,
            quality,
            width,
            height,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenderResult {
    pub image_data: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub format: ImageFormat,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ImageFormat {
    Png,
    Jpeg,
    WebP,
}

impl ImageFormat {
    pub fn mime_type(&self) -> &str {
        match self {
            ImageFormat::Png => "image/png",
            ImageFormat::Jpeg => "image/jpeg",
            ImageFormat::WebP => "image/webp",
        }
    }

    pub fn extension(&self) -> &str {
        match self {
            ImageFormat::Png => "png",
            ImageFormat::Jpeg => "jpg",
            ImageFormat::WebP => "webp",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreloadStrategy {
    pub ahead_count: u32,
    pub behind_count: u32,
    pub quality: RenderQuality,
}

impl Default for PreloadStrategy {
    fn default() -> Self {
        Self {
            ahead_count: 2,
            behind_count: 1,
            quality: RenderQuality::Standard,
        }
    }
}

#[derive(Debug, Clone)]
pub enum PdfError {
    FileNotFound {
        path: String,
        source: String,
    },
    ParseError {
        page: Option<u32>,
        message: String,
        source: String,
    },
    RenderError {
        page: u32,
        operation: String,
        message: String,
    },
    PageNotFound {
        page: u32,
        total_pages: u32,
    },
    InvalidParameter {
        param: String,
        value: String,
        expected: String,
    },
    CacheError {
        operation: String,
        message: String,
    },
    IoError {
        path: Option<String>,
        source: String,
    },
    MemoryLimitExceeded {
        requested: usize,
        available: usize,
    },
    UnsupportedFeature {
        feature: String,
        page: Option<u32>,
    },
}

impl std::fmt::Display for PdfError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PdfError::FileNotFound { path, source } => {
                write!(f, "文件未找到: {} (原因: {})", path, source)
            }
            PdfError::ParseError {
                page,
                message,
                source,
            } => write!(
                f,
                "PDF解析错误{}: {} (详情: {})",
                page.map(|p| format!(" (页面{})", p)).unwrap_or_default(),
                message,
                source
            ),
            PdfError::RenderError {
                page,
                operation,
                message,
            } => write!(
                f,
                "渲染错误 (页面{}, 操作: {}): {}",
                page, operation, message
            ),
            PdfError::PageNotFound { page, total_pages } => {
                write!(f, "页面{}不存在 (总页数: {})", page, total_pages)
            }
            PdfError::InvalidParameter {
                param,
                value,
                expected,
            } => write!(
                f,
                "无效参数 {}: 值为 '{}', 期望 '{}'",
                param, value, expected
            ),
            PdfError::CacheError { operation, message } => {
                write!(f, "缓存错误 (操作: {}): {}", operation, message)
            }
            PdfError::IoError { path, source } => write!(
                f,
                "IO错误{}: {}",
                path.as_ref()
                    .map(|p| format!(" (文件: {})", p))
                    .unwrap_or_default(),
                source
            ),
            PdfError::MemoryLimitExceeded {
                requested,
                available,
            } => write!(
                f,
                "内存限制超出: 请求 {} bytes, 可用 {} bytes",
                requested, available
            ),
            PdfError::UnsupportedFeature { feature, page } => write!(
                f,
                "不支持的功能: {}{}",
                feature,
                page.map(|p| format!(" (页面{})", p)).unwrap_or_default()
            ),
        }
    }
}

impl std::error::Error for PdfError {}

impl From<std::io::Error> for PdfError {
    fn from(err: std::io::Error) -> Self {
        PdfError::IoError {
            path: None,
            source: err.to_string(),
        }
    }
}

impl From<pdfium_render::prelude::PdfiumError> for PdfError {
    fn from(err: pdfium_render::prelude::PdfiumError) -> Self {
        PdfError::ParseError {
            page: None,
            message: "PDF解析失败".to_string(),
            source: err.to_string(),
        }
    }
}

impl From<image::ImageError> for PdfError {
    fn from(err: image::ImageError) -> Self {
        PdfError::RenderError {
            page: 0,
            operation: "图像编码".to_string(),
            message: err.to_string(),
        }
    }
}

// 辅助函数：创建详细的错误
impl PdfError {
    pub fn file_not_found(path: impl Into<String>, err: std::io::Error) -> Self {
        Self::FileNotFound {
            path: path.into(),
            source: err.to_string(),
        }
    }

    pub fn parse_error(
        page: Option<u32>,
        message: impl Into<String>,
        source: impl Into<String>,
    ) -> Self {
        Self::ParseError {
            page,
            message: message.into(),
            source: source.into(),
        }
    }

    pub fn render_error(
        page: u32,
        operation: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self::RenderError {
            page,
            operation: operation.into(),
            message: message.into(),
        }
    }

    pub fn page_not_found(page: u32, total_pages: u32) -> Self {
        Self::PageNotFound { page, total_pages }
    }

    pub fn invalid_param(
        param: impl Into<String>,
        value: impl Into<String>,
        expected: impl Into<String>,
    ) -> Self {
        Self::InvalidParameter {
            param: param.into(),
            value: value.into(),
            expected: expected.into(),
        }
    }

    pub fn cache_error(operation: impl Into<String>, message: impl Into<String>) -> Self {
        Self::CacheError {
            operation: operation.into(),
            message: message.into(),
        }
    }

    pub fn io_error(path: Option<String>, err: std::io::Error) -> Self {
        Self::IoError {
            path,
            source: err.to_string(),
        }
    }

    pub fn memory_limit_exceeded(requested: usize, available: usize) -> Self {
        Self::MemoryLimitExceeded {
            requested,
            available,
        }
    }

    pub fn unsupported_feature(feature: impl Into<String>, page: Option<u32>) -> Self {
        Self::UnsupportedFeature {
            feature: feature.into(),
            page,
        }
    }
}
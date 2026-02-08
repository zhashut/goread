use serde::{Deserialize, Serialize};
use std::future::Future;
use std::pin::Pin;

pub mod common;
pub mod epub;
pub mod html;
pub mod markdown;
pub mod txt;
pub mod mobi;

/// 通用异步返回类型，统一封装书籍渲染相关的异步接口
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// 书籍渲染结果缓存通用接口，不关心具体书籍格式
pub trait BookRenderCache {
    /// 缓存键类型，一般包含文件路径、页码及渲染参数
    type Key: Send + Sync + 'static;
    /// 缓存值类型，如页面渲染结果
    type Value: Send + Sync + 'static;
    /// 缓存统计信息类型
    type Stats: Send + Sync + 'static;
    /// 缓存相关错误类型
    type Error: std::error::Error + Send + Sync + 'static;

    /// 按键读取缓存，不存在时返回 None
    fn cache_get<'a>(&'a self, key: &'a Self::Key) -> BoxFuture<'a, Option<Self::Value>>;
    /// 写入缓存，保持与具体实现的行为一致
    fn cache_put<'a>(
        &'a self,
        key: Self::Key,
        value: Self::Value,
    ) -> BoxFuture<'a, Result<(), Self::Error>>;
    /// 删除指定键的缓存，并返回旧值
    fn cache_remove<'a>(&'a self, key: &'a Self::Key) -> BoxFuture<'a, Option<Self::Value>>;
    /// 清空所有缓存数据
    fn cache_clear_all<'a>(&'a self) -> BoxFuture<'a, ()>;
    /// 清除指定文件某一页的缓存
    fn cache_clear_page<'a>(&'a self, file_path: &'a str, page_number: u32) -> BoxFuture<'a, ()>;
    /// 获取当前缓存统计信息
    fn cache_stats<'a>(&'a self) -> BoxFuture<'a, Self::Stats>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BookFormat {
    Pdf,
    Epub,
    Markdown,
    Mobi,
    Azw3,
    Fb2,
    Html,
    Txt,
}

impl BookFormat {
    /// 获取格式对应的文件扩展名
    pub fn extensions(&self) -> &'static [&'static str] {
        match self {
            BookFormat::Pdf => &[".pdf"],
            BookFormat::Epub => &[".epub"],
            BookFormat::Markdown => &[".md", ".markdown"],
            BookFormat::Mobi => &[".mobi"],
            BookFormat::Azw3 => &[".azw3", ".azw"],
            BookFormat::Fb2 => &[".fb2"],
            BookFormat::Html => &[".html", ".htm"],
            BookFormat::Txt => &[".txt"],
        }
    }

    /// 根据扩展名识别格式
    pub fn from_extension(ext: &str) -> Option<Self> {
        let ext_lower = ext.to_lowercase();
        let ext_with_dot = if ext_lower.starts_with('.') {
            ext_lower
        } else {
            format!(".{}", ext_lower)
        };

        match ext_with_dot.as_str() {
            ".pdf" => Some(BookFormat::Pdf),
            ".epub" => Some(BookFormat::Epub),
            ".md" | ".markdown" => Some(BookFormat::Markdown),
            ".mobi" => Some(BookFormat::Mobi),
            ".azw3" | ".azw" => Some(BookFormat::Azw3),
            ".fb2" => Some(BookFormat::Fb2),
            ".html" | ".htm" => Some(BookFormat::Html),
            ".txt" => Some(BookFormat::Txt),
            _ => None,
        }
    }

    /// 根据文件路径识别格式
    pub fn from_path(path: &str) -> Option<Self> {
        let path_lower = path.to_lowercase();
        if let Some(dot_pos) = path_lower.rfind('.') {
            Self::from_extension(&path_lower[dot_pos..])
        } else {
            None
        }
    }
}

/// 书籍元数据
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BookMetadata {
    pub title: Option<String>,
    pub author: Option<String>,
    pub publisher: Option<String>,
    pub language: Option<String>,
    pub description: Option<String>,
    pub cover_image: Option<Vec<u8>>,
    pub page_count: u32,
    pub format: Option<BookFormat>,
}

/// 目录项
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TocItem {
    pub title: String,
    /// PDF/TXT 为页码，EPUB 为 href/cfi
    pub location: TocLocation,
    pub level: u32,
    #[serde(default)]
    pub children: Vec<TocItem>,
}

/// 目录位置类型
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum TocLocation {
    Page(u32),
    Href(String),
}

/// 渲染质量等级
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RenderQuality {
    Thumbnail,
    Standard,
    High,
    Best,
}

impl RenderQuality {
    /// 获取缩放因子
    pub fn scale_factor(&self) -> f32 {
        match self {
            RenderQuality::Thumbnail => 0.5,
            RenderQuality::Standard => 1.0,
            RenderQuality::High => 1.5,
            RenderQuality::Best => 2.0,
        }
    }
}

impl Default for RenderQuality {
    fn default() -> Self {
        RenderQuality::Standard
    }
}

/// 渲染配置
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RenderOptions {
    #[serde(default)]
    pub quality: RenderQuality,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub background_color: Option<[u8; 4]>,
}

/// 图片格式
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImageFormat {
    Png,
    Jpeg,
    WebP,
}

impl ImageFormat {
    /// 获取文件扩展名
    pub fn extension(&self) -> &'static str {
        match self {
            ImageFormat::Png => "png",
            ImageFormat::Jpeg => "jpg",
            ImageFormat::WebP => "webp",
        }
    }

    /// 获取 MIME 类型
    pub fn mime_type(&self) -> &'static str {
        match self {
            ImageFormat::Png => "image/png",
            ImageFormat::Jpeg => "image/jpeg",
            ImageFormat::WebP => "image/webp",
        }
    }
}

/// 页面内容类型
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum PageContent {
    /// 图片数据，用于 PDF
    Image {
        data: Vec<u8>,
        width: u32,
        height: u32,
        format: ImageFormat,
    },
    /// HTML 内容，用于 EPUB/MOBI/FB2
    Html {
        content: String,
        #[serde(default)]
        resources: std::collections::HashMap<String, Vec<u8>>,
    },
    /// 纯文本，用于 TXT
    Text {
        content: String,
        encoding: String,
    },
}

/// 搜索结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    pub page: u32,
    pub text: String,
    pub context: String,
    pub position: Option<TextPosition>,
}

/// 文本位置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextPosition {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

/// 书籍操作错误
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BookError {
    pub code: BookErrorCode,
    pub message: String,
    pub details: Option<String>,
}

/// 错误码
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BookErrorCode {
    FileNotFound,
    InvalidFormat,
    InvalidParameter,
    ParseError,
    RenderError,
    PageNotFound,
    EncodingError,
    IoError,
    UnsupportedFeature,
    Unknown,
}

impl std::fmt::Display for BookError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{:?}] {}", self.code, self.message)?;
        if let Some(details) = &self.details {
            write!(f, " ({})", details)?;
        }
        Ok(())
    }
}

impl std::error::Error for BookError {}

/// 当前支持扫描的格式（已实现前端渲染的格式）
pub const SCAN_SUPPORTED_FORMATS: &[BookFormat] = &[
    BookFormat::Pdf,
    BookFormat::Epub,
    BookFormat::Markdown,
    BookFormat::Html,
    BookFormat::Txt,
    BookFormat::Mobi
];

impl BookError {
    pub fn new(code: BookErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            details: None,
        }
    }

    pub fn with_details(mut self, details: impl Into<String>) -> Self {
        self.details = Some(details.into());
        self
    }

    pub fn file_not_found(path: &str) -> Self {
        Self::new(BookErrorCode::FileNotFound, format!("文件不存在: {}", path))
    }

    pub fn invalid_format(ext: &str) -> Self {
        Self::new(BookErrorCode::InvalidFormat, format!("不支持的格式: {}", ext))
    }

    pub fn parse_error(message: impl Into<String>) -> Self {
        Self::new(BookErrorCode::ParseError, message)
    }

    pub fn page_not_found(page: u32, total: u32) -> Self {
        Self::new(
            BookErrorCode::PageNotFound,
            format!("页码 {} 不存在 (共 {} 页)", page, total),
        )
    }

    pub fn encoding_error(encoding: &str) -> Self {
        Self::new(BookErrorCode::EncodingError, format!("编码错误: {}", encoding))
    }
}

impl From<std::io::Error> for BookError {
    fn from(err: std::io::Error) -> Self {
        BookError::new(BookErrorCode::IoError, err.to_string())
    }
}

/// 书籍格式引擎 trait
/// 部分格式可能完全由前端处理，此 trait 为可选实现
pub trait BookEngine: Send + Sync {
    /// 获取元数据
    fn get_metadata(&self) -> Result<BookMetadata, BookError>;

    /// 获取目录
    fn get_toc(&self) -> Result<Vec<TocItem>, BookError>;

    /// 获取总页数
    fn get_page_count(&self) -> u32;

    /// 渲染指定页
    fn render_page(&self, page: u32, options: &RenderOptions) -> Result<PageContent, BookError>;

    /// 搜索文本
    fn search_text(&self, query: &str, case_sensitive: bool) -> Result<Vec<SearchResult>, BookError>;

    /// 提取指定页文本
    fn extract_text(&self, page: u32) -> Result<String, BookError>;

    /// 关闭并释放资源
    fn close(&mut self);
}

/// 获取所有支持的扩展名（仅返回当前扫描支持的格式）
pub fn get_all_supported_extensions() -> Vec<&'static str> {
    vec![".pdf", ".epub", ".md", ".markdown", ".html", ".htm", ".txt", ".mobi"]
}

/// 检查文件扩展名是否在扫描支持列表中
pub fn is_scan_supported_extension(ext: &str) -> bool {
    let ext_lower = ext.to_lowercase();
    let ext_with_dot = if ext_lower.starts_with('.') {
        ext_lower
    } else {
        format!(".{}", ext_lower)
    };
    matches!(
        ext_with_dot.as_str(),
        ".pdf" | ".epub" | ".md" | ".markdown" | ".html" | ".htm" | ".txt" | ".mobi"
    )
}

/// 检查格式是否在扫描支持列表中
pub fn is_scan_supported_format(format: &BookFormat) -> bool {
    SCAN_SUPPORTED_FORMATS.contains(format)
}

/// 检查扩展名是否支持
pub fn is_extension_supported(ext: &str) -> bool {
    BookFormat::from_extension(ext).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_detection() {
        assert_eq!(BookFormat::from_extension(".pdf"), Some(BookFormat::Pdf));
        assert_eq!(BookFormat::from_extension("pdf"), Some(BookFormat::Pdf));
        assert_eq!(BookFormat::from_extension(".epub"), Some(BookFormat::Epub));
        assert_eq!(BookFormat::from_extension(".unknown"), None);
    }

    #[test]
    fn test_format_from_path() {
        assert_eq!(BookFormat::from_path("/path/to/book.pdf"), Some(BookFormat::Pdf));
        assert_eq!(BookFormat::from_path("C:\\Books\\novel.epub"), Some(BookFormat::Epub));
        assert_eq!(BookFormat::from_path("README"), None);
    }
}

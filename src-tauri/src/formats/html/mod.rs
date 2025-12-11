//! HTML 格式引擎
//! 负责文件读取和编码检测，渲染由前端处理

use std::fs;
use std::path::Path;
use chardetng::EncodingDetector;
use encoding_rs::Encoding;
use crate::formats::{BookError, BookErrorCode};

/// HTML 引擎
pub struct HtmlEngine {
    /// 文件内容
    content: String,
    /// 检测到的编码
    encoding: String,
    /// 文件路径
    file_path: String,
}

impl HtmlEngine {
    /// 从文件创建 HTML 引擎实例
    pub fn from_file(path: &str) -> Result<Self, BookError> {
        let bytes = fs::read(path).map_err(BookError::from)?;
        
        // 编码检测
        let mut detector = EncodingDetector::new();
        detector.feed(&bytes, true);
        let encoding = detector.guess(None, true);
        let (decoded, _, _) = encoding.decode(&bytes);
        
        Ok(Self {
            content: decoded.into_owned(),
            encoding: encoding.name().to_string(),
            file_path: path.to_string(),
        })
    }
    
    /// 获取 HTML 内容
    pub fn get_content(&self) -> &str {
        &self.content
    }

    /// 获取检测到的编码
    pub fn get_encoding(&self) -> &str {
        &self.encoding
    }
    
    /// 获取文件名作为标题
    pub fn get_file_name_title(&self) -> Option<String> {
        Path::new(&self.file_path)
            .file_stem()
            .and_then(|s| s.to_str())
            .map(|s| s.to_string())
    }
    
    /// 从内容中提取标题（解析 <title> 标签）
    pub fn extract_title_from_content(&self) -> Option<String> {
        // 简单的正则匹配 <title>...</title>
        // 注意：这只是一个简单的实现，对于复杂的 HTML 可能不准确，但在大多数情况下足够
        let re = regex::Regex::new(r"(?i)<title>(.*?)</title>").ok()?;
        if let Some(captures) = re.captures(&self.content) {
            if let Some(title) = captures.get(1) {
                return Some(title.as_str().trim().to_string());
            }
        }
        None
    }

    /// 获取标题（优先从内容提取，否则使用文件名）
    pub fn get_title(&self) -> Option<String> {
        self.extract_title_from_content().or_else(|| self.get_file_name_title())
    }
}

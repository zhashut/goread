//! Markdown 格式引擎
//! 负责文件读取和编码检测，渲染由前端处理

use chardetng::EncodingDetector;
use std::fs;
use std::path::Path;

use super::{BookError, BookErrorCode, BookMetadata, BookFormat, TocItem, TocLocation};

/// Markdown 引擎
pub struct MarkdownEngine {
    /// 文件内容
    content: String,
    /// 检测到的编码
    encoding: String,
    /// 文件路径
    file_path: String,
}

impl MarkdownEngine {
    /// 从文件加载 Markdown
    pub fn from_file(path: &str) -> Result<Self, BookError> {
        // 检查文件是否存在
        if !Path::new(path).exists() {
            return Err(BookError::file_not_found(path));
        }

        // 读取原始字节
        let bytes = fs::read(path).map_err(|e| {
            BookError::new(BookErrorCode::IoError, format!("Failed to read file: {}", e))
        })?;

        // 检测编码
        let mut detector = EncodingDetector::new();
        detector.feed(&bytes, true);
        let encoding = detector.guess(None, true);
        let (decoded, _, had_errors) = encoding.decode(&bytes);

        if had_errors {
            // 记录警告，继续执行
            eprintln!(
                "[MarkdownEngine] Encoding detection had errors, using {} anyway",
                encoding.name()
            );
        }

        Ok(Self {
            content: decoded.into_owned(),
            encoding: encoding.name().to_string(),
            file_path: path.to_string(),
        })
    }

    /// 获取 Markdown 内容
    pub fn get_content(&self) -> &str {
        &self.content
    }

    /// 获取检测到的编码
    pub fn get_encoding(&self) -> &str {
        &self.encoding
    }

    /// 获取文件路径
    pub fn get_file_path(&self) -> &str {
        &self.file_path
    }

    /// 从文件名解析标题
    pub fn get_title_from_filename(&self) -> Option<String> {
        Path::new(&self.file_path)
            .file_stem()
            .and_then(|s| s.to_str())
            .map(|s| s.to_string())
    }

    /// 提取内容中的第一个 H1 作为标题
    pub fn extract_title_from_content(&self) -> Option<String> {
        for line in self.content.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with("# ") && !trimmed.starts_with("## ") {
                return Some(trimmed[2..].trim().to_string());
            }
        }
        None
    }

    /// 获取最佳标题（优先使用内容标题，其次是文件名）
    pub fn get_title(&self) -> Option<String> {
        self.extract_title_from_content()
            .or_else(|| self.get_title_from_filename())
    }

    /// 获取元数据
    pub fn get_metadata(&self) -> BookMetadata {
        BookMetadata {
            title: self.get_title(),
            author: None,
            publisher: None,
            language: None,
            description: None,
            cover_image: None,
            page_count: 1, // Markdown 视为单页滚动
            format: Some(BookFormat::Markdown),
        }
    }

    /// 基于标题生成目录
    pub fn get_toc(&self) -> Vec<TocItem> {
        let mut toc = Vec::new();
        let mut index = 0;

        for line in self.content.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with('#') {
                // 计算标题层级
                let level = trimmed.chars().take_while(|&c| c == '#').count() as u32;
                if level >= 1 && level <= 6 {
                    // 提取标题文本（去除 # 符号和空格）
                    let title_start = level as usize;
                    if trimmed.len() > title_start && trimmed.chars().nth(title_start) == Some(' ') {
                        let title = trimmed[title_start + 1..].trim().to_string();
                        if !title.is_empty() {
                            toc.push(TocItem {
                                title,
                                location: TocLocation::Href(format!("heading-{}", index)),
                                level: level - 1, // 层级从 0 开始
                                children: vec![],
                            });
                            index += 1;
                        }
                    }
                }
            }
        }

        toc
    }

    /// 全文搜索
    pub fn search_text(&self, query: &str, case_sensitive: bool) -> Vec<MarkdownSearchResult> {
        let mut results = Vec::new();
        let query_to_search = if case_sensitive {
            query.to_string()
        } else {
            query.to_lowercase()
        };

        for (line_num, line) in self.content.lines().enumerate() {
            let line_to_search = if case_sensitive {
                line.to_string()
            } else {
                line.to_lowercase()
            };

            if line_to_search.contains(&query_to_search) {
                results.push(MarkdownSearchResult {
                    line_number: line_num + 1,
                    text: line.trim().to_string(),
                    context: line.to_string(),
                });
            }
        }

        results
    }
}

/// Markdown 搜索结果
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MarkdownSearchResult {
    pub line_number: usize,
    pub text: String,
    pub context: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_title() {
        let engine = MarkdownEngine {
            content: "# Hello World\n\nSome content".to_string(),
            encoding: "UTF-8".to_string(),
            file_path: "/test/file.md".to_string(),
        };
        assert_eq!(engine.extract_title_from_content(), Some("Hello World".to_string()));
    }

    #[test]
    fn test_get_toc() {
        let engine = MarkdownEngine {
            content: "# Title\n## Section 1\n### Subsection\n## Section 2".to_string(),
            encoding: "UTF-8".to_string(),
            file_path: "/test/file.md".to_string(),
        };
        let toc = engine.get_toc();
        assert_eq!(toc.len(), 4);
        assert_eq!(toc[0].title, "Title");
        assert_eq!(toc[0].level, 0);
        assert_eq!(toc[1].title, "Section 1");
        assert_eq!(toc[1].level, 1);
    }
}
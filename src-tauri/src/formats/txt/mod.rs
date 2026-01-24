//! TXT 格式引擎
//! 负责文件读取、编码检测和章节识别

use chardetng::EncodingDetector;
use regex::Regex;
use std::fs;
use std::path::Path;

use super::{BookError, BookErrorCode, BookFormat, BookMetadata, TocItem, TocLocation};

/// TXT 引擎
pub struct TxtEngine {
    /// 解码后的全文内容
    content: String,
    /// 检测到的编码
    encoding: String,
    /// 文件路径
    file_path: String,
    /// 按行分割的内容
    lines: Vec<String>,
}

impl TxtEngine {
    /// 从文件加载 TXT
    pub fn from_file(path: &str) -> Result<Self, BookError> {
        // 检查文件是否存在
        if !Path::new(path).exists() {
            return Err(BookError::file_not_found(path));
        }

        // 读取原始字节
        let bytes = fs::read(path).map_err(|e| {
            BookError::new(BookErrorCode::IoError, format!("读取文件失败: {}", e))
        })?;

        // 编码检测与解码
        let (content, encoding) = Self::decode_content(&bytes)?;

        // 文本预处理：统一换行符
        let normalized = Self::normalize_text(&content);

        // 按行分割
        let lines: Vec<String> = normalized.lines().map(|s| s.to_string()).collect();

        Ok(Self {
            content: normalized,
            encoding,
            file_path: path.to_string(),
            lines,
        })
    }

    /// 编码检测与解码
    fn decode_content(bytes: &[u8]) -> Result<(String, String), BookError> {
        // BOM 检测：UTF-8/UTF-16/UTF-32
        if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
            // UTF-8 BOM
            let text = String::from_utf8_lossy(&bytes[3..]).into_owned();
            return Ok((text, "UTF-8".to_string()));
        }
        if bytes.starts_with(&[0xFF, 0xFE]) {
            // UTF-16 LE BOM
            let (decoded, _, had_errors) = encoding_rs::UTF_16LE.decode(&bytes[2..]);
            if had_errors {
                eprintln!("[TxtEngine] UTF-16LE 解码存在错误");
            }
            return Ok((decoded.into_owned(), "UTF-16LE".to_string()));
        }
        if bytes.starts_with(&[0xFE, 0xFF]) {
            // UTF-16 BE BOM
            let (decoded, _, had_errors) = encoding_rs::UTF_16BE.decode(&bytes[2..]);
            if had_errors {
                eprintln!("[TxtEngine] UTF-16BE 解码存在错误");
            }
            return Ok((decoded.into_owned(), "UTF-16BE".to_string()));
        }

        // 使用 chardetng 进行编码检测
        let mut detector = EncodingDetector::new();
        detector.feed(bytes, true);
        let encoding = detector.guess(None, true);
        let (decoded, _, had_errors) = encoding.decode(bytes);

        if had_errors {
            eprintln!(
                "[TxtEngine] 编码检测可能存在错误，使用 {} 解码",
                encoding.name()
            );
        }

        Ok((decoded.into_owned(), encoding.name().to_string()))
    }

    /// 文本预处理：统一换行符、去除多余空行
    fn normalize_text(content: &str) -> String {
        // 统一换行符为 \n
        let unified = content.replace("\r\n", "\n").replace("\r", "\n");

        // 合并连续过多的空行（超过 2 行压缩为 2 行）
        let mut result = String::new();
        let mut consecutive_empty = 0;

        for line in unified.lines() {
            if line.trim().is_empty() {
                consecutive_empty += 1;
                if consecutive_empty <= 2 {
                    result.push('\n');
                }
            } else {
                consecutive_empty = 0;
                result.push_str(line);
                result.push('\n');
            }
        }

        result
    }

    /// 获取全文内容
    pub fn get_content(&self) -> &str {
        &self.content
    }

    /// 获取检测到的编码
    pub fn get_encoding(&self) -> &str {
        &self.encoding
    }

    /// 从文件名解析标题
    pub fn get_title_from_filename(&self) -> Option<String> {
        Path::new(&self.file_path)
            .file_stem()
            .and_then(|s| s.to_str())
            .map(|s| s.to_string())
    }

    /// 获取标题（优先使用第一个识别到的章节标题，否则使用文件名）
    pub fn get_title(&self) -> Option<String> {
        let toc = self.get_toc();
        if let Some(first) = toc.first() {
            Some(first.title.clone())
        } else {
            self.get_title_from_filename()
        }
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
            page_count: 1, // 前端会进行虚拟分页
            format: Some(BookFormat::Txt),
        }
    }

    /// 章节识别，生成目录
    pub fn get_toc(&self) -> Vec<TocItem> {
        let mut toc = Vec::new();

        // 中文章节正则模式
        let chinese_chapter = Regex::new(
            r"^第[零一二三四五六七八九十百千万0-9]+[章节回卷集部篇]\s*.+"
        ).ok();
        let chinese_volume = Regex::new(
            r"^(正文\s*)?(卷[一二三四五六七八九十百千万0-9]+)\s*.+"
        ).ok();
        let chinese_prologue = Regex::new(
            r"^(楔子|序章|序言|序幕|尾声|后记|引子|番外)\s*$"
        ).ok();

        // 英文章节正则模式
        let english_chapter = Regex::new(
            r"(?i)^(Chapter|CHAPTER)\s+(\d+|[IVXLCM]+)"
        ).ok();
        let english_section = Regex::new(
            r"(?i)^(Section|Part)\s+(\d+|[IVXLCM]+)"
        ).ok();

        let mut char_offset = 0usize;

        for (line_num, line) in self.lines.iter().enumerate() {
            let trimmed = line.trim();

            // 跳过空行
            if trimmed.is_empty() {
                char_offset += line.len() + 1; // +1 for newline
                continue;
            }

            let mut matched = false;
            let mut title = String::new();
            let mut level = 1u32;

            // 中文章节匹配
            if let Some(ref re) = chinese_chapter {
                if re.is_match(trimmed) {
                    matched = true;
                    title = trimmed.to_string();
                    level = 1;
                }
            }
            if !matched {
                if let Some(ref re) = chinese_volume {
                    if re.is_match(trimmed) {
                        matched = true;
                        title = trimmed.to_string();
                        level = 0;
                    }
                }
            }
            if !matched {
                if let Some(ref re) = chinese_prologue {
                    if re.is_match(trimmed) {
                        matched = true;
                        title = trimmed.to_string();
                        level = 0;
                    }
                }
            }

            // 英文章节匹配
            if !matched {
                if let Some(ref re) = english_chapter {
                    if re.is_match(trimmed) {
                        matched = true;
                        title = trimmed.to_string();
                        level = 1;
                    }
                }
            }
            if !matched {
                if let Some(ref re) = english_section {
                    if re.is_match(trimmed) {
                        matched = true;
                        title = trimmed.to_string();
                        level = 0;
                    }
                }
            }

            if matched {
                toc.push(TocItem {
                    title,
                    location: TocLocation::Page(char_offset as u32),
                    level,
                    children: vec![],
                });
            }

            char_offset += line.len() + 1;
        }

        // 兜底策略：如果识别的章节太少，按固定行数分段
        if toc.len() < 3 && self.lines.len() > 100 {
            toc.clear();
            let segment_size = 300; // 每 300 行一个分段
            let mut offset = 0usize;
            let mut segment_num = 1;

            for (i, line) in self.lines.iter().enumerate() {
                if i > 0 && i % segment_size == 0 {
                    toc.push(TocItem {
                        title: format!("第 {} 部分", segment_num),
                        location: TocLocation::Page(offset as u32),
                        level: 1,
                        children: vec![],
                    });
                    segment_num += 1;
                }
                offset += line.len() + 1;
            }

            // 添加开头
            if toc.is_empty() || toc[0].location != TocLocation::Page(0) {
                toc.insert(0, TocItem {
                    title: "开始".to_string(),
                    location: TocLocation::Page(0),
                    level: 1,
                    children: vec![],
                });
            }
        }

        // 如果仍然没有目录，创建一个默认条目
        if toc.is_empty() {
            toc.push(TocItem {
                title: self.get_title_from_filename().unwrap_or_else(|| "全文".to_string()),
                location: TocLocation::Page(0),
                level: 0,
                children: vec![],
            });
        }

        toc
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_text() {
        let input = "line1\r\nline2\rline3\n\n\n\n\nline4";
        let normalized = TxtEngine::normalize_text(input);
        // 连续空行应该被压缩
        assert!(normalized.contains("line1\nline2\nline3"));
        assert!(normalized.contains("line4"));
    }

    #[test]
    fn test_chinese_chapter_detection() {
        let content = "第一章 开始\n这是正文内容\n第二章 继续\n更多内容";
        let engine = TxtEngine {
            content: content.to_string(),
            encoding: "UTF-8".to_string(),
            file_path: "/test/novel.txt".to_string(),
            lines: content.lines().map(|s| s.to_string()).collect(),
        };
        let toc = engine.get_toc();
        assert_eq!(toc.len(), 2);
        assert_eq!(toc[0].title, "第一章 开始");
        assert_eq!(toc[1].title, "第二章 继续");
    }
}

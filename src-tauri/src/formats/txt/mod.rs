//! TXT 格式引擎
//! 负责文件读取、编码检测和章节识别

mod toc_parser;

use chardetng::EncodingDetector;
use memmap2::MmapOptions;
use std::fs::{self, File};
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;

use super::{BookError, BookErrorCode, BookFormat, BookMetadata, TocItem, TocLocation};
use toc_parser::TocParser;

/// 章节元信息（包含字节偏移量）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TxtChapterMeta {
    /// 章节索引（0-based）
    pub index: u32,
    /// 章节标题
    pub title: String,
    /// 层级（0=卷/部，1=章）
    pub level: u32,
    /// 字节起始位置
    pub byte_start: u64,
    /// 字节结束位置
    pub byte_end: u64,
    /// 字符起始位置（解码后）
    pub char_start: u64,
    /// 字符结束位置（解码后）
    pub char_end: u64,
}

/// 章节内容
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TxtChapterContent {
    /// 章节索引
    pub index: u32,
    /// 章节文本内容
    pub content: String,
    /// 在全文中的字符起始位置
    pub char_start: u64,
    /// 在全文中的字符结束位置
    pub char_end: u64,
}

/// TXT 书籍元数据（首次加载返回）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TxtBookMeta {
    /// 书名
    pub title: String,
    /// 检测到的编码
    pub encoding: String,
    /// 文件总字节数
    pub total_bytes: u64,
    /// 总字符数
    pub total_chars: u64,
    /// 章节列表
    pub chapters: Vec<TxtChapterMeta>,
    /// 目录项（与原有 TocItem 兼容）
    pub toc: Vec<TocItem>,
}

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
    /// 从文件加载 TXT（完整加载，用于兼容旧逻辑）
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

    /// 快速解析元数据（不加载全文内容到内存中保持）
    /// 返回章节元信息和目录，用于章节懒加载
    pub fn load_metadata(path: &str) -> Result<TxtBookMeta, BookError> {
        // 检查文件是否存在
        if !Path::new(path).exists() {
            return Err(BookError::file_not_found(path));
        }

        // 获取文件大小并决定是否使用内存映射
        let metadata = fs::metadata(path).map_err(|e| {
            BookError::new(
                BookErrorCode::IoError,
                format!("读取文件元数据失败: {}", e),
            )
        })?;
        let file_size = metadata.len();
        let use_mmap = file_size > 8 * 1024 * 1024;

        if use_mmap {
            // 大文件优先使用内存映射，避免一次性分配巨大缓冲区
            let file = File::open(path).map_err(|e| {
                BookError::new(BookErrorCode::IoError, format!("打开文件失败: {}", e))
            })?;
            let mmap = unsafe {
                MmapOptions::new()
                    .map(&file)
                    .map_err(|e| {
                        BookError::new(
                            BookErrorCode::IoError,
                            format!("创建内存映射失败: {}", e),
                        )
                    })?
            };
            println!(
                "[TxtEngine] load_metadata 使用 mmap: path={}, size={}",
                path, file_size
            );

            let bytes: &[u8] = &mmap;

            // 编码检测与解码
            let (content, encoding) = Self::decode_content(bytes)?;

            // 文本预处理
            let normalized = Self::normalize_text(&content);
            let total_chars = normalized.chars().count() as u64;

            // 按行分割（用于目录解析）
            let lines: Vec<String> = normalized.lines().map(|s| s.to_string()).collect();

            // 获取标题
            let title = Self::extract_title_from_path(path);

            // 解析目录并获取章节元信息
            let parser = TocParser::new();
            let toc = parser.parse(&normalized, &lines);

            // 将 TocItem 转换为 TxtChapterMeta，计算字节偏移量
            let chapters =
                Self::convert_toc_to_chapters(&toc, &normalized, bytes, &encoding);
            let toc_indexed = Self::rewrite_toc_locations_as_chapter_index(&toc);

            Ok(TxtBookMeta {
                title,
                encoding,
                total_bytes: file_size,
                total_chars,
                chapters,
                toc: toc_indexed,
            })
        } else {
            // 小文件沿用原有读取逻辑
            let bytes = fs::read(path).map_err(|e| {
                BookError::new(BookErrorCode::IoError, format!("读取文件失败: {}", e))
            })?;
            let total_bytes = bytes.len() as u64;

            // 编码检测与解码
            let (content, encoding) = Self::decode_content(&bytes)?;

            // 文本预处理
            let normalized = Self::normalize_text(&content);
            let total_chars = normalized.chars().count() as u64;

            // 按行分割（用于目录解析）
            let lines: Vec<String> = normalized.lines().map(|s| s.to_string()).collect();

            // 获取标题
            let title = Self::extract_title_from_path(path);

            // 解析目录并获取章节元信息
            let parser = TocParser::new();
            let toc = parser.parse(&normalized, &lines);

            // 将 TocItem 转换为 TxtChapterMeta，计算字节偏移量
            let chapters =
                Self::convert_toc_to_chapters(&toc, &normalized, &bytes, &encoding);
            let toc_indexed = Self::rewrite_toc_locations_as_chapter_index(&toc);

            Ok(TxtBookMeta {
                title,
                encoding,
                total_bytes,
                total_chars,
                chapters,
                toc: toc_indexed,
            })
        }
    }

    /// 加载指定章节的内容
    pub fn load_chapter(path: &str, chapter_index: u32, meta: &TxtBookMeta) -> Result<TxtChapterContent, BookError> {
        let chapters = Self::load_chapters(path, &[chapter_index], meta)?;
        chapters
            .into_iter()
            .next()
            .ok_or_else(|| {
                BookError::new(
                    BookErrorCode::InvalidParameter,
                    format!(
                        "无法加载章节 {}，当前章节总数 {}",
                        chapter_index,
                        meta.chapters.len()
                    ),
                )
            })
    }

    /// 批量加载多个章节
    pub fn load_chapters(path: &str, indices: &[u32], meta: &TxtBookMeta) -> Result<Vec<TxtChapterContent>, BookError> {
        if indices.is_empty() {
            return Ok(Vec::new());
        }

        // 过滤非法索引，避免越界
        let mut valid_indices = Vec::with_capacity(indices.len());
        for &idx in indices {
            if (idx as usize) < meta.chapters.len() {
                valid_indices.push(idx);
            } else {
                println!(
                    "[TxtEngine] 忽略越界章节索引: index={}, total_chapters={}",
                    idx,
                    meta.chapters.len()
                );
            }
        }

        if valid_indices.is_empty() {
            return Ok(Vec::new());
        }

        // 获取文件大小并决定是否使用内存映射
        let metadata = fs::metadata(path).map_err(|e| {
            BookError::new(
                BookErrorCode::IoError,
                format!("读取文件元数据失败: {}", e),
            )
        })?;
        let file_size = metadata.len();
        let use_mmap = file_size > 8 * 1024 * 1024;

        if use_mmap {
            let file = File::open(path).map_err(|e| {
                BookError::new(BookErrorCode::IoError, format!("打开文件失败: {}", e))
            })?;
            let mmap = unsafe {
                MmapOptions::new()
                    .map(&file)
                    .map_err(|e| {
                        BookError::new(
                            BookErrorCode::IoError,
                            format!("创建内存映射失败: {}", e),
                        )
                    })?
            };
            println!(
                "[TxtEngine] load_chapters 使用 mmap: path={}, size={}, count={}",
                path,
                file_size,
                valid_indices.len()
            );

            let bytes: &[u8] = &mmap;
            let mut results = Vec::with_capacity(valid_indices.len());

            for &idx in &valid_indices {
                let chapter =
                    Self::build_chapter_from_slice(path, idx, meta, bytes, file_size)?;
                results.push(chapter);
            }

            Ok(results)
        } else {
            // 小文件使用标准 IO
            let file = File::open(path).map_err(|e| {
                BookError::new(BookErrorCode::IoError, format!("打开文件失败: {}", e))
            })?;
            let mut reader = BufReader::new(file);

            println!(
                "[TxtEngine] load_chapters 使用标准 IO: path={}, size={}, count={}",
                path,
                file_size,
                valid_indices.len()
            );

            let mut results = Vec::with_capacity(valid_indices.len());
            for &idx in &valid_indices {
                let chapter =
                    Self::build_chapter_with_reader(path, idx, meta, &mut reader, file_size)?;
                results.push(chapter);
            }

            Ok(results)
        }
    }

    /// 从内存切片构建章节内容（用于 mmap）
    fn build_chapter_from_slice(
        path: &str,
        chapter_index: u32,
        meta: &TxtBookMeta,
        bytes: &[u8],
        file_size: u64,
    ) -> Result<TxtChapterContent, BookError> {
        let chapter = meta
            .chapters
            .get(chapter_index as usize)
            .ok_or_else(|| {
                BookError::new(
                    BookErrorCode::InvalidParameter,
                    format!(
                        "章节索引 {} 超出范围（共 {} 章）",
                        chapter_index,
                        meta.chapters.len()
                    ),
                )
            })?;

        let (start, end) =
            Self::clamp_chapter_range(path, chapter_index, chapter.byte_start, chapter.byte_end, file_size);

        let start_idx = start as usize;
        let end_idx = end as usize;
        if start_idx > end_idx || end_idx > bytes.len() {
            return Err(BookError::new(
                BookErrorCode::IoError,
                format!(
                    "章节字节范围无效: path={}, index={}, start={}, end={}, file_size={}, bytes_len={}",
                    path,
                    chapter_index,
                    start,
                    end,
                    file_size,
                    bytes.len()
                ),
            ));
        }

        let slice = &bytes[start_idx..end_idx];
        let content = Self::decode_bytes(slice, &meta.encoding)?;
        let normalized = Self::normalize_text(&content);

        Ok(TxtChapterContent {
            index: chapter_index,
            content: normalized,
            char_start: chapter.char_start,
            char_end: chapter.char_end,
        })
    }

    /// 使用 BufReader 构建章节内容（用于标准 IO）
    fn build_chapter_with_reader(
        path: &str,
        chapter_index: u32,
        meta: &TxtBookMeta,
        reader: &mut BufReader<File>,
        file_size: u64,
    ) -> Result<TxtChapterContent, BookError> {
        let chapter = meta
            .chapters
            .get(chapter_index as usize)
            .ok_or_else(|| {
                BookError::new(
                    BookErrorCode::InvalidParameter,
                    format!(
                        "章节索引 {} 超出范围（共 {} 章）",
                        chapter_index,
                        meta.chapters.len()
                    ),
                )
            })?;

        let (start, end) =
            Self::clamp_chapter_range(path, chapter_index, chapter.byte_start, chapter.byte_end, file_size);

        reader.seek(SeekFrom::Start(start)).map_err(|e| {
            BookError::new(BookErrorCode::IoError, format!("Seek 失败: {}", e))
        })?;

        let byte_len = (end - start) as usize;
        let mut buffer = vec![0u8; byte_len];
        reader.read_exact(&mut buffer).map_err(|e| {
            BookError::new(
                BookErrorCode::IoError,
                format!("读取章节内容失败: {}", e),
            )
        })?;

        let content = Self::decode_bytes(&buffer, &meta.encoding)?;
        let normalized = Self::normalize_text(&content);

        Ok(TxtChapterContent {
            index: chapter_index,
            content: normalized,
            char_start: chapter.char_start,
            char_end: chapter.char_end,
        })
    }

    /// 校正章节字节范围并输出日志
    fn clamp_chapter_range(
        path: &str,
        chapter_index: u32,
        raw_start: u64,
        raw_end: u64,
        file_size: u64,
    ) -> (u64, u64) {
        let mut start = raw_start.min(file_size);
        let mut end = raw_end.min(file_size);

        if end < start {
            end = start;
        }

        if start != raw_start || end != raw_end {
            println!(
                "[TxtEngine] 章节字节范围调整: path={}, index={}, raw_start={}, raw_end={}, clamped_start={}, clamped_end={}, file_size={}",
                path,
                chapter_index,
                raw_start,
                raw_end,
                start,
                end,
                file_size
            );
        }

        (start, end)
    }

    /// 将 TocItem 转换为 TxtChapterMeta
    fn convert_toc_to_chapters(
        toc: &[TocItem],
        content: &str,
        raw_bytes: &[u8],
        encoding: &str,
    ) -> Vec<TxtChapterMeta> {
        let mut chapters = Vec::new();
        let mut flat_toc = Vec::new();

        // 扁平化目录（包含子节点）
        Self::flatten_toc(toc, &mut flat_toc);

        // 预计算 UTF-8 下的字符到字节偏移映射，避免重复遍历
        let is_utf8 = encoding == "UTF-8" || encoding.starts_with("UTF-8");
        let (char_to_byte, total_chars) = if is_utf8 {
            let mut mapping: Vec<u64> = Vec::with_capacity(content.chars().count() + 1);
            mapping.push(0);
            let mut acc: u64 = 0;
            for c in content.chars() {
                acc += c.len_utf8() as u64;
                mapping.push(acc);
            }
            let total_chars = (mapping.len().saturating_sub(1)) as u64;
            (Some(mapping), total_chars)
        } else {
            let total_chars = content.chars().count() as u64;
            (None, total_chars)
        };

        println!(
            "[TxtEngine] 目录转换开始: toc_nodes={}, flat_len={}, encoding={}, total_chars={}",
            toc.len(),
            flat_toc.len(),
            encoding,
            total_chars
        );

        // 根据字符偏移量计算字节偏移量
        for (i, item) in flat_toc.iter().enumerate() {
            let mut char_start = match &item.location {
                TocLocation::Page(offset) => *offset as u64,
                _ => 0,
            };
            if char_start > total_chars {
                char_start = total_chars;
            }

            // 计算字节偏移量
            let byte_start = if let Some(ref mapping) = char_to_byte {
                let idx = char_start as usize;
                mapping[idx.min(mapping.len().saturating_sub(1))]
            } else {
                Self::char_offset_to_byte_offset(content, raw_bytes, encoding, char_start as usize)
            };

            // 下一章的起始位置就是当前章的结束位置
            let (char_end, byte_end) = if i + 1 < flat_toc.len() {
                let mut next_char_start = match &flat_toc[i + 1].location {
                    TocLocation::Page(offset) => *offset as u64,
                    _ => total_chars,
                };
                if next_char_start > total_chars {
                    next_char_start = total_chars;
                }
                let next_byte_start = if let Some(ref mapping) = char_to_byte {
                    let idx = next_char_start as usize;
                    mapping[idx.min(mapping.len().saturating_sub(1))]
                } else {
                    Self::char_offset_to_byte_offset(content, raw_bytes, encoding, next_char_start as usize)
                };
                (next_char_start, next_byte_start)
            } else {
                (total_chars, raw_bytes.len() as u64)
            };

            chapters.push(TxtChapterMeta {
                index: i as u32,
                title: item.title.clone(),
                level: item.level,
                byte_start,
                byte_end,
                char_start,
                char_end,
            });
        }

        if let Some(last) = chapters.last() {
            println!(
                "[TxtEngine] 目录转换完成: chapters={}, last_index={}, last_byte_end={}, total_bytes={}",
                chapters.len(),
                last.index,
                last.byte_end,
                raw_bytes.len()
            );
        } else {
            println!(
                "[TxtEngine] 目录转换完成: chapters=0, total_bytes={}",
                raw_bytes.len()
            );
        }

        chapters
    }

    /// 扁平化目录树
    fn flatten_toc(toc: &[TocItem], flat: &mut Vec<TocItem>) {
        for item in toc {
            flat.push(item.clone());
            if !item.children.is_empty() {
                Self::flatten_toc(&item.children, flat);
            }
        }
    }

    fn rewrite_toc_locations_as_chapter_index(toc: &[TocItem]) -> Vec<TocItem> {
        fn walk(items: &[TocItem], next_index: &mut u32) -> Vec<TocItem> {
            items
                .iter()
                .map(|item| {
                    let index = *next_index;
                    *next_index = next_index.saturating_add(1);

                    TocItem {
                        title: item.title.clone(),
                        location: TocLocation::Page(index.saturating_add(1)),
                        level: item.level,
                        children: walk(&item.children, next_index),
                    }
                })
                .collect()
        }

        let mut next_index: u32 = 0;
        walk(toc, &mut next_index)
    }

    /// 将字符偏移量转换为字节偏移量
    fn char_offset_to_byte_offset(content: &str, raw_bytes: &[u8], encoding: &str, char_offset: usize) -> u64 {
        if encoding == "UTF-8" || encoding.starts_with("UTF-8") {
            let mut byte_offset = 0usize;
            for (i, c) in content.chars().enumerate() {
                if i >= char_offset {
                    break;
                }
                byte_offset += c.len_utf8();
            }
            return byte_offset.min(raw_bytes.len()) as u64;
        }

        let total_chars = content.chars().count().max(1);
        let clamped_offset = char_offset.min(total_chars);
        let ratio = raw_bytes.len() as f64 / total_chars as f64;
        let byte_offset = (clamped_offset as f64 * ratio) as u64;
        byte_offset.min(raw_bytes.len() as u64)
    }

    /// 从路径提取标题
    fn extract_title_from_path(path: &str) -> String {
        Path::new(path)
            .file_stem()
            .and_then(|s| s.to_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| "未知".to_string())
    }

    /// 解码指定字节数组
    fn decode_bytes(bytes: &[u8], encoding: &str) -> Result<String, BookError> {
        // 根据编码名称选择解码器
        let decoded = match encoding {
            "UTF-8" => String::from_utf8_lossy(bytes).into_owned(),
            "UTF-16LE" => {
                let (decoded, _, _) = encoding_rs::UTF_16LE.decode(bytes);
                decoded.into_owned()
            }
            "UTF-16BE" => {
                let (decoded, _, _) = encoding_rs::UTF_16BE.decode(bytes);
                decoded.into_owned()
            }
            "GBK" | "GB18030" | "GB2312" => {
                let (decoded, _, _) = encoding_rs::GBK.decode(bytes);
                decoded.into_owned()
            }
            "BIG5" | "Big5" => {
                let (decoded, _, _) = encoding_rs::BIG5.decode(bytes);
                decoded.into_owned()
            }
            _ => {
                // 尝试使用 chardetng 重新检测
                let mut detector = EncodingDetector::new();
                detector.feed(bytes, true);
                let encoding_detected = detector.guess(None, true);
                let (decoded, _, _) = encoding_detected.decode(bytes);
                decoded.into_owned()
            }
        };
        Ok(decoded)
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
        // 使用新的 TOC 解析器
        let parser = TocParser::new();
        let mut toc = parser.parse(&self.content, &self.lines);

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

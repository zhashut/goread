//! MOBI 正则常量定义
//! 集中管理所有字节级和文本级正则表达式

use once_cell::sync::Lazy;
use regex::Regex;

// ====================== 字节正则（在 &[u8] 上匹配） ======================

/// 匹配 <body> 标签内容起始位置
pub(super) static BODY_OPEN_RE: Lazy<regex::bytes::Regex> = Lazy::new(|| {
    regex::bytes::Regex::new(r"(?is)<body[^>]*>").unwrap()
});

/// 匹配 </body> 结束标签
pub(super) static BODY_CLOSE_RE: Lazy<regex::bytes::Regex> = Lazy::new(|| {
    regex::bytes::Regex::new(r"(?is)</body>").unwrap()
});

/// 匹配分页标记（字节级）
pub(super) static SPLIT_BYTES_RE: Lazy<regex::bytes::Regex> = Lazy::new(|| {
    regex::bytes::Regex::new(r#"(?i)<mbp:pagebreak\s*/?>\s*|<hr\s+class=["']?pagebreak["']?\s*/?>"#).unwrap()
});

/// 匹配 guide 中 <reference type="toc" filepos="N">（字节级）
pub(super) static REF_TOC_BYTES_RE: Lazy<regex::bytes::Regex> = Lazy::new(|| {
    regex::bytes::Regex::new(r#"(?i)<reference[^>]+type\s*=\s*["']?toc["']?[^>]+filepos\s*=\s*["']?(\d+)["']?[^>]*>"#).unwrap()
});

/// 匹配 guide 中 filepos 在 type 前的变体（字节级）
pub(super) static REF_TOC_ALT_BYTES_RE: Lazy<regex::bytes::Regex> = Lazy::new(|| {
    regex::bytes::Regex::new(r#"(?i)<reference[^>]+filepos\s*=\s*["']?(\d+)["']?[^>]+type\s*=\s*["']?toc["']?[^>]*>"#).unwrap()
});

/// 匹配 <a filepos="N">...</a> 锚点（字节级）
pub(super) static ANCHOR_BYTES_RE: Lazy<regex::bytes::Regex> = Lazy::new(|| {
    regex::bytes::Regex::new(r#"(?is)<a[^>]+filepos\s*=\s*["']?(\d+)["']?[^>]*>(.*?)</a>"#).unwrap()
});

/// 匹配 guide 中 <reference type="cover" filepos="N">（字节级，封面提取）
pub(super) static REF_COVER_BYTES_RE: Lazy<regex::bytes::Regex> = Lazy::new(|| {
    regex::bytes::Regex::new(r#"(?i)<reference[^>]+type\s*=\s*["']?cover["']?[^>]+filepos\s*=\s*["']?(\d+)["']?[^>]*>"#).unwrap()
});

/// 匹配 <img recindex="N">（字节级，封面提取用）
pub(super) static IMG_RECINDEX_BYTES_RE: Lazy<regex::bytes::Regex> = Lazy::new(|| {
    regex::bytes::Regex::new(r#"(?i)<img[^>]+recindex\s*=\s*["']?(\d+)["']?[^>]*>"#).unwrap()
});

// ====================== 文本正则（在 UTF-8 String 上匹配） ======================

/// 匹配 <img recindex="N"> 图片引用（用于解码后的 HTML）
pub(super) static RECINDEX_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?i)<img\s+([^>]*?)recindex\s*=\s*["']?(\d+)["']?([^>]*)>"#).unwrap()
});

/// 匹配 h1-h6 标题标签及内容
pub(super) static HEADING_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)<h([1-6])[^>]*>(.*?)</h[1-6]>").unwrap()
});

/// 匹配 h1-h3 标题起始位置（用于按标题拆分）
pub(super) static HEADING_POS_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)<h[1-3][^>]*>").unwrap()
});

/// 匹配中英文章节名模式（第X章/第X节/Chapter N 等）
pub(super) static CHAPTER_PATTERN_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?m)(第[一二三四五六七八九十百千零\d]{1,6}[章节回卷篇]|Chapter\s+\d+|Part\s+\d+)").unwrap()
});

/// 匹配上级目录模式（篇/卷/Part）
pub(super) static PART_LEVEL_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"第[一二三四五六七八九十百千零\d]{1,6}[篇卷]|Part\s+\d+").unwrap()
});

/// 匹配章级目录模式（章/节/回/Chapter）
pub(super) static CHAPTER_LEVEL_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"第[一二三四五六七八九十百千零\d]{1,6}[章节回]|Chapter\s+\d+").unwrap()
});

/// 匹配首个 <p> 段落的文本内容
pub(super) static FIRST_P_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?is)<p[^>]*>(.*?)</p>").unwrap()
});

/// 匹配资源占位符引用
pub(super) static RES_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"__MOBI_RES__:([^\s"'>]+)"#).unwrap()
});

/// 匹配 HTML 标签（去除标签用）
pub(super) static TAG_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"<[^>]*>").unwrap()
});

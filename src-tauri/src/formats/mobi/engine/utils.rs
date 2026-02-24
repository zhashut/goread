//! MOBI 通用工具函数
//! 图片 MIME 猜测、HTML 标签处理、section 构建等跨模块使用的辅助函数

use std::collections::HashMap;

use super::patterns::{CHAPTER_PATTERN_RE, RECINDEX_RE, RES_RE, TAG_RE};
use super::PreparedSection;

/// 根据 magic bytes 猜测 MIME 类型
pub(super) fn guess_image_mime(data: &[u8]) -> String {
    if data.len() < 4 { return "image/jpeg".to_string(); }
    if data.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        "image/png".to_string()
    } else if data.starts_with(&[0x47, 0x49, 0x46]) {
        "image/gif".to_string()
    } else if data.starts_with(b"BM") {
        "image/bmp".to_string()
    } else if data.len() > 12 && &data[8..12] == b"WEBP" {
        "image/webp".to_string()
    } else {
        "image/jpeg".to_string()
    }
}

/// MIME → 扩展名
pub(super) fn mime_to_ext(mime: &str) -> &str {
    match mime {
        "image/png" => "png",
        "image/gif" => "gif",
        "image/bmp" => "bmp",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        _ => "jpg",
    }
}

/// 提取 HTML 中的资源引用列表（去重）
pub(super) fn extract_resource_refs(html: &str) -> Vec<String> {
    RES_RE.captures_iter(html)
        .filter_map(|c| c.get(1).map(|m| m.as_str().to_string()))
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect()
}

/// 构建 PreparedSection
pub(super) fn build_section(content: String, index: u32) -> PreparedSection {
    let resource_refs = extract_resource_refs(&content);
    PreparedSection {
        index,
        html: content,
        styles: vec![],
        resource_refs,
    }
}

/// 替换 recindex 图片引用为资源占位符
pub(super) fn replace_recindex(html: &str, image_map: &HashMap<usize, String>) -> String {
    RECINDEX_RE.replace_all(html, |caps: &regex::Captures| {
        let before = &caps[1];
        let idx: usize = caps[2].parse().unwrap_or(0);
        let after = &caps[3];
        match image_map.get(&idx) {
            Some(path) => format!("<img {}src=\"__MOBI_RES__:{}\"{}/> ", before, path, after),
            None => caps[0].to_string(),
        }
    }).into_owned()
}

/// 判断文本是否像章节标题（排除对话、叙述等正文内容）
pub(super) fn is_title_like(text: &str) -> bool {
    // 匹配已知章节模式直接通过
    if CHAPTER_PATTERN_RE.is_match(text) {
        return true;
    }
    // 含对话/引用标记的不是标题
    let dialogue_markers = [':', '：', '"', '\u{201c}', '\u{201d}', '「', '」'];
    if text.contains("——") || dialogue_markers.iter().any(|&c| text.contains(c)) {
        return false;
    }
    // 超过 30 个字符且不含章节关键词的大概率是正文
    if text.chars().count() > 30 {
        return false;
    }
    true
}

/// 去除 HTML 标签
pub(super) fn strip_html_tags(html: &str) -> String {
    TAG_RE.replace_all(html, "").to_string()
}

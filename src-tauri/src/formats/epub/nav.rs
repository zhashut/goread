//! EPUB3 导航文档（nav.xhtml）目录解析
//!
//! 背景：部分 EPUB3 书籍仅包含 nav.xhtml 而不含 toc.ncx，
//! 当前依赖的 `epub` crate 仅解析 NCX，导致这类书目录为空。
//! 本模块自行读取 OPF，定位 `properties="nav"` 的导航文档，
//! 解析其中 `<nav epub:type="toc">` 的 `<ol>/<li>` 结构为 TocItem 树。

use epub::doc::EpubDoc;
use regex::Regex;

use super::TocItem;

/// 单条目录解析结果
struct NavEntry {
    title: Option<String>,
    href: Option<String>,
    children: Vec<NavEntry>,
}

/// 解析 EPUB3 nav.xhtml 目录。无可用 nav 或解析结果为空时返回 None。
pub fn parse_nav_toc<R: std::io::Read + std::io::Seek>(
    doc: &mut EpubDoc<R>,
) -> Option<Vec<TocItem>> {
    let nav_path = locate_nav_path(doc)?;
    let nav_bytes = doc.get_resource_by_path(&nav_path)?;
    let nav_text = String::from_utf8(nav_bytes).ok()?;

    let entries = parse_nav_xhtml(&nav_text);
    if entries.is_empty() {
        return None;
    }

    let toc = entries_to_toc_items(&entries, 0, &nav_path);
    if toc.is_empty() {
        None
    } else {
        Some(toc)
    }
}

/// 基于 spine 的兜底目录：每个 spine 项作为一条顶级条目，标题取文件名去后缀。
/// 用于既无 nav 又无 ncx 的极端场景，保证目录抽屉至少可用。
pub fn build_spine_fallback_toc(spine_paths: &[String]) -> Vec<TocItem> {
    spine_paths
        .iter()
        .enumerate()
        .map(|(idx, path)| {
            let title = extract_filename_title(path).unwrap_or_else(|| format!("章节 {}", idx + 1));
            TocItem {
                title: Some(title),
                location: Some(path.clone()),
                level: 0,
                children: Vec::new(),
            }
        })
        .collect()
}

/// 定位 nav.xhtml 在 EPUB 包内的绝对路径。
/// 先读取 OPF，从 manifest 中查找 `properties` 包含 "nav" 的 item；
/// 失败时回退扫描 resources 中 mime 为 application/xhtml+xml 且内容含目录 nav 的文件。
fn locate_nav_path<R: std::io::Read + std::io::Seek>(doc: &mut EpubDoc<R>) -> Option<String> {
    if let Some(path) = locate_nav_from_opf(doc) {
        return Some(path);
    }
    locate_nav_by_scan(doc)
}

/// 通过解析 OPF 的 manifest 定位 nav item
fn locate_nav_from_opf<R: std::io::Read + std::io::Seek>(doc: &mut EpubDoc<R>) -> Option<String> {
    let root_file = doc.root_file.to_string_lossy().to_string();
    let opf_bytes = doc.get_resource_by_path(&root_file)?;
    let opf_text = String::from_utf8(opf_bytes).ok()?;

    let item_re = Regex::new(r#"(?is)<item\b([^>]*)/?>"#).ok()?;
    for caps in item_re.captures_iter(&opf_text) {
        let attrs = &caps[1];
        if !attr_contains_nav_property(attrs) {
            continue;
        }
        let href = extract_attr(attrs, "href")?;
        let base_dir = opf_base_dir(&root_file);
        return Some(join_package_path(&base_dir, &href));
    }
    None
}

/// 扫描资源列表，寻找包含导航 nav 节点的 xhtml
fn locate_nav_by_scan<R: std::io::Read + std::io::Seek>(doc: &mut EpubDoc<R>) -> Option<String> {
    let candidates: Vec<String> = doc
        .resources
        .iter()
        .filter_map(|(_, item)| {
            if item.mime.contains("xhtml") || item.mime.contains("html") {
                Some(item.path.to_string_lossy().to_string())
            } else {
                None
            }
        })
        .collect();

    for path in candidates {
        let Some(bytes) = doc.get_resource_by_path(&path) else {
            continue;
        };
        let Ok(text) = String::from_utf8(bytes) else {
            continue;
        };
        if contains_toc_nav(&text) {
            return Some(path);
        }
    }
    None
}

/// 判断 item 属性串是否声明了 nav 角色
fn attr_contains_nav_property(attrs: &str) -> bool {
    let Some(props) = extract_attr(attrs, "properties") else {
        return false;
    };
    props
        .split_whitespace()
        .any(|token| token.eq_ignore_ascii_case("nav"))
}

/// 从属性字符串中提取指定属性的值，兼容单双引号
fn extract_attr(attrs: &str, name: &str) -> Option<String> {
    let pattern = format!(r#"(?is)\b{}\s*=\s*(?:"([^"]*)"|'([^']*)')"#, regex::escape(name));
    let re = Regex::new(&pattern).ok()?;
    let caps = re.captures(attrs)?;
    caps.get(1)
        .or_else(|| caps.get(2))
        .map(|m| m.as_str().to_string())
}

/// 判断 xhtml 文本是否包含导航 nav 节点
fn contains_toc_nav(text: &str) -> bool {
    let re = Regex::new(r#"(?is)<nav\b[^>]*epub:type\s*=\s*["']toc["']"#).ok();
    if let Some(re) = re {
        if re.is_match(text) {
            return true;
        }
    }
    let role_re = Regex::new(r#"(?is)<nav\b[^>]*role\s*=\s*["']doc-toc["']"#).ok();
    if let Some(re) = role_re {
        if re.is_match(text) {
            return true;
        }
    }
    false
}

/// 从 OPF 路径推导其所在目录（用于拼接相对 href）
fn opf_base_dir(root_file: &str) -> String {
    match root_file.rfind('/') {
        Some(pos) => root_file[..pos].to_string(),
        None => String::new(),
    }
}

/// 在包内按"基准目录 + 相对路径"解析为绝对路径，规范化 . 与 ..
fn join_package_path(base_dir: &str, relative: &str) -> String {
    let mut parts: Vec<&str> = if base_dir.is_empty() {
        Vec::new()
    } else {
        base_dir.split('/').collect()
    };

    for seg in relative.split('/') {
        match seg {
            ".." => {
                parts.pop();
            }
            "." | "" => {}
            _ => parts.push(seg),
        }
    }

    parts.join("/")
}

/// 将 nav 解析条目树转换为 TocItem 树，同时对 href 做包内绝对化与 URL 解码
fn entries_to_toc_items(entries: &[NavEntry], level: i32, nav_path: &str) -> Vec<TocItem> {
    let base_dir = opf_base_dir(nav_path);
    entries
        .iter()
        .map(|entry| {
            let title = entry.title.as_ref().and_then(|t| {
                let trimmed = t.trim();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed.to_string())
                }
            });

            let location = entry.href.as_ref().map(|href| {
                let decoded = percent_decode_utf8(href);
                resolve_href_to_package(&base_dir, &decoded)
            });

            let children = entries_to_toc_items(&entry.children, level + 1, nav_path);

            TocItem {
                title,
                location,
                level,
                children,
            }
        })
        .collect()
}

/// 将相对/绝对 href 解析为包内绝对路径，保留 #anchor
fn resolve_href_to_package(base_dir: &str, href: &str) -> String {
    let (path_part, anchor) = match href.find('#') {
        Some(pos) => (&href[..pos], &href[pos..]),
        None => (href, ""),
    };

    let resolved = if path_part.is_empty() {
        String::new()
    } else {
        join_package_path(base_dir, path_part)
    };

    if anchor.is_empty() {
        resolved
    } else if resolved.is_empty() {
        anchor.to_string()
    } else {
        format!("{}{}", resolved, anchor)
    }
}

/// UTF-8 友好的 percent-decode，失败时回退原字符串
fn percent_decode_utf8(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                out.push((h << 4) | l);
                i += 3;
                continue;
            }
        }
        out.push(b);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| input.to_string())
}

/// 将 ASCII 十六进制字符转为数值
fn hex_val(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// 从路径中提取文件名去除扩展名作为默认标题
fn extract_filename_title(path: &str) -> Option<String> {
    let name = path.rsplit('/').next()?;
    let stem = name.rsplit_once('.').map(|(s, _)| s).unwrap_or(name);
    let decoded = percent_decode_utf8(stem);
    let trimmed = decoded.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

// ========================= nav.xhtml 结构解析 =========================

/// 解析 nav.xhtml 文本，返回顶层条目数组
fn parse_nav_xhtml(text: &str) -> Vec<NavEntry> {
    let Some(nav_inner) = locate_toc_nav_inner(text) else {
        return Vec::new();
    };
    let Some(ol_inner) = find_first_ol_inner(nav_inner) else {
        return Vec::new();
    };
    parse_ol(ol_inner, 0)
}

/// 定位 nav.xhtml 中目录用 nav 的内部内容
fn locate_toc_nav_inner(text: &str) -> Option<&str> {
    let nav_open_re = Regex::new(r#"(?is)<nav\b([^>]*)>"#).ok()?;
    let mut best: Option<(u32, &str, &str)> = None;

    for caps in nav_open_re.captures_iter(text) {
        let attrs_match = caps.get(1)?;
        let open_match = caps.get(0)?;
        let attrs = attrs_match.as_str();
        let start = open_match.end();
        let end = find_matching_close(text, start, "nav")?;
        let inner = &text[start..end];

        let score = score_nav_attrs(attrs);
        if score == 0 {
            continue;
        }
        if best.as_ref().map_or(true, |(s, _, _)| score > *s) {
            best = Some((score, attrs, inner));
        }
    }

    best.map(|(_, _, inner)| inner).or_else(|| {
        // 未命中属性评分时，退回到首个含 ol 的 nav
        for caps in nav_open_re.captures_iter(text) {
            let open_match = caps.get(0)?;
            let start = open_match.end();
            let end = find_matching_close(text, start, "nav")?;
            let inner = &text[start..end];
            if find_first_ol_inner(inner).is_some() {
                return Some(inner);
            }
        }
        None
    })
}

/// 对 nav 标签属性打分，分数越高越可能是目录 nav
fn score_nav_attrs(attrs: &str) -> u32 {
    if let Some(v) = extract_attr(attrs, "epub:type") {
        if v.split_whitespace().any(|t| t.eq_ignore_ascii_case("toc")) {
            return 100;
        }
        if v.split_whitespace()
            .any(|t| t.eq_ignore_ascii_case("landmarks") || t.eq_ignore_ascii_case("page-list"))
        {
            return 0;
        }
    }
    if let Some(v) = extract_attr(attrs, "role") {
        if v.split_whitespace().any(|t| t.eq_ignore_ascii_case("doc-toc")) {
            return 80;
        }
    }
    if let Some(v) = extract_attr(attrs, "id") {
        if v.eq_ignore_ascii_case("toc") {
            return 50;
        }
    }
    10
}

/// 在文本 start 位置之后寻找与指定标签名匹配的关闭标签位置（支持同名嵌套）
fn find_matching_close(text: &str, start: usize, tag: &str) -> Option<usize> {
    let open_re = Regex::new(&format!(r#"(?is)<{tag}\b[^>]*>"#, tag = regex::escape(tag))).ok()?;
    let close_re =
        Regex::new(&format!(r#"(?is)</{tag}\s*>"#, tag = regex::escape(tag))).ok()?;

    let mut depth: i32 = 1;
    let mut cursor = start;

    loop {
        let rest = &text[cursor..];
        let next_open = open_re.find(rest);
        let next_close = close_re.find(rest)?;

        match next_open {
            Some(o) if o.start() < next_close.start() => {
                // 忽略自闭合
                let tag_text = &rest[o.start()..o.end()];
                if !tag_text.ends_with("/>") {
                    depth += 1;
                }
                cursor += o.end();
            }
            _ => {
                depth -= 1;
                if depth == 0 {
                    return Some(cursor + next_close.start());
                }
                cursor += next_close.end();
            }
        }
    }
}

/// 在指定文本中查找第一个 <ol> 的内部内容
fn find_first_ol_inner(text: &str) -> Option<&str> {
    let open_re = Regex::new(r#"(?is)<ol\b[^>]*>"#).ok()?;
    let m = open_re.find(text)?;
    let start = m.end();
    let end = find_matching_close(text, start, "ol")?;
    Some(&text[start..end])
}

/// 递归解析 <ol> 内部的 <li> 列表
fn parse_ol(ol_inner: &str, depth: u32) -> Vec<NavEntry> {
    // 限制深度避免异常结构导致递归过深
    if depth >= 20 {
        return Vec::new();
    }

    let li_items = split_top_level_li(ol_inner);
    li_items
        .into_iter()
        .filter_map(|li_inner| parse_li(&li_inner, depth))
        .collect()
}

/// 将 ol 内部按顶层 <li> 切分，忽略嵌套 <ol>/<li>
fn split_top_level_li(ol_inner: &str) -> Vec<String> {
    let bytes = ol_inner.as_bytes();
    let mut results: Vec<String> = Vec::new();
    let mut i = 0;

    while i < bytes.len() {
        // 寻找下一个 <li
        let Some(open_start) = find_tag_open(ol_inner, i, "li") else {
            break;
        };
        // 定位 > 结束
        let Some(open_end_rel) = ol_inner[open_start..].find('>') else {
            break;
        };
        let content_start = open_start + open_end_rel + 1;
        let Some(close_pos) = find_matching_close(ol_inner, content_start, "li") else {
            break;
        };
        results.push(ol_inner[content_start..close_pos].to_string());
        // 跳过 </li>
        let after_close = match ol_inner[close_pos..].find('>') {
            Some(p) => close_pos + p + 1,
            None => close_pos + 5,
        };
        i = after_close;
    }

    results
}

/// 在 text 中从 from 开始查找指定标签的开起始位置（不是自闭合标签名前缀匹配）
fn find_tag_open(text: &str, from: usize, tag: &str) -> Option<usize> {
    let pattern = format!(r#"(?is)<{tag}\b"#, tag = regex::escape(tag));
    let re = Regex::new(&pattern).ok()?;
    re.find_at(text, from).map(|m| m.start())
}

/// 解析单个 <li> 内部内容，返回其对应的 NavEntry
fn parse_li(li_inner: &str, depth: u32) -> Option<NavEntry> {
    // 1. 先切出子 <ol>（若存在），剩余部分含有 a/span
    let (head_part, children) = split_li_head_and_children(li_inner, depth);

    let (title, href) = extract_title_and_href(&head_part);

    if title.is_none() && href.is_none() && children.is_empty() {
        return None;
    }

    Some(NavEntry {
        title,
        href,
        children,
    })
}

/// 将 li 内部分离为「头部内容」与「子 ol 条目列表」
fn split_li_head_and_children(li_inner: &str, depth: u32) -> (String, Vec<NavEntry>) {
    let Some(ol_open_re) = Regex::new(r#"(?is)<ol\b[^>]*>"#).ok() else {
        return (li_inner.to_string(), Vec::new());
    };
    let Some(m) = ol_open_re.find(li_inner) else {
        return (li_inner.to_string(), Vec::new());
    };
    let head = li_inner[..m.start()].to_string();
    let child_start = m.end();
    let Some(child_end) = find_matching_close(li_inner, child_start, "ol") else {
        return (li_inner.to_string(), Vec::new());
    };
    let child_inner = &li_inner[child_start..child_end];
    let children = parse_ol(child_inner, depth + 1);
    (head, children)
}

/// 从 li 头部提取第一个 a/span 的文本与 href
fn extract_title_and_href(head: &str) -> (Option<String>, Option<String>) {
    // 优先取 <a>
    if let Some((text, href)) = find_first_anchor(head) {
        return (normalize_title(&text), href);
    }
    // 回退取 <span>
    if let Some(text) = find_first_span(head) {
        return (normalize_title(&text), None);
    }
    // 再退一步取整体文本
    let fallback = strip_tags(head);
    (normalize_title(&fallback), None)
}

/// 匹配头部首个 <a> 的 href 及内部文本
fn find_first_anchor(head: &str) -> Option<(String, Option<String>)> {
    let open_re = Regex::new(r#"(?is)<a\b([^>]*)>"#).ok()?;
    let caps = open_re.captures(head)?;
    let attrs = caps.get(1)?.as_str();
    let open_m = caps.get(0)?;
    let start = open_m.end();
    let end = find_matching_close(head, start, "a")?;
    let inner = &head[start..end];
    let text = strip_tags(inner);
    let href = extract_attr(attrs, "href");
    Some((text, href))
}

/// 匹配头部首个 <span> 的内部文本
fn find_first_span(head: &str) -> Option<String> {
    let open_re = Regex::new(r#"(?is)<span\b[^>]*>"#).ok()?;
    let m = open_re.find(head)?;
    let start = m.end();
    let end = find_matching_close(head, start, "span")?;
    Some(strip_tags(&head[start..end]))
}

/// 去除 HTML 标签，仅保留纯文本
fn strip_tags(text: &str) -> String {
    let re = Regex::new(r"(?is)<[^>]+>").unwrap();
    re.replace_all(text, "").to_string()
}

/// 规范化标题：合并空白、解码常见实体、空值返回 None
fn normalize_title(raw: &str) -> Option<String> {
    let decoded = decode_basic_entities(raw);
    let collapsed = decoded
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if collapsed.is_empty() {
        None
    } else {
        Some(collapsed)
    }
}

/// 解码基础 HTML 实体，覆盖常见目录文本场景
fn decode_basic_entities(text: &str) -> String {
    let mut out = text.to_string();
    out = out.replace("&amp;", "&");
    out = out.replace("&lt;", "<");
    out = out.replace("&gt;", ">");
    out = out.replace("&quot;", "\"");
    out = out.replace("&apos;", "'");
    out = out.replace("&nbsp;", " ");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_basic_two_level() {
        let nav = r#"
        <html><body>
        <nav epub:type="toc" id="toc">
          <h1>Table of Contents</h1>
          <ol>
            <li><a href="chap01.xhtml">第一章</a></li>
            <li>
              <a href="chap02.xhtml">第二章</a>
              <ol>
                <li><a href="chap02.xhtml#s1">第一节</a></li>
                <li><a href="chap02.xhtml#s2">第二节</a></li>
              </ol>
            </li>
          </ol>
        </nav>
        </body></html>
        "#;
        let entries = parse_nav_xhtml(nav);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].title.as_deref(), Some("第一章"));
        assert_eq!(entries[0].href.as_deref(), Some("chap01.xhtml"));
        assert_eq!(entries[1].children.len(), 2);
        assert_eq!(entries[1].children[1].href.as_deref(), Some("chap02.xhtml#s2"));
    }

    #[test]
    fn test_span_group() {
        let nav = r#"
        <nav epub:type="toc">
          <ol>
            <li><span>Part I</span>
              <ol><li><a href="a.xhtml">A</a></li></ol>
            </li>
          </ol>
        </nav>
        "#;
        let entries = parse_nav_xhtml(nav);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].title.as_deref(), Some("Part I"));
        assert!(entries[0].href.is_none());
        assert_eq!(entries[0].children.len(), 1);
        assert_eq!(entries[0].children[0].href.as_deref(), Some("a.xhtml"));
    }

    #[test]
    fn test_percent_decode() {
        let decoded = percent_decode_utf8("%E7%AC%AC%E4%B8%80%E7%AB%A0.xhtml");
        assert_eq!(decoded, "第一章.xhtml");
    }

    #[test]
    fn test_resolve_href_with_anchor() {
        let resolved = resolve_href_to_package("OEBPS/Text", "../Images/x.png#frag");
        assert_eq!(resolved, "OEBPS/Images/x.png#frag");
    }

    #[test]
    fn test_skip_non_toc_nav() {
        let nav = r#"
        <nav epub:type="landmarks"><ol><li><a href="a.xhtml">L</a></li></ol></nav>
        <nav epub:type="toc"><ol><li><a href="b.xhtml">B</a></li></ol></nav>
        "#;
        let entries = parse_nav_xhtml(nav);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].href.as_deref(), Some("b.xhtml"));
    }

    #[test]
    fn test_malformed_returns_empty() {
        let nav = "not even close to xhtml";
        let entries = parse_nav_xhtml(nav);
        assert!(entries.is_empty());
    }

    #[test]
    fn test_spine_fallback_toc() {
        let spine = vec!["OEBPS/ch1.xhtml".to_string(), "OEBPS/ch2.xhtml".to_string()];
        let toc = build_spine_fallback_toc(&spine);
        assert_eq!(toc.len(), 2);
        assert_eq!(toc[0].title.as_deref(), Some("ch1"));
        assert_eq!(toc[0].location.as_deref(), Some("OEBPS/ch1.xhtml"));
    }
}

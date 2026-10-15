use std::collections::HashSet;
use std::path::Path;

use epub::doc::{EpubDoc, NavPoint};
use regex::Regex;
use serde::Serialize;

use super::{BookInfo, TocItem};

#[derive(Debug, Serialize)]
pub struct EpubInspectResult {
    pub book_info: BookInfo,
}

#[derive(Debug)]
pub struct PreparedSection {
    pub index: u32,
    pub path: String,
    pub html: String,
    pub styles: Vec<String>,
    pub resource_refs: Vec<String>,
}

#[derive(Debug)]
pub struct PreparedResource {
    pub path: String,
    pub data: Vec<u8>,
    pub mime_type: String,
}

#[derive(Debug)]
pub struct EpubPreparedBook {
    pub book_info: BookInfo,
    pub toc: Vec<TocItem>,
    pub section_count: u32,
    pub spine: Vec<String>,
/// 不参与阅读顺序的章节下标（EPUB3 导航文档等）。
    /// 采用「标记而非删除」策略：`spine`/`section_count`/章节索引保持稳定，
    /// 既有章节缓存与阅读进度不受影响。
    pub hidden_sections: Vec<u32>,
    pub sections: Vec<PreparedSection>,
    pub resources: Vec<PreparedResource>,
}

fn extract_metadata<R: std::io::Read + std::io::Seek>(
    doc: &mut EpubDoc<R>,
) -> (Option<String>, Option<String>, Option<String>, Option<String>, Option<String>) {
    let title = doc.mdata("title").map(|m| m.value.clone());
    let author = doc.mdata("creator").map(|m| m.value.clone());
    let description = doc
        .mdata("description")
        .or_else(|| doc.mdata("dc:description"))
        .map(|m| m.value.clone());
    let publisher = doc
        .mdata("publisher")
        .or_else(|| doc.mdata("dc:publisher"))
        .map(|m| m.value.clone());
    let language = doc
        .mdata("language")
        .or_else(|| doc.mdata("dc:language"))
        .map(|m| m.value.clone());

    (title, author, description, publisher, language)
}

fn estimate_page_count<R: std::io::Read + std::io::Seek>(doc: &EpubDoc<R>) -> i32 {
    let chapters = doc.get_num_chapters() as i32;
    if chapters <= 0 {
        1
    } else {
        chapters
    }
}

/// 将图片二进制数据编码为 data URI 格式
fn encode_cover_to_data_uri(bytes: &[u8], mime: &str) -> Option<String> {
    use base64::{engine::general_purpose, Engine as _};

    if bytes.is_empty() {
        return None;
    }
    let encoded = general_purpose::STANDARD.encode(bytes);
    Some(format!("data:{};base64,{}", mime, encoded))
}

/// 从 EPUB 资源列表中查找封面图片
/// 优先匹配 id 或路径含 "cover" 的图片资源，其次使用首个图片资源
fn find_cover_from_resources<R: std::io::Read + std::io::Seek>(
    doc: &mut EpubDoc<R>,
) -> Option<String> {
    let mut cover_candidate: Option<(String, String)> = None;
    let mut first_image: Option<(String, String)> = None;

    for (id, item) in doc.resources.iter() {
        let mime = &item.mime;
        if !mime.starts_with("image/") {
            continue;
        }

        let path_str = item.path.to_string_lossy().to_string();
        let id_lower = id.to_lowercase();
        let path_lower = path_str.to_lowercase();
        if id_lower.contains("cover") || path_lower.contains("cover") {
            cover_candidate = Some((path_str, mime.clone()));
            break;
        }

        if first_image.is_none() {
            first_image = Some((path_str, mime.clone()));
        }
    }

    let (res_path, mime) = cover_candidate.or(first_image)?;
    let data = doc.get_resource_by_path(&res_path)?;
    encode_cover_to_data_uri(&data, &mime)
}

fn extract_cover_data<R: std::io::Read + std::io::Seek>(
    doc: &mut EpubDoc<R>,
) -> Option<String> {
    // 优先使用 epub crate 内置的封面提取
    if let Some((bytes, mime)) = doc.get_cover() {
        if let Some(uri) = encode_cover_to_data_uri(&bytes, &mime) {
            return Some(uri);
        }
    }

    println!("[EPUB] get_cover() 未找到封面，尝试从资源列表中查找");

    // 回退：从 manifest 资源中查找封面图片
    find_cover_from_resources(doc)
}

pub fn inspect_epub(file_path: &str) -> Result<EpubInspectResult, String> {
    let path = Path::new(file_path);
    if !path.exists() {
        return Err(format!("EPUB 文件不存在: {}", file_path));
    }

    let mut doc = EpubDoc::new(file_path).map_err(|e| format!("打开 EPUB 失败: {}", e))?;

    let (title, author, description, publisher, language) = extract_metadata(&mut doc);
    let page_count = estimate_page_count(&doc);
    let cover_image = extract_cover_data(&mut doc);

    let book_info = BookInfo {
        title,
        author,
        description,
        publisher,
        language,
        page_count,
        format: "epub".to_string(),
        cover_image,
    };

    Ok(EpubInspectResult { book_info })
}

fn convert_toc_level(navpoints: &[NavPoint], level: i32) -> Vec<TocItem> {
    navpoints
        .iter()
        .map(|np| {
            let title = if np.label.is_empty() {
                None
            } else {
                Some(np.label.clone())
            };

            let location = Some(np.content.to_string_lossy().to_string());

            let children = convert_toc_level(&np.children, level + 1);

            TocItem {
                title,
                location,
                level,
                children,
            }
        })
        .collect()
}

fn convert_toc(navpoints: &[NavPoint]) -> Vec<TocItem> {
    convert_toc_level(navpoints, 0)
}

/// 按优先级选择目录来源：EPUB3 nav → NCX。
/// 环境变量 GOREAD_EPUB_DISABLE_NAV=1 可临时关闭 nav 分支以便故障回退。
fn resolve_toc<R: std::io::Read + std::io::Seek>(doc: &mut EpubDoc<R>) -> Vec<TocItem> {
    let nav_disabled = std::env::var("GOREAD_EPUB_DISABLE_NAV")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);

    if !nav_disabled {
        if let Some(nav_toc) = super::nav::parse_nav_toc(doc) {
            if !nav_toc.is_empty() {
                return nav_toc;
            }
        }
    }

    convert_toc(&doc.toc)
}

/// 从章节 HTML 中提取内联 <style> 标签和外链 CSS 引用的样式内容，同时收集 CSS 中引用的资源路径
fn extract_styles_from_html<R: std::io::Read + std::io::Seek>(
    doc: &mut EpubDoc<R>,
    html: &str,
    url_re: &Regex,
) -> (Vec<String>, Vec<String>) {
    let mut styles = Vec::new();
    let mut css_resource_paths = Vec::new();

    // 提取 <style>...</style> 内联样式，将 epub:// 路径转为占位符
    let style_re = Regex::new(r"(?is)<style[^>]*>(.*?)</style>").unwrap();
    let epub_url_re = Regex::new(r#"url\(\s*["']?epub://([^"')]+?)["']?\s*\)"#).unwrap();
    for caps in style_re.captures_iter(html) {
        if let Some(m) = caps.get(1) {
            let css = m.as_str().trim();
            if !css.is_empty() {
                // 收集内联样式中的资源路径
                for c in epub_url_re.captures_iter(css) {
                    css_resource_paths.push(c[1].to_string());
                }
                let fixed = epub_url_re.replace_all(css, |c: &regex::Captures| {
                    format!("url(\"__EPUB_RES__:{}\")", &c[1])
                });
                styles.push(fixed.into_owned());
            }
        }
    }

    // 提取 <link rel="stylesheet" href="epub://path"> 外链样式
    // href 和 rel 属性顺序不固定，需要两种正则覆盖
    let link_patterns = [
        Regex::new(r#"(?i)<link[^>]+rel=["']stylesheet["'][^>]+href=["']epub://([^"']+)["'][^>]*/?>"#).unwrap(),
        Regex::new(r#"(?i)<link[^>]+href=["']epub://([^"']+)["'][^>]+rel=["']stylesheet["'][^>]*/?>"#).unwrap(),
    ];

    let mut seen_css_paths: HashSet<String> = HashSet::new();
    for re in &link_patterns {
        for caps in re.captures_iter(html) {
            if let Some(m) = caps.get(1) {
                let css_path = m.as_str().to_string();
                if seen_css_paths.contains(&css_path) {
                    continue;
                }
                seen_css_paths.insert(css_path.clone());
                if let Some(data) = doc.get_resource_by_path(&css_path) {
                    if let Ok(css_text) = String::from_utf8(data) {
                        // 修复 CSS 文件内部 url() 中的相对路径，使用占位符格式
                        let fixed = url_re.replace_all(&css_text, |c: &regex::Captures| {
                            let val = c[1].trim();
                            if val.starts_with("data:") || val.starts_with("http://")
                                || val.starts_with("https://") || val.starts_with('#')
                            {
                                return c[0].to_string();
                            }
                            let resolved = resolve_relative_path(&css_path, val);
                            css_resource_paths.push(resolved.clone());
                            format!("url(\"__EPUB_RES__:{}\")", resolved)
                        });
                        let trimmed = fixed.trim();
                        if !trimmed.is_empty() {
                            styles.push(trimmed.to_string());
                        }
                    }
                }
            }
        }
    }

    (styles, css_resource_paths)
}

/// XML 解析失败时，直接从 zip 读取原始内容作为回退
fn try_raw_fallback<R: std::io::Read + std::io::Seek>(
    doc: &mut EpubDoc<R>,
    section_path: &str,
) -> Option<String> {
    let bytes = doc.get_resource_by_path(section_path)?;
    String::from_utf8(bytes).ok()
}

/// 章节所在目录（不含文件名，无目录时为空字符串）
fn section_dir(section_path: &str) -> &str {
    match section_path.rfind('/') {
        Some(pos) => &section_path[..pos],
        None => "",
    }
}

/// 将 epub crate 生成的「同文档锚点」URI 归一为纯锚点。
///
/// crate 的 `build_epub_uri` 不区分纯锚点，会把 `href="#fn1"` 改写成
/// `epub://<章节目录>/#fn1`，导致前端无法识别为章内跳转（脚注/交叉引用点击失效）。
fn normalize_same_document_anchors(html: &str, section_path: &str) -> String {
    let base_dir = section_dir(section_path);
    let anchor_re = match Regex::new(r#"(?i)(href|src)=["']epub://([^"'#]*)#([^"']*)["']"#) {
        Ok(re) => re,
        Err(_) => return html.to_string(),
    };

    anchor_re
        .replace_all(html, |caps: &regex::Captures| {
            let attr = &caps[1];
            let path_part = &caps[2];
            let fragment = &caps[3];
            // 仅当归一目标就是当前文档自身时改写：路径部分为空，或等于当前章节目录
            let is_same_document = path_part.is_empty()
                || (base_dir.is_empty() && path_part == "/")
                || path_part.trim_end_matches('/') == base_dir;
            if is_same_document {
                format!("{}=\"#{}\"", attr, fragment)
            } else {
                caps[0].to_string()
            }
        })
        .into_owned()
}

/// 判断 epub:// URI 是否为纯锚点（无资源路径），这类 URI 不是资源引用
fn is_fragment_only_uri(path: &str) -> bool {
    path.starts_with('#')
}

/// 基于章节路径将相对资源路径解析为 EPUB 内绝对路径
fn resolve_relative_path(section_path: &str, relative: &str) -> String {
    // 取章节所在目录
    let base_dir = section_dir(section_path);

    let mut parts: Vec<&str> = if base_dir.is_empty() {
        Vec::new()
    } else {
        base_dir.split('/').collect()
    };

    for seg in relative.split('/') {
        match seg {
            ".." => { parts.pop(); }
            "." | "" => {}
            _ => parts.push(seg),
        }
    }

    parts.join("/")
}

/// 收集单个资源：去重读取二进制数据并加入资源列表
fn collect_resource<R: std::io::Read + std::io::Seek>(
    doc: &mut EpubDoc<R>,
    path: &str,
    seen: &mut HashSet<String>,
    resources: &mut Vec<PreparedResource>,
    refs: &mut Vec<String>,
) {
    if !seen.contains(path) {
        if let Some(data) = doc.get_resource_by_path(path) {
            let mime = doc
                .get_resource_mime_by_path(path)
                .unwrap_or_else(|| "application/octet-stream".to_string());
            resources.push(PreparedResource {
                path: path.to_string(),
                data,
                mime_type: mime,
            });
        }
        seen.insert(path.to_string());
    }
    if !refs.contains(&path.to_string()) {
        refs.push(path.to_string());
    }
}

fn extract_sections_and_resources<R: std::io::Read + std::io::Seek>(
    doc: &mut EpubDoc<R>,
) -> Result<(Vec<PreparedSection>, Vec<String>, Vec<PreparedResource>, u32), String> {
    let total = doc.get_num_chapters() as u32;

    let re =
        Regex::new(r#"epub://([^"')\s>]+)"#).map_err(|e| format!("正则初始化失败: {}", e))?;
    let attr_re =
        Regex::new(r#"(?i)(src|href)=["']([^"']+)["']"#).map_err(|e| format!("正则初始化失败: {}", e))?;
    // 匹配 CSS url() 中的资源路径
    let url_re =
        Regex::new(r#"url\(\s*["']?([^"')]+?)["']?\s*\)"#).map_err(|e| format!("正则初始化失败: {}", e))?;

    let mut sections = Vec::with_capacity(total as usize);
    let mut spine = Vec::with_capacity(total as usize);
    let mut resources = Vec::new();
    let mut seen_resources: HashSet<String> = HashSet::new();

    for index in 0..total {
        if !doc.set_current_page(index as usize) {
            println!("[EPUB] 设置章节 {} 失败，跳过", index);
            continue;
        }

        let section_path = doc
            .get_current_path()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        spine.push(section_path.clone());

        // 优先用 epub crate 的 XML 解析获取内容（会做资源路径替换），
        // 失败时回退到直接读取原始字节（跳过 XML 解析）
        let (html_raw, used_epub_uris) = match doc.get_current_with_epub_uris() {
            Ok(bytes) => match String::from_utf8(bytes) {
                Ok(s) => (s, true),
                Err(_) => match try_raw_fallback(doc, &section_path) {
                    Some(s) => (s, false),
                    None => continue,
                },
            },
            Err(e) => {
                println!("[EPUB] 章节 {} XML 解析失败，尝试原始读取: {}", index, e);
                match try_raw_fallback(doc, &section_path) {
                    Some(s) => (s, false),
                    None => continue,
                }
            }
        };

        // crate 会把同文档锚点改写成 epub://<章节目录>/#x，先归一回纯锚点
        let html_raw = if used_epub_uris {
            normalize_same_document_anchors(&html_raw, &section_path)
        } else {
            html_raw
        };

        let mut resource_refs: Vec<String> = Vec::new();

        // epub crate 已做 epub:// 前缀替换时直接匹配；
        // 原始回退模式下匹配相对路径（src/href 属性值）
        let refs_source: std::borrow::Cow<str> = if used_epub_uris {
            std::borrow::Cow::Borrowed(&html_raw)
        } else {
            // 基于章节目录解析相对路径并注入 epub:// 前缀
            let sp = &section_path;
            std::borrow::Cow::Owned(
                attr_re.replace_all(&html_raw, |caps: &regex::Captures| {
                    let attr = &caps[1];
                    let val = &caps[2];
                    if val.starts_with("http://") || val.starts_with("https://")
                        || val.starts_with("data:") || val.starts_with('#')
                        || val.starts_with("mailto:")
                    {
                        return caps[0].to_string();
                    }
                    let resolved = resolve_relative_path(sp, val);
                    format!("{}=\"epub://{}\"" , attr, resolved)
                }).into_owned()
            )
        };

        // 处理 CSS url() 中的相对资源路径（两种模式都需要）
        let refs_source = {
            let sp = &section_path;
            let replaced = url_re.replace_all(&refs_source, |caps: &regex::Captures| {
                let val = caps[1].trim();
                if val.starts_with("epub://") || val.starts_with("http://")
                    || val.starts_with("https://") || val.starts_with("data:")
                    || val.starts_with('#')
                {
                    return caps[0].to_string();
                }
                let resolved = resolve_relative_path(sp, val);
                format!("url(\"epub://{}\")", resolved)
            });
            replaced.into_owned()
        };

        // 收集 HTML 中 epub:// 引用的资源（纯锚点不是资源，跳过避免污染占位符
        for caps in re.captures_iter(&refs_source) {
            if let Some(m) = caps.get(1) {
                let path = m.as_str();
                if is_fragment_only_uri(path) {
                    continue;
                }
                collect_resource(doc, path, &mut seen_resources, &mut resources, &mut resource_refs);
            }
        }

        let html = re
            .replace_all(&refs_source, |caps: &regex::Captures| {
                let path = &caps[1];
                if is_fragment_only_uri(path) {
                    return caps[0].to_string();
                }
                format!("__EPUB_RES__:{}", path)
            })
            .into_owned();

        // 提取 CSS 样式（内联 <style> 和外链 <link>），并收集 CSS 中引用的资源
        let (styles, css_resource_paths) = extract_styles_from_html(doc, &refs_source, &url_re);
        for path in css_resource_paths {
            collect_resource(doc, &path, &mut seen_resources, &mut resources, &mut resource_refs);
        }

        sections.push(PreparedSection {
            index,
            path: section_path,
            html,
            styles,
            resource_refs,
        });
    }

    Ok((sections, spine, resources, total))
}

pub fn prepare_book(file_path: &str) -> Result<EpubPreparedBook, String> {
    let path = Path::new(file_path);
    if !path.exists() {
        return Err(format!("EPUB 文件不存在: {}", file_path));
    }

    let mut doc = EpubDoc::new(file_path).map_err(|e| format!("打开 EPUB 失败: {}", e))?;

    let (title, author, description, publisher, language) = extract_metadata(&mut doc);
    let page_count = estimate_page_count(&doc);
    let cover_image = extract_cover_data(&mut doc);

    let book_info = BookInfo {
        title,
        author,
        description,
        publisher,
        language,
        page_count,
        format: "epub".to_string(),
        cover_image,
    };

    let toc = resolve_toc(&mut doc);

    let (sections, spine, resources, section_count) = extract_sections_and_resources(&mut doc)?;

    // EPUB3 导航文档不参与阅读顺序（保持原始下标，仅标记隐藏）
    let hidden_sections = super::nav::resolve_hidden_sections(&mut doc);

    // 若 nav/ncx 均无目录，基于 spine 生成伪目录作为最后兜底，保证目录抽屉可用
    let toc = if toc.is_empty() {
        super::nav::build_spine_fallback_toc(&spine)
    } else {
        toc
    };

    Ok(EpubPreparedBook {
        book_info,
        toc,
        section_count,
        spine,
        hidden_sections,
        sections,
        resources,
    })
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_section_dir() {
        assert_eq!(section_dir("OEBPS/Text/ch1.xhtml"), "OEBPS/Text");
        assert_eq!(section_dir("ch1.xhtml"), "");
    }

    #[test]
    fn test_normalize_same_document_anchors() {
        // crate 会把纯锚点拼到章节目录上，需要归一
        let html = r#"<p><a href="epub://OEBPS/#fn1">1</a><a href="epub://#fn2">2</a></p>"#;
        let fixed = normalize_same_document_anchors(html, "OEBPS/ch1.xhtml");
        assert!(fixed.contains(r##"href="#fn1""##));
        assert!(fixed.contains(r##"href="#fn2""##));
        assert!(!fixed.contains("epub://"));
    }

    #[test]
    fn test_normalize_keeps_cross_document_links() {
        // 跨文档链接（含同目录其它文件）必须保持原样
        let html = r#"<a href="epub://OEBPS/ch2.xhtml#sec">2</a><img src="epub://OEBPS/img/a.png"/>"#;
        let fixed = normalize_same_document_anchors(html, "OEBPS/ch1.xhtml");
        assert_eq!(fixed, html);
    }

    #[test]
    fn test_normalize_keeps_subdir_cross_document_links() {
        // 不同目录的文件不能因为“目录不匹配”被误改，同时子目录自身锚点要归一
        let html = r#"<a href="epub://OEBPS/Text/ch3.xhtml#x">3</a><a href="epub://OEBPS/Text/#y">y</a>"#;
        let fixed = normalize_same_document_anchors(html, "OEBPS/Text/ch2.xhtml");
        assert!(fixed.contains(r##"href="epub://OEBPS/Text/ch3.xhtml#x""##));
        assert!(fixed.contains(r##"href="#y""##));
    }

    #[test]
    fn test_is_fragment_only_uri() {
        assert!(is_fragment_only_uri("#fn1"));
        assert!(!is_fragment_only_uri("OEBPS/ch1.xhtml#fn1"));
        assert!(!is_fragment_only_uri("OEBPS/img/a.png"));
    }

    // ==================== 端到端：导航文档隐藏 + 锚点归一 ====================

    /// 计算 ZIP 校验用 CRC32（测试构造最小 EPUB 时使用，避免引入额外依赖）
    fn crc32(data: &[u8]) -> u32 {
        let mut crc = 0xFFFF_FFFFu32;
        for byte in data {
            let mut c = (crc ^ *byte as u32) & 0xFF;
            for _ in 0..8 {
                c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
            }
            crc = c ^ (crc >> 8);
        }
        crc ^ 0xFFFF_FFFF
    }

    fn push_u16(buf: &mut Vec<u8>, value: u16) {
        buf.extend_from_slice(&value.to_le_bytes());
    }

    fn push_u32(buf: &mut Vec<u8>, value: u32) {
        buf.extend_from_slice(&value.to_le_bytes());
    }

    /// 构造最小 EPUB（全部 stored 不压缩），仅用于测试
    fn build_epub_bytes(entries: &[(&str, &str)]) -> Vec<u8> {
        let mut out: Vec<u8> = Vec::new();
        let mut central: Vec<(u32, u32, u32, String)> = Vec::new();

        for (name, content) in entries {
            let offset = out.len() as u32;
            let data = content.as_bytes();
            let crc = crc32(data);

            push_u32(&mut out, 0x0403_4B50); // 本地文件头
            push_u16(&mut out, 20);
            push_u16(&mut out, 0);
            push_u16(&mut out, 0); // stored
            push_u16(&mut out, 0);
            push_u16(&mut out, 0);
            push_u32(&mut out, crc);
            push_u32(&mut out, data.len() as u32);
            push_u32(&mut out, data.len() as u32);
            push_u16(&mut out, name.len() as u16);
            push_u16(&mut out, 0);
            out.extend_from_slice(name.as_bytes());
            out.extend_from_slice(data);

            central.push((crc, data.len() as u32, offset, (*name).to_string()));
        }

        let central_offset = out.len() as u32;
        for (crc, size, offset, name) in &central {
            push_u32(&mut out, 0x0201_4B50); // 中央目录头
            push_u16(&mut out, 20);
            push_u16(&mut out, 20);
            push_u16(&mut out, 0);
            push_u16(&mut out, 0);
            push_u16(&mut out, 0);
            push_u16(&mut out, 0);
            push_u32(&mut out, *crc);
            push_u32(&mut out, *size);
            push_u32(&mut out, *size);
            push_u16(&mut out, name.len() as u16);
            push_u16(&mut out, 0);
            push_u16(&mut out, 0);
            push_u16(&mut out, 0);
            push_u16(&mut out, 0);
            push_u32(&mut out, 0);
            push_u32(&mut out, *offset);
            out.extend_from_slice(name.as_bytes());
        }
        let central_size = out.len() as u32 - central_offset;

        push_u32(&mut out, 0x0605_4B50); // EOCD
        push_u16(&mut out, 0);
        push_u16(&mut out, 0);
        push_u16(&mut out, central.len() as u16);
        push_u16(&mut out, central.len() as u16);
        push_u32(&mut out, central_size);
        push_u32(&mut out, central_offset);
        push_u16(&mut out, 0);
        out
    }

    fn write_temp_epub(tag: &str, entries: &[(&str, &str)]) -> std::path::PathBuf {
        let file_path = std::env::temp_dir().join(format!(
            "goread_{}_{}.epub",
            tag,
            std::process::id()
        ));
        std::fs::write(&file_path, build_epub_bytes(entries)).expect("写入测试 EPUB 失败");
        file_path
    }

    fn container_xml() -> &'static str {
        r#"<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>"#
    }

    fn opf_xml(epub_version: &str, nav_in_spine: bool, nav_linear: &str) -> String {
        let nav_itemref = if nav_in_spine {
            format!(r#"<itemref idref="nav" linear="{}"/>"#, nav_linear)
        } else {
            String::new()
        };
        format!(
            r#"<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="{version}" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:test-{version}</dc:identifier>
    <dc:title>Probe</dc:title>
    <dc:language>zh</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>{nav_itemref}<itemref idref="ch1"/></spine>
</package>"#,
            version = epub_version,
            nav_itemref = nav_itemref,
        )
    }

    fn nav_xhtml() -> &'static str {
        r#"<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>目录</title></head>
<body><nav epub:type="toc" id="toc"><ol><li><a href="ch1.xhtml">第一章</a></li></ol></nav></body>
</html>"#
    }

    fn ch1_xhtml() -> &'static str {
        r##"<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>第一章</title></head>
<body>
<h1>第一章</h1>
<p>正文<a epub:type="noteref" href="#fn1">1</a>继续。</p>
<aside epub:type="footnote" id="fn1"><p>脚注内容</p></aside>
</body>
</html>"##
    }

    #[test]
    fn test_prepare_book_marks_nav_hidden_and_keeps_index_stable() {
        let opf = opf_xml("3.0", true, "yes");
        let path = write_temp_epub(
            "epub3_nav_spine",
            &[
                ("mimetype", "application/epub+zip"),
                ("META-INF/container.xml", container_xml()),
                ("OEBPS/content.opf", &opf),
                ("OEBPS/nav.xhtml", nav_xhtml()),
                ("OEBPS/ch1.xhtml", ch1_xhtml()),
            ],
        );

        let prepared = prepare_book(path.to_str().unwrap()).expect("解析 EPUB3 失败");
        let _ = std::fs::remove_file(&path);

        // 索引保持稳定：章节数与 spine 完整保留导航文档
        assert_eq!(prepared.section_count, 2);
        assert_eq!(
            prepared.spine,
            vec!["OEBPS/nav.xhtml".to_string(), "OEBPS/ch1.xhtml".to_string()]
        );
        assert_eq!(prepared.hidden_sections, vec![0]);
        assert_eq!(prepared.sections.len(), 2);

        // 同文档锚点被归一，且不再作为资源引用污染 resource_refs
        let ch1 = prepared
            .sections
            .iter()
            .find(|s| s.path.ends_with("ch1.xhtml"))
            .expect("缺少 ch1 章节");
        assert!(ch1.html.contains(r##"href="#fn1""##), "锚点未归一: {}", ch1.html);
        assert!(!ch1.html.contains("__EPUB_RES__:OEBPS/#fn1"), "锚点被误当资源");
        assert!(
            !ch1.resource_refs.iter().any(|r| r.contains('#')),
            "resource_refs 含锚点垃圾: {:?}",
            ch1.resource_refs
        );
    }

    #[test]
    fn test_prepare_book_epub2_never_hides_sections() {
        // EPUB2：即使 spine 里存在名为 nav.xhtml 且 linear="no" 的项，也不能隐藏
        let opf = opf_xml("2.0", true, "no");
        let path = write_temp_epub(
            "epub2_guard",
            &[
                ("mimetype", "application/epub+zip"),
                ("META-INF/container.xml", container_xml()),
                ("OEBPS/content.opf", &opf),
                ("OEBPS/nav.xhtml", nav_xhtml()),
                ("OEBPS/ch1.xhtml", ch1_xhtml()),
            ],
        );

        let prepared = prepare_book(path.to_str().unwrap()).expect("解析 EPUB2 失败");
        let _ = std::fs::remove_file(&path);

        assert_eq!(prepared.section_count, 2);
        assert!(
            prepared.hidden_sections.is_empty(),
            "EPUB2 不应隐藏任何章节: {:?}",
            prepared.hidden_sections
        );
    }

    #[test]
    fn test_prepare_book_heuristic_nav_without_properties() {
        // OPF 未声明 properties="nav" 时，文件名启发式 + linear="no" 仍应识别为导航文档
        let opf = r#"<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:test-heuristic</dc:identifier>
    <dc:title>Probe</dc:title>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="nav" linear="no"/><itemref idref="ch1"/></spine>
</package>"#;
        let path = write_temp_epub(
            "epub3_heuristic",
            &[
                ("mimetype", "application/epub+zip"),
                ("META-INF/container.xml", container_xml()),
                ("OEBPS/content.opf", opf),
                ("OEBPS/nav.xhtml", nav_xhtml()),
                ("OEBPS/ch1.xhtml", ch1_xhtml()),
            ],
        );

        let prepared = prepare_book(path.to_str().unwrap()).expect("解析 EPUB3 失败");
        let _ = std::fs::remove_file(&path);

        assert_eq!(prepared.section_count, 2);
        assert_eq!(prepared.hidden_sections, vec![0]);
    }

    #[test]
    fn test_prepare_book_nav_outside_spine_hides_nothing() {
        let opf = opf_xml("3.0", false, "yes");
        let path = write_temp_epub(
            "epub3_nav_outside",
            &[
                ("mimetype", "application/epub+zip"),
                ("META-INF/container.xml", container_xml()),
                ("OEBPS/content.opf", &opf),
                ("OEBPS/nav.xhtml", nav_xhtml()),
                ("OEBPS/ch1.xhtml", ch1_xhtml()),
            ],
        );

        let prepared = prepare_book(path.to_str().unwrap()).expect("解析 EPUB3 失败");
        let _ = std::fs::remove_file(&path);

        assert_eq!(prepared.section_count, 1);
        assert_eq!(prepared.spine, vec!["OEBPS/ch1.xhtml".to_string()]);
        assert!(prepared.hidden_sections.is_empty());
    }
}

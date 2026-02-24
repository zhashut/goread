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

/// 基于章节路径将相对资源路径解析为 EPUB 内绝对路径
fn resolve_relative_path(section_path: &str, relative: &str) -> String {
    // 取章节所在目录
    let base_dir = match section_path.rfind('/') {
        Some(pos) => &section_path[..pos],
        None => "",
    };

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

        // 收集 HTML 中 epub:// 引用的资源
        for caps in re.captures_iter(&refs_source) {
            if let Some(m) = caps.get(1) {
                let path = m.as_str().to_string();
                collect_resource(doc, &path, &mut seen_resources, &mut resources, &mut resource_refs);
            }
        }

        let html = re
            .replace_all(&refs_source, |caps: &regex::Captures| {
                format!("__EPUB_RES__:{}", &caps[1])
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

    let toc = convert_toc(&doc.toc);

    let (sections, spine, resources, section_count) = extract_sections_and_resources(&mut doc)?;

    Ok(EpubPreparedBook {
        book_info,
        toc,
        section_count,
        spine,
        sections,
        resources,
    })
}
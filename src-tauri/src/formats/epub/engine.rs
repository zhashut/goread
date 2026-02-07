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

fn extract_cover_data<R: std::io::Read + std::io::Seek>(
    doc: &mut EpubDoc<R>,
) -> Option<String> {
    use base64::{engine::general_purpose, Engine as _};

    let (bytes, mime) = match doc.get_cover() {
        Some((bytes, mime)) if !bytes.is_empty() => (bytes, mime),
        _ => return None,
    };

    let encoded = general_purpose::STANDARD.encode(&bytes);
    Some(format!("data:{};base64,{}", mime, encoded))
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

fn extract_sections_and_resources<R: std::io::Read + std::io::Seek>(
    doc: &mut EpubDoc<R>,
) -> Result<(Vec<PreparedSection>, Vec<String>, Vec<PreparedResource>, u32), String> {
    let total = doc.get_num_chapters() as u32;

    let re =
        Regex::new(r#"epub://([^"')\s>]+)"#).map_err(|e| format!("正则表达式初始化失败: {}", e))?;

    let mut sections = Vec::with_capacity(total as usize);
    let mut spine = Vec::with_capacity(total as usize);
    let mut resources = Vec::new();
    let mut seen_resources: HashSet<String> = HashSet::new();

    for index in 0..total {
        if !doc.set_current_page(index as usize) {
            return Err(format!("设置章节 {} 失败", index));
        }

        let section_path = doc
            .get_current_path()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        spine.push(section_path.clone());

        let bytes = doc
            .get_current_with_epub_uris()
            .map_err(|e| format!("读取章节 {} 内容失败: {}", index, e))?;

        let html_raw =
            String::from_utf8(bytes).map_err(|e| format!("章节 {} 不是有效的 UTF-8: {}", index, e))?;

        let mut resource_refs: Vec<String> = Vec::new();

        for caps in re.captures_iter(&html_raw) {
            if let Some(m) = caps.get(1) {
                let path = m.as_str().to_string();
                if !seen_resources.contains(&path) {
                    if let Some(data) = doc.get_resource_by_path(&path) {
                        let mime = doc
                            .get_resource_mime_by_path(&path)
                            .unwrap_or_else(|| "application/octet-stream".to_string());

                        resources.push(PreparedResource {
                            path: path.clone(),
                            data,
                            mime_type: mime,
                        });
                    }
                    seen_resources.insert(path.clone());
                }
                if !resource_refs.contains(&path) {
                    resource_refs.push(path);
                }
            }
        }

        let html = re
            .replace_all(&html_raw, |caps: &regex::Captures| {
                format!("__EPUB_RES__:{}", &caps[1])
            })
            .into_owned();

        sections.push(PreparedSection {
            index,
            path: section_path,
            html,
            styles: Vec::new(),
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

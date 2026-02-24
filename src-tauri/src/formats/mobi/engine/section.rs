//! 章节拆分与目录提取
//! 基于 pagebreak 的字节级拆分、目录提取、TOC 层级推断、降级拆分策略

use std::collections::HashMap;

use encoding_rs::Encoding;

use super::patterns::{
    ANCHOR_BYTES_RE, BODY_CLOSE_RE, BODY_OPEN_RE, CHAPTER_LEVEL_RE, CHAPTER_PATTERN_RE,
    FIRST_P_RE, HEADING_POS_RE, HEADING_RE, PART_LEVEL_RE, REF_TOC_ALT_BYTES_RE,
    REF_TOC_BYTES_RE, SPLIT_BYTES_RE,
};
use super::pdb::align_to_char_boundary;
use super::utils::{build_section, is_title_like, replace_recindex, strip_html_tags};
use super::PreparedSection;
use crate::formats::mobi::cache::TocItem;

// ====================== 字节级拆分 ======================

/// 在字节流中定位 <body> 内容区域的字节范围
fn find_body_range(raw: &[u8]) -> (usize, usize) {
    let body_start = BODY_OPEN_RE.find(raw).map(|m| m.end()).unwrap_or(0);
    let body_end = BODY_CLOSE_RE.find_at(raw, body_start).map(|m| m.start()).unwrap_or(raw.len());
    (body_start, body_end)
}

/// 在字节范围内定位所有 pagebreak 的位置和长度
fn find_pagebreaks(raw: &[u8], start: usize, end: usize) -> Vec<(usize, usize)> {
    let slice = &raw[start..end];
    SPLIT_BYTES_RE.find_iter(slice)
        .map(|m| (start + m.start(), start + m.end()))
        .collect()
}

/// 根据 pagebreak 位置将 body 区域分割为多个字节范围
fn compute_section_ranges(body_start: usize, body_end: usize, breaks: &[(usize, usize)]) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    let mut prev = body_start;
    for &(brk_start, brk_end) in breaks {
        if brk_start > prev {
            ranges.push((prev, brk_start));
        }
        prev = brk_end;
    }
    if prev < body_end {
        ranges.push((prev, body_end));
    }
    ranges
}

/// 将字节范围解码为 UTF-8 字符串，在精确字节位置插入锚点，替换图片引用，构建 section
fn decode_and_build_section(
    raw_text: &[u8],
    start: usize,
    end: usize,
    encoding: &'static Encoding,
    image_map: &HashMap<usize, String>,
    index: u32,
    filepos_anchors: &[usize],
) -> Option<PreparedSection> {
    let s = start.min(raw_text.len());
    let e = end.min(raw_text.len());
    if s >= e { return None; }

    // 收集落在 [s, e) 范围内的 filepos，按偏移排序去重
    let mut anchors_in_range: Vec<usize> = filepos_anchors.iter()
        .copied()
        .filter(|&fp| fp > s && fp < e)
        .collect();
    anchors_in_range.sort_unstable();
    anchors_in_range.dedup();

    let html = if anchors_in_range.is_empty() {
        let (decoded, _, _) = encoding.decode(&raw_text[s..e]);
        replace_recindex(decoded.trim(), image_map)
    } else {
        // 按锚点位置将字节切片拆分，在切分点插入锚点标签
        let mut result = String::new();
        let mut cur = s;
        for fp in &anchors_in_range {
            // 对齐到字符边界，避免在多字节字符中间截断
            let aligned_fp = align_to_char_boundary(raw_text, *fp, encoding);
            if aligned_fp != *fp {
                println!("[mobi-engine] 锚点对齐: filepos={} -> aligned={}", fp, aligned_fp);
            }
            let (seg, _, _) = encoding.decode(&raw_text[cur..aligned_fp]);
            result.push_str(&replace_recindex(&seg, image_map));
            result.push_str(&format!(r#"<span id="filepos{}"></span>"#, fp));
            cur = aligned_fp;
        }
        let (tail, _, _) = encoding.decode(&raw_text[cur..e]);
        result.push_str(&replace_recindex(&tail, image_map));
        result
    };

    let trimmed = html.trim();
    if trimmed.is_empty() { return None; }
    Some(build_section(trimmed.to_string(), index))
}

/// 按分页标记拆分章节并提取目录（完全基于字节操作）
pub(super) fn split_into_sections(
    raw_text: &[u8],
    image_map: &HashMap<usize, String>,
    encoding: &'static Encoding,
) -> (Vec<PreparedSection>, Vec<TocItem>) {
    let (body_start, body_end) = find_body_range(raw_text);

    if body_start >= body_end {
        return (vec![], vec![]);
    }

    println!("[mobi-engine] body 字节范围: {}..{} ({} bytes)", body_start, body_end, body_end - body_start);

    // 在 body 区域查找 pagebreak
    let breaks = find_pagebreaks(raw_text, body_start, body_end);
    println!("[mobi-engine] pagebreak 数量: {}", breaks.len());

    if !breaks.is_empty() {
        let ranges = compute_section_ranges(body_start, body_end, &breaks);

        if ranges.len() > 1 {
            // 先提取 TOC 和 filepos 锚点列表
            let (toc, filepos_anchors) = extract_toc_from_guide(raw_text, encoding, &ranges);
            let anchor_fps: Vec<usize> = filepos_anchors.iter().map(|(_, fp)| *fp).collect();

            // 解码时将锚点精确注入到对应字节位置
            let mut sections = Vec::new();
            let mut valid_ranges = Vec::new();
            for &(start, end) in &ranges {
                let anchors_for_section = if !toc.is_empty() { &anchor_fps[..] } else { &[] };
                if let Some(section) = decode_and_build_section(raw_text, start, end, encoding, image_map, sections.len() as u32, anchors_for_section) {
                    sections.push(section);
                    valid_ranges.push((start, end));
                }
            }

            if !toc.is_empty() {
                return (sections, toc);
            }
            let toc = build_toc_from_sections(&mut sections);
            return (sections, toc);
        }
    }

    // pagebreak 不足，用单 section 解码（无锚点注入）
    if let Some(section) = decode_and_build_section(raw_text, body_start, body_end, encoding, image_map, 0, &[]) {
        let html = &section.html;

        let (sections, toc) = split_by_headings(html);
        println!("[mobi-engine] 标题拆分: {} 段", sections.len());
        if sections.len() > 1 {
            return (sections, toc);
        }

        let (sections, toc) = split_by_chapter_pattern(html);
        println!("[mobi-engine] 章节名拆分: {} 段", sections.len());
        if sections.len() > 1 {
            return (sections, toc);
        }

        // 最终兜底：按固定长度拆分
        return split_by_length(html, 4000);
    }

    (vec![], vec![])
}

// ====================== 目录提取（字节安全） ======================

/// 从字节中解析 ASCII 数字字符串为 usize
fn parse_ascii_number(bytes: &[u8]) -> Option<usize> {
    std::str::from_utf8(bytes).ok().and_then(|s| s.parse().ok())
}

/// 从原始字节流中提取 guide TOC（完全在字节级操作）
fn extract_toc_from_guide(
    raw_text: &[u8],
    encoding: &'static Encoding,
    section_byte_ranges: &[(usize, usize)],
) -> (Vec<TocItem>, Vec<(u32, usize)>) {
    // 在字节流中找 <reference type="toc" filepos="N">
    let toc_filepos = REF_TOC_BYTES_RE.captures(raw_text)
        .or_else(|| REF_TOC_ALT_BYTES_RE.captures(raw_text))
        .and_then(|caps| caps.get(1))
        .and_then(|m| parse_ascii_number(m.as_bytes()))
        .unwrap_or(0);

    // 确定 TOC 页所在的字节区域
    let toc_region = if toc_filepos > 0 && toc_filepos < raw_text.len() {
        // 从 filepos 到下一个 pagebreak 或最多 50KB
        let region_end = SPLIT_BYTES_RE.find_at(raw_text, toc_filepos)
            .map(|m| m.start())
            .unwrap_or_else(|| (toc_filepos + 50000).min(raw_text.len()));
        &raw_text[toc_filepos..region_end]
    } else {
        // 找包含最多 <a filepos> 的 section
        find_best_toc_section(raw_text, section_byte_ranges)
    };

    if toc_region.is_empty() {
        return (vec![], vec![]);
    }

    // 提取所有 <a filepos="N">title</a>
    let mut entries: Vec<(usize, String)> = Vec::new();
    for caps in ANCHOR_BYTES_RE.captures_iter(toc_region) {
        let fp = match caps.get(1).and_then(|m| parse_ascii_number(m.as_bytes())) {
            Some(v) if v > 0 => v,
            _ => continue,
        };

        // 标题字节用实际编码解码
        if let Some(title_match) = caps.get(2) {
            let (decoded_title, _, _) = encoding.decode(title_match.as_bytes());
            let title = strip_html_tags(&decoded_title).trim().to_string();
            if !title.is_empty() {
                entries.push((fp, title));
            }
        }
    }

    if entries.is_empty() {
        return (vec![], vec![]);
    }

    // filepos → section index 映射并构建层级目录
    let mut filepos_anchors = Vec::new();
    let toc = build_toc_with_hierarchy(&entries, section_byte_ranges, &mut filepos_anchors);
    println!("[mobi-engine] guide TOC 提取: {} 项", toc.len());
    (toc, filepos_anchors)
}

/// 找包含最多 <a filepos> 链接的 section（用于定位 TOC 页）
fn find_best_toc_section<'a>(raw_text: &'a [u8], section_byte_ranges: &[(usize, usize)]) -> &'a [u8] {
    let mut best_start = 0usize;
    let mut best_end = 0usize;
    let mut best_count = 0usize;

    for &(start, end) in section_byte_ranges {
        let s = start.min(raw_text.len());
        let e = end.min(raw_text.len());
        let count = ANCHOR_BYTES_RE.captures_iter(&raw_text[s..e]).count();
        if count > best_count {
            best_count = count;
            best_start = s;
            best_end = e;
        }
    }

    if best_count < 3 {
        return &[];
    }
    &raw_text[best_start..best_end]
}

/// 构建带层级的 TOC 列表
/// filepos 精确匹配失败时查找最近的后续 section
fn build_toc_with_hierarchy(
    entries: &[(usize, String)],
    section_byte_ranges: &[(usize, usize)],
    filepos_anchors: &mut Vec<(u32, usize)>,
) -> Vec<TocItem> {
    let mut toc = Vec::new();

    for (filepos, title) in entries {
        // 精确匹配：filepos 落在某个 section 的字节范围内
        let section_index = section_byte_ranges
            .iter()
            .position(|&(start, end)| *filepos >= start && *filepos < end)
            .or_else(|| {
                section_byte_ranges
                    .iter()
                    .enumerate()
                    .filter(|(_, &(start, _))| start > *filepos)
                    .min_by_key(|(_, &(start, _))| start)
                    .map(|(idx, _)| idx)
            })
            .unwrap_or(0) as u32;

        let location = format!("section:{}#filepos{}", section_index, filepos);
        filepos_anchors.push((section_index, *filepos));

        toc.push(TocItem {
            title: Some(title.clone()),
            location: Some(location),
            level: 0,
            children: vec![],
        });
    }
    infer_toc_hierarchy(&mut toc);
    toc
}

// inject_filepos_anchors 已移除，锚点在 decode_and_build_section 中精确注入

/// 根据标题文字模式推断目录层级，并构建嵌套树结构
/// 篇/卷 → level 0（上级），章/节/回 → level 1（子级）
fn infer_toc_hierarchy(toc: &mut Vec<TocItem>) {
    if toc.len() < 2 {
        return;
    }

    // 检查是否同时存在篇/卷级和章/节/回级的标题
    let has_part = toc.iter().any(|item| {
        item.title.as_ref().map_or(false, |t| PART_LEVEL_RE.is_match(t))
    });
    let has_chapter = toc.iter().any(|item| {
        item.title.as_ref().map_or(false, |t| CHAPTER_LEVEL_RE.is_match(t))
    });

    if has_part && has_chapter {
        // 标记 level：篇/卷=0, 章/节/回=1
        for item in toc.iter_mut() {
            if let Some(ref title) = item.title {
                if PART_LEVEL_RE.is_match(title) {
                    item.level = 0;
                } else if CHAPTER_LEVEL_RE.is_match(title) {
                    item.level = 1;
                }
            }
        }
    } else {
        // 利用 heading 标签的 level 差异归一化
        let min_level = toc.iter().map(|item| item.level).min().unwrap_or(0);
        let max_level = toc.iter().map(|item| item.level).max().unwrap_or(0);
        if min_level == max_level {
            return;
        }
        if min_level > 0 {
            for item in toc.iter_mut() {
                item.level -= min_level;
            }
        }
    }

    // 将平级列表按 level 构建为嵌套树
    nest_toc_by_level(toc);
}

/// 将平级 TOC 列表按 level 嵌套为父子树结构
/// level=0 的条目作为顶级节点，后续 level>0 的条目归入最近的上级 children
fn nest_toc_by_level(toc: &mut Vec<TocItem>) {
    // 检查是否存在多级结构
    let has_hierarchy = toc.iter().any(|item| item.level > 0);
    if !has_hierarchy {
        return;
    }

    let items = std::mem::take(toc);
    let mut result: Vec<TocItem> = Vec::new();

    for item in items {
        if item.level == 0 {
            // 顶级条目直接加入结果
            result.push(item);
        } else if let Some(parent) = result.last_mut() {
            // 子级条目归入最近的顶级条目
            parent.children.push(item);
        } else {
            // 没有父级时作为顶级条目兜底
            result.push(item);
        }
    }

    *toc = result;
}

fn build_toc_from_sections(sections: &mut [PreparedSection]) -> Vec<TocItem> {
    let mut toc = Vec::new();
    let section_count = sections.len();

    for (i, section) in sections.iter_mut().enumerate() {
        let original_html = section.html.clone();
        let mut new_html = String::new();
        let mut last_end = 0usize;
        let mut heading_index = 0usize;

        for caps in HEADING_RE.captures_iter(&original_html) {
            let m = match caps.get(0) {
                Some(m) => m,
                None => continue,
            };
            let start = m.start();
            let end = m.end();
            let level: i32 = caps.get(1)
                .and_then(|m| m.as_str().parse().ok())
                .unwrap_or(1);
            let title = strip_html_tags(&caps[2]).trim().to_string();
            if title.is_empty() || title.len() >= 200 {
                continue;
            }

            new_html.push_str(&original_html[last_end..start]);
            let anchor_id = format!("mobi-h-{}-{}", section.index, heading_index);
            heading_index += 1;
            new_html.push_str(&format!(r#"<span id="{}"></span>"#, anchor_id));
            new_html.push_str(&original_html[start..end]);
            last_end = end;

            toc.push(TocItem {
                title: Some(title),
                location: Some(format!("section:{}#{}", section.index, anchor_id)),
                level: (level - 1).min(2),
                children: vec![],
            });
        }

        if heading_index > 0 {
            new_html.push_str(&original_html[last_end..]);
            section.html = new_html;
            continue;
        }

        let first_p_text = FIRST_P_RE.captures(&original_html)
            .and_then(|c| c.get(1))
            .map(|m| strip_html_tags(m.as_str()).trim().to_string())
            .filter(|s| !s.is_empty() && s.len() < 100)
            .filter(|s| is_title_like(s));

        if let Some(text) = first_p_text {
            let display = if text.len() > 50 {
                format!("{}...", &text[..text.char_indices().nth(50).map(|(i, _)| i).unwrap_or(text.len())])
            } else {
                text
            };
            toc.push(TocItem {
                title: Some(display),
                location: Some(format!("section:{}", section.index)),
                level: 0,
                children: vec![],
            });
        } else if section_count <= 20 {
            toc.push(TocItem {
                title: Some(format!("第 {} 章", i + 1)),
                location: Some(format!("section:{}", section.index)),
                level: 0,
                children: vec![],
            });
        }
    }

    // 条目过多时精简为 h1/h2 级别并限制数量
    if toc.len() > 100 {
        println!("[mobi-engine] TOC 条目过多({}), 精简为 h1/h2", toc.len());
        toc = toc.into_iter()
            .filter(|item| item.level <= 1)
            .take(100)
            .collect();
    }

    infer_toc_hierarchy(&mut toc);
    println!("[mobi-engine] 从 sections 解析 TOC: {} 项", toc.len());
    toc
}

// ====================== 降级拆分策略 ======================

/// 按中文/英文章节名模式拆分 HTML
fn split_by_chapter_pattern(html: &str) -> (Vec<PreparedSection>, Vec<TocItem>) {
    let positions: Vec<(usize, String)> = CHAPTER_PATTERN_RE.find_iter(html)
        .map(|m| (m.start(), m.as_str().to_string()))
        .collect();

    if positions.is_empty() {
        return (vec![build_section(html.to_string(), 0)], vec![]);
    }

    let mut sections = Vec::new();
    let mut toc = Vec::new();

    // 章节名前的前言内容
    if positions[0].0 > 0 {
        let preface = html[..positions[0].0].trim();
        if !preface.is_empty() {
            sections.push(build_section(preface.to_string(), 0));
        }
    }

    for (i, (pos, chapter_name)) in positions.iter().enumerate() {
        let end = positions.get(i + 1).map(|(p, _)| *p).unwrap_or(html.len());
        let content = html[*pos..end].trim();
        if content.is_empty() { continue; }

        let index = sections.len() as u32;
        toc.push(TocItem {
            title: Some(chapter_name.clone()),
            location: Some(format!("section:{}", index)),
            level: 0,
            children: vec![],
        });
        sections.push(build_section(content.to_string(), index));
    }

    infer_toc_hierarchy(&mut toc);
    (sections, toc)
}

/// 按 h1-h3 标题拆分 HTML（解码后的 UTF-8 字符串）
fn split_by_headings(html: &str) -> (Vec<PreparedSection>, Vec<TocItem>) {
    let positions: Vec<usize> = HEADING_POS_RE.find_iter(html).map(|m| m.start()).collect();

    if positions.is_empty() {
        return (vec![build_section(html.to_string(), 0)], vec![]);
    }

    let mut sections = Vec::new();

    // 标题前的前言内容
    if positions[0] > 0 {
        let preface = html[..positions[0]].trim();
        if !preface.is_empty() {
            sections.push(build_section(preface.to_string(), 0));
        }
    }

    for (i, &pos) in positions.iter().enumerate() {
        let end = positions.get(i + 1).copied().unwrap_or(html.len());
        let content = html[pos..end].trim();
        if content.is_empty() { continue; }
        sections.push(build_section(content.to_string(), sections.len() as u32));
    }

    let mut sections_mut = sections;
    let toc = build_toc_from_sections(&mut sections_mut);
    (sections_mut, toc)
}

/// 按固定字符长度拆分 HTML（最终兜底策略）
fn split_by_length(html: &str, chunk_size: usize) -> (Vec<PreparedSection>, Vec<TocItem>) {
    let mut sections = Vec::new();
    let mut toc = Vec::new();
    let chars: Vec<char> = html.chars().collect();
    let total = chars.len();
    let mut start = 0;

    while start < total {
        let end = (start + chunk_size).min(total);
        let content: String = chars[start..end].iter().collect();
        if !content.trim().is_empty() {
            let index = sections.len() as u32;
            toc.push(TocItem {
                title: Some(format!("第 {} 页", index + 1)),
                location: Some(format!("section:{}", index)),
                level: 0,
                children: vec![],
            });
            sections.push(build_section(content, index));
        }
        start = end;
    }

    println!("[mobi-engine] 长度拆分: {} 段 (chunk_size={})", sections.len(), chunk_size);
    (sections, toc)
}

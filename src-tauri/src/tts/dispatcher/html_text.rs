/// 把 HTML 字符串转为纯文本：剔除 script/style 块、去掉所有标签、解码常见实体
pub fn extract_plain_text(html: &str) -> String {
    let stripped = strip_block_tags(html, "script");
    let stripped = strip_block_tags(&stripped, "style");
    let no_tags = strip_html_tags(&stripped);
    let decoded = decode_entities(&no_tags);
    decoded.trim().to_string()
}

/// 去除 <tag>...</tag> 整个块（含内容），大小写不敏感
fn strip_block_tags(html: &str, tag: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let lower = html.to_ascii_lowercase();
    let open_pat = format!("<{}", tag);
    let close_pat = format!("</{}>", tag);

    let mut cursor = 0;
    while cursor < html.len() {
        let rest = &lower[cursor..];
        let rel_open = rest.find(open_pat.as_str());
        let open_at = match rel_open {
            Some(rel) => cursor + rel,
            None => {
                out.push_str(&html[cursor..]);
                break;
            }
        };
        out.push_str(&html[cursor..open_at]);
        let after_open = open_at + open_pat.len();
        let from_after = &lower[after_open..];
        let rel_close = from_after.find(close_pat.as_str());
        match rel_close {
            Some(rel) => {
                cursor = after_open + rel + close_pat.len();
            }
            None => {
                cursor = html.len();
            }
        }
    }
    out
}

/// 去除所有 HTML 标签，保留文本
fn strip_html_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for ch in html.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out
}

/// 解码常见 HTML 实体
fn decode_entities(text: &str) -> String {
    text.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&#39;", "'")
}

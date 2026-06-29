/// 把章节索引和块索引编码为 cursor 字符串
pub fn encode_section_cursor(section_index: i32, chunk_index: i32) -> String {
    format!("{}:{}", section_index, chunk_index)
}

/// 把 cursor 字符串解码为章节索引和块索引；非法返回 None
pub fn decode_section_cursor(cursor: &str) -> Option<(i32, i32)> {
    let mut parts = cursor.splitn(2, ':');
    let section = parts.next()?.parse::<i32>().ok()?;
    let chunk = parts.next()?.parse::<i32>().ok()?;
    if section < 0 || chunk < 0 {
        return None;
    }
    Some((section, chunk))
}

/// 把页码编码为 cursor 字符串（TXT 横向模式专用）
pub fn encode_page_cursor(page: i32) -> String {
    format!("page:{}", page)
}

/// 把 page 类型 cursor 解码为页码；非该类型返回 None
pub fn decode_page_cursor(cursor: &str) -> Option<i32> {
    let rest = cursor.strip_prefix("page:")?;
    rest.parse::<i32>().ok().filter(|&p| p >= 0)
}


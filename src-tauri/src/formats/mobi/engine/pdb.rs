//! PDB 记录解析、编码检测、文本解压、字符边界对齐

use encoding_rs::Encoding;

// ====================== PDB 解析 ======================

/// 解析 PDB 记录偏移表
pub(super) fn parse_record_offsets(data: &[u8]) -> Option<Vec<usize>> {
    if data.len() < 82 { return None; }
    let num_records = u16::from_be_bytes([data[76], data[77]]) as usize;
    if num_records < 2 { return None; }

    let mut offsets = Vec::with_capacity(num_records);
    for i in 0..num_records {
        let base = 78 + i * 8;
        if base + 4 > data.len() { return None; }
        let offset = u32::from_be_bytes([data[base], data[base+1], data[base+2], data[base+3]]) as usize;
        offsets.push(offset);
    }
    Some(offsets)
}

/// 从 MOBI Header 读取编码值（纯 header 解析，不做内容探测，用于截断对齐等场景避免递归）
fn read_encoding_from_header(data: &[u8]) -> &'static Encoding {
    if data.len() < 82 { return encoding_rs::UTF_8; }
    let record0_offset = u32::from_be_bytes([data[78], data[79], data[80], data[81]]) as usize;
    let encoding_offset = record0_offset + 16 + 12;
    if encoding_offset + 4 > data.len() { return encoding_rs::UTF_8; }
    let val = u32::from_be_bytes([
        data[encoding_offset], data[encoding_offset + 1],
        data[encoding_offset + 2], data[encoding_offset + 3],
    ]);
    match val {
        65001 => encoding_rs::UTF_8,
        1252 | 28591 => encoding_rs::WINDOWS_1252,
        1250 | 28592 => encoding_rs::WINDOWS_1250,
        1251 => encoding_rs::WINDOWS_1251,
        936 => encoding_rs::GBK,
        950 => encoding_rs::BIG5,
        949 => encoding_rs::EUC_KR,
        932 => encoding_rs::SHIFT_JIS,
        _ => encoding_rs::UTF_8,
    }
}

/// 从 MOBI Header 检测文本编码
pub(super) fn detect_encoding(data: &[u8]) -> &'static Encoding {
    if data.len() < 82 { return encoding_rs::UTF_8; }
    let record0_offset = u32::from_be_bytes([data[78], data[79], data[80], data[81]]) as usize;
    // PalmDOC header(16 bytes) + MOBI header 编码字段偏移 0x0C(12)
    let encoding_offset = record0_offset + 16 + 12;
    if encoding_offset + 4 > data.len() { return encoding_rs::UTF_8; }
    let val = u32::from_be_bytes([
        data[encoding_offset], data[encoding_offset + 1],
        data[encoding_offset + 2], data[encoding_offset + 3],
    ]);
    println!("[mobi-engine] 编码字段原始值: {}", val);
    let header_encoding = match val {
        65001 => encoding_rs::UTF_8,
        1252 => encoding_rs::WINDOWS_1252,
        1250 => encoding_rs::WINDOWS_1250,
        1251 => encoding_rs::WINDOWS_1251,
        936 => encoding_rs::GBK,
        950 => encoding_rs::BIG5,
        949 => encoding_rs::EUC_KR,
        932 => encoding_rs::SHIFT_JIS,
        28591 => encoding_rs::WINDOWS_1252,
        28592 => encoding_rs::WINDOWS_1250,
        _ => {
            println!("[mobi-engine] 未知编码值 {}，尝试内容探测", val);
            return guess_encoding_from_content(data);
        }
    };
    // header 声称 UTF-8 则直接返回，否则用实际内容校验
    if header_encoding == encoding_rs::UTF_8 {
        return encoding_rs::UTF_8;
    }
    // 很多中文 MOBI 文件 header 写的是 CP1252，但实际内容是 UTF-8
    let verified = guess_encoding_from_content(data);
    if verified != header_encoding {
        println!("[mobi-engine] header 编码 {} 与实际内容不符，使用探测结果: {}", header_encoding.name(), verified.name());
    }
    verified
}

/// 通过采样文本字节判断实际编码
fn guess_encoding_from_content(data: &[u8]) -> &'static Encoding {
    let raw_text = match extract_raw_text_bytes(data) {
        Some(t) if t.len() > 100 => t,
        _ => {
            println!("[mobi-engine] 内容探测: 文本过短，回退 CP1252");
            return encoding_rs::WINDOWS_1252;
        }
    };
    // 采样前 8KB，覆盖更多内容以提高准确性
    let sample_len = raw_text.len().min(8192);
    let sample = &raw_text[..sample_len];
    let (_, _, had_errors) = encoding_rs::UTF_8.decode(sample);
    if !had_errors {
        // 进一步检查：是否包含非 ASCII 字符（纯 ASCII 不足以判断）
        let has_multibyte = sample.iter().any(|&b| b > 0x7F);
        if has_multibyte {
            println!("[mobi-engine] 内容探测: 有效 UTF-8（含多字节字符），采样 {} bytes", sample_len);
            return encoding_rs::UTF_8;
        }
        // 纯 ASCII，UTF-8 和 CP1252 兼容，优先 UTF-8
        println!("[mobi-engine] 内容探测: 纯 ASCII 内容，使用 UTF-8");
        return encoding_rs::UTF_8;
    }
    // UTF-8 解码失败，从 header 读取编码值作为回退
    let header_enc = read_encoding_from_header(data);
    println!("[mobi-engine] 内容探测: UTF-8 校验失败，回退 header 编码 {}", header_enc.name());
    // 打印解码失败位置附近的字节用于诊断
    if let Some(pos) = find_first_invalid_utf8(sample) {
        let context_start = pos.saturating_sub(8);
        let context_end = (pos + 8).min(sample.len());
        println!("[mobi-engine] UTF-8 首个无效字节位置: {}, 上下文: {:02X?}", pos, &sample[context_start..context_end]);
    }
    header_enc
}

/// 找到首个非法 UTF-8 字节的位置
fn find_first_invalid_utf8(data: &[u8]) -> Option<usize> {
    match std::str::from_utf8(data) {
        Ok(_) => None,
        Err(e) => Some(e.valid_up_to()),
    }
}

/// 提取并解压所有文本记录，返回原始字节流
pub(super) fn extract_raw_text_bytes(data: &[u8]) -> Option<Vec<u8>> {
    let offsets = parse_record_offsets(data)?;
    let record0_start = offsets[0];
    if record0_start + 16 > data.len() { return None; }

    let compression = u16::from_be_bytes([data[record0_start], data[record0_start + 1]]);
    let text_record_count = u16::from_be_bytes([data[record0_start + 8], data[record0_start + 9]]) as usize;

    // 解压后文本的总字节数（record0 偏移 4-7）
    let text_length = u32::from_be_bytes([
        data[record0_start + 4], data[record0_start + 5],
        data[record0_start + 6], data[record0_start + 7],
    ]) as usize;

    // 解析 extra_data_flags，用于裁剪每条记录的尾部填充字节
    let extra_flags = parse_extra_data_flags(data, record0_start);
    println!("[mobi-engine] text_length={}, extra_flags=0x{:X}", text_length, extra_flags);

    let mut all_text = Vec::new();
    for i in 1..=text_record_count {
        if i >= offsets.len() { break; }
        let start = offsets[i];
        let end = if i + 1 < offsets.len() { offsets[i + 1] } else { data.len() };
        if start >= data.len() || end > data.len() || start >= end { continue; }

        let raw_record = &data[start..end];
        // 裁剪 trailing bytes（含 multibyte overlap 标记和变长字段），它们是压缩数据之外的元数据
        let record_data = trim_trailing_bytes(raw_record, extra_flags);

        if i <= 5 {
            println!("[mobi-engine] record[{}]: raw={} bytes, trimmed={} bytes, compression={}",
                i, raw_record.len(), record_data.len(), compression);
        }

        let before_len = all_text.len();
        match compression {
            1 => all_text.extend_from_slice(record_data),
            2 => all_text.extend(palmdoc_decompress(record_data)),
            _ => all_text.extend_from_slice(record_data),
        }

        let decompressed_size = all_text.len() - before_len;
        if i <= 5 {
            println!("[mobi-engine] record[{}]: decompressed {} bytes", i, decompressed_size);
            // 打印解压后尾部 8 字节，便于检查 record 边界处字节连续性
            let tail_start = if all_text.len() >= 8 { all_text.len() - 8 } else { 0 };
            let tail_bytes: Vec<String> = all_text[tail_start..].iter().map(|b| format!("{:02X}", b)).collect();
            println!("[mobi-engine] record[{}]: tail bytes: [{}]", i, tail_bytes.join(", "));
        }
    }

    // 用 text_length 截断，裁掉解压后多余的填充字节
    if text_length > 0 && text_length < all_text.len() {
        // 从 header 直接读取编码值（不调用 detect_encoding 避免递归）
        let encoding = read_encoding_from_header(data);
        let safe_len = align_truncate_to_char_boundary(&all_text, text_length, encoding);
        if safe_len != text_length {
            println!("[mobi-engine] text_length 截断对齐: {} -> {}", text_length, safe_len);
        }
        all_text.truncate(safe_len);
    }

    Some(all_text)
}

/// 从 MOBI header 解析 extra_data_flags
fn parse_extra_data_flags(data: &[u8], record0_start: usize) -> u16 {
    // MOBI header 起始于 record0 + 16（PalmDOC header 长度）
    let mobi_start = record0_start + 16;
    if mobi_start + 8 > data.len() { return 0; }

    // MOBI header 长度字段在偏移 0x04-0x07（从 MOBI 标识起算）
    let mobi_len = u32::from_be_bytes([
        data[mobi_start + 4], data[mobi_start + 5],
        data[mobi_start + 6], data[mobi_start + 7],
    ]) as usize;
    println!("[mobi-engine] MOBI header 长度: 0x{:X} ({})", mobi_len, mobi_len);

    // extra_data_flags 在 MOBI header 偏移 0xE2(226) 处，2 字节（需要 header 长度 >= 0xE4）
    let flags_offset = mobi_start + 0xE2;
    if mobi_len >= 0xE4 && flags_offset + 2 <= data.len() {
        let flags = u16::from_be_bytes([data[flags_offset], data[flags_offset + 1]]);
        println!("[mobi-engine] extra_data_flags: 0x{:04X} (offset=0x{:X})", flags, flags_offset);
        flags
    } else {
        println!("[mobi-engine] MOBI header 长度不足(0x{:X} < 0xE4)，无 extra_data_flags", mobi_len);
        0
    }
}

/// 裁剪记录尾部的元数据字段（变长字段 + multibyte 标记）
/// 参考 Calibre 的 getSizeOfTrailingDataEntries 实现
fn trim_trailing_bytes<'a>(record: &'a [u8], extra_flags: u16) -> &'a [u8] {
    if extra_flags == 0 || record.is_empty() {
        return record;
    }

    let mut num = 0usize;
    let size = record.len();

    // 先处理 bit 1+ 的变长尾部字段（从低位到高位依次剥离）
    let mut flags = extra_flags >> 1;
    while flags > 0 {
        if flags & 1 != 0 {
            num += decode_trailing_entry_size(record, size.saturating_sub(num));
        }
        flags >>= 1;
    }

    // 最后处理 bit 0: multibyte overlap 标记（低 2 位 + 1 = 需跳过的字节数）
    if extra_flags & 1 != 0 {
        let pos = size.saturating_sub(num);
        if pos > 0 {
            num += ((record[pos - 1] as usize) & 0x3) + 1;
        }
    }

    &record[..size.saturating_sub(num)]
}

/// 解码变长整数编码的 trailing entry 长度（返回该 entry 占用的总字节数）
/// 从 record[..size] 末尾往前读取变长整数，解码值即为 entry 的总字节长度
fn decode_trailing_entry_size(record: &[u8], size: usize) -> usize {
    if size == 0 { return 0; }
    let mut bitpos = 0u32;
    let mut result = 0usize;
    let mut pos = size;
    loop {
        pos -= 1;
        let v = record[pos] as usize;
        result |= (v & 0x7F) << bitpos;
        bitpos += 7;
        if (v & 0x80) != 0 || bitpos >= 28 || pos == 0 {
            return result;
        }
    }
}

/// PalmDOC LZ77 解压算法
fn palmdoc_decompress(input: &[u8]) -> Vec<u8> {
    let mut output = Vec::with_capacity(input.len() * 2);
    let mut i = 0;
    while i < input.len() {
        let byte = input[i];
        i += 1;
        match byte {
            0x00 => output.push(0),
            0x01..=0x08 => {
                let count = byte as usize;
                for _ in 0..count {
                    if i >= input.len() { break; }
                    output.push(input[i]);
                    i += 1;
                }
            }
            0x09..=0x7F => output.push(byte),
            0x80..=0xBF => {
                if i >= input.len() { break; }
                let next = input[i] as u16;
                i += 1;
                let pair = ((byte as u16) << 8) | next;
                let distance = ((pair >> 3) & 0x7FF) as usize;
                let length = ((pair & 0x07) + 3) as usize;
                if distance > 0 && distance <= output.len() {
                    let start = output.len() - distance;
                    for j in 0..length {
                        let b = output[start + (j % distance)];
                        output.push(b);
                    }
                }
            }
            0xC0..=0xFF => {
                output.push(b' ');
                output.push(byte ^ 0x80);
            }
        }
    }
    output
}

// ====================== 字符边界对齐 ======================

/// 将字节偏移对齐到编码的字符边界，避免在多字节字符中间截断
pub(super) fn align_to_char_boundary(raw: &[u8], pos: usize, encoding: &'static Encoding) -> usize {
    if pos == 0 || pos >= raw.len() {
        return pos;
    }
    if encoding == encoding_rs::UTF_8 {
        // UTF-8: 向前搜索非续接字节（非 10xxxxxx 开头）
        let mut p = pos;
        while p > 0 && (raw[p] & 0xC0) == 0x80 {
            p -= 1;
        }
        return p;
    }
    if encoding == encoding_rs::GBK
        || encoding == encoding_rs::BIG5
        || encoding == encoding_rs::EUC_KR
        || encoding == encoding_rs::SHIFT_JIS
    {
        // CJK 双字节编码：尝试 pos 和 pos-1，选择不产生替换字符的位置
        if pos > 0 {
            let probe_end = (pos + 2).min(raw.len());
            let (_, _, had_errors) = encoding.decode(&raw[pos..probe_end]);
            if had_errors {
                return pos - 1;
            }
        }
        return pos;
    }
    // 单字节编码（CP1252 等）无需对齐
    pos
}

/// 将截断位置向前对齐到字符边界，避免截断多字节字符尾部
pub(super) fn align_truncate_to_char_boundary(data: &[u8], pos: usize, encoding: &'static Encoding) -> usize {
    if pos >= data.len() { return data.len(); }
    align_to_char_boundary(data, pos, encoding)
}

/// 扫描原始字节流，定位解码产生 U+FFFD 的位置（乱码诊断）
pub(super) fn scan_for_encoding_errors(raw: &[u8], encoding: &'static Encoding) {
    let (decoded, _, had_errors) = encoding.decode(raw);
    if !had_errors {
        println!("[mobi-engine] 编码诊断: 解码无错误，无 U+FFFD");
        return;
    }
    // 单次遍历，找前 5 个 U+FFFD 的位置并估算原始字节偏移
    let mut count = 0usize;
    let mut byte_pos = 0usize;
    for (char_idx, ch) in decoded.chars().enumerate() {
        if ch == '\u{FFFD}' {
            count += 1;
            let ctx_start = byte_pos.saturating_sub(16);
            let ctx_end = (byte_pos + 16).min(raw.len());
            println!("[mobi-engine] 乱码位置 #{}: char_offset={}, ~byte_offset={}, 上下文字节: {:02X?}",
                count, char_idx, byte_pos, &raw[ctx_start..ctx_end]);
            if count >= 5 { break; }
        }
        byte_pos += ch.len_utf8();
    }
    if count > 0 {
        let total = decoded.chars().filter(|&c| c == '\u{FFFD}').count();
        println!("[mobi-engine] 编码诊断: 共发现 {} 个 U+FFFD 替换字符", total);
    }
}

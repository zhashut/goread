//! PDB 记录解析、编码检测、文本解压、字符边界对齐

use encoding_rs::Encoding;

// ====================== PDB 解析 ======================

/// 解析 PDB 记录偏移表
pub(super) fn parse_record_offsets(data: &[u8]) -> Option<Vec<usize>> {
    if data.len() < 82 {
        return None;
    }
    let num_records = u16::from_be_bytes([data[76], data[77]]) as usize;
    if num_records < 2 {
        return None;
    }

    let mut offsets = Vec::with_capacity(num_records);
    for i in 0..num_records {
        let base = 78 + i * 8;
        if base + 4 > data.len() {
            return None;
        }
        let offset = u32::from_be_bytes([data[base], data[base + 1], data[base + 2], data[base + 3]]) as usize;
        offsets.push(offset);
    }
    Some(offsets)
}

struct PalmdocHeader {
    record0_start: usize,
    compression: u16,
    text_record_count: usize,
    text_length: usize,
}

struct MobiHeader {
    start: usize,
    length: u32,
    encoding: u32,
    uid: u32,
    version: u32,
    huffcdic: u32,
    num_huffcdic: u32,
    trailing_flags: u32,
    indx: u32,
}

fn parse_headers_with_offsets(data: &[u8], offsets: &[usize]) -> Option<(PalmdocHeader, MobiHeader)> {
    if offsets.is_empty() {
        return None;
    }
    let record0_start = offsets[0];
    if record0_start + 16 > data.len() {
        return None;
    }

    let compression = u16::from_be_bytes([data[record0_start], data[record0_start + 1]]);
    let text_length = u32::from_be_bytes([
        data[record0_start + 4],
        data[record0_start + 5],
        data[record0_start + 6],
        data[record0_start + 7],
    ]) as usize;
    let text_record_count = u16::from_be_bytes([data[record0_start + 8], data[record0_start + 9]]) as usize;

    let mobi_start = record0_start + 16;
    if mobi_start + 4 > data.len() {
        return None;
    }
    if &data[mobi_start..mobi_start + 4] != b"MOBI" {
        return None;
    }

    fn read_u32(data: &[u8], offset: usize) -> u32 {
        if offset + 4 > data.len() {
            0
        } else {
            u32::from_be_bytes([data[offset], data[offset + 1], data[offset + 2], data[offset + 3]])
        }
    }

    let length = read_u32(data, mobi_start + 4);
    // MOBI header 有效范围为 record0_start .. record0_start + 16 + length
    // 只有字段偏移在此范围内才读取，否则返回 0（与 JS 对越界 undefined 的行为一致）
    let mobi_safe_read = |offset_from_record0: usize| -> u32 {
        if offset_from_record0 + 4 <= 16 + length as usize {
            read_u32(data, record0_start + offset_from_record0)
        } else {
            0
        }
    };
    let encoding = mobi_safe_read(28);
    let uid = mobi_safe_read(32);
    let version = mobi_safe_read(36);
    let huffcdic = mobi_safe_read(112);
    let num_huffcdic = mobi_safe_read(116);
    let trailing_flags = mobi_safe_read(240);
    let indx = mobi_safe_read(244);

    let palmdoc = PalmdocHeader {
        record0_start,
        compression,
        text_record_count,
        text_length,
    };
    let mobi = MobiHeader {
        start: mobi_start,
        length,
        encoding,
        uid,
        version,
        huffcdic,
        num_huffcdic,
        trailing_flags,
        indx,
    };
    Some((palmdoc, mobi))
}

fn parse_headers(data: &[u8]) -> Option<(PalmdocHeader, MobiHeader)> {
    let offsets = parse_record_offsets(data)?;
    parse_headers_with_offsets(data, &offsets)
}

fn map_mobi_encoding(val: u32) -> Option<&'static Encoding> {
    match val {
        65001 => Some(encoding_rs::UTF_8),
        1252 | 28591 => Some(encoding_rs::WINDOWS_1252),
        1250 | 28592 => Some(encoding_rs::WINDOWS_1250),
        1251 => Some(encoding_rs::WINDOWS_1251),
        936 => Some(encoding_rs::GBK),
        950 => Some(encoding_rs::BIG5),
        949 => Some(encoding_rs::EUC_KR),
        932 => Some(encoding_rs::SHIFT_JIS),
        _ => None,
    }
}

/// 从 MOBI Header 读取编码值（纯 header 解析，不做内容探测，用于截断对齐等场景避免递归）
fn read_encoding_from_header(data: &[u8]) -> &'static Encoding {
    if let Some((_, mobi)) = parse_headers(data) {
        if let Some(enc) = map_mobi_encoding(mobi.encoding) {
            return enc;
        }
    }
    encoding_rs::UTF_8
}

/// 从 MOBI Header 检测文本编码
pub(super) fn detect_encoding(data: &[u8]) -> &'static Encoding {
    let header_encoding = if let Some((_, mobi)) = parse_headers(data) {
        println!("[mobi-engine] 编码字段原始值: {}", mobi.encoding);
        match map_mobi_encoding(mobi.encoding) {
            Some(enc) => enc,
            None => {
                println!("[mobi-engine] 未知编码值 {}，尝试内容探测", mobi.encoding);
                return guess_encoding_from_content(data);
            }
        }
    } else {
        println!("[mobi-engine] 无法解析 MOBI header，尝试内容探测");
        return guess_encoding_from_content(data);
    };
    // header 声称 UTF-8 则直接返回，否则用实际内容校验
    if header_encoding == encoding_rs::UTF_8 {
        return encoding_rs::UTF_8;
    }
    // 很多中文 MOBI 文件 header 写的是 CP1252，但实际内容是 UTF-8
    let verified = guess_encoding_from_content(data);
    if verified != header_encoding {
        println!(
            "[mobi-engine] header 编码 {} 与实际内容不符，使用探测结果: {}",
            header_encoding.name(),
            verified.name()
        );
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
        println!(
            "[mobi-engine] UTF-8 首个无效字节位置: {}, 上下文: {:02X?}",
            pos,
            &sample[context_start..context_end]
        );
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

enum CompressionKind {
    None,
    PalmDoc,
    HuffDic,
    Unknown(u16),
}

fn compression_kind_from_u16(value: u16) -> CompressionKind {
    match value {
        1 => CompressionKind::None,
        2 => CompressionKind::PalmDoc,
        17480 => CompressionKind::HuffDic,
        other => CompressionKind::Unknown(other),
    }
}

#[derive(Clone, Copy)]
struct HuffTable1Entry {
    found: bool,
    code_len: u8,
    value: u32,
}

struct HuffDicEntry {
    data: Vec<u8>,
    decompressed: bool,
}

struct HuffDicContext {
    table1: [HuffTable1Entry; 256],
    table2_min: [u32; 33],
    table2_base: [u32; 33],
    dictionary: Vec<HuffDicEntry>,
}

fn build_huffdic_context(data: &[u8], offsets: &[usize], mobi: &MobiHeader) -> Option<HuffDicContext> {
    if mobi.huffcdic == 0 || mobi.huffcdic == u32::MAX {
        println!("[mobi-engine][HuffDic] MOBI header 未提供有效 huffcdic 索引");
        return None;
    }
    let huff_index = mobi.huffcdic as usize;
    let num = mobi.num_huffcdic as usize;
    if huff_index >= offsets.len() || num == 0 {
        println!(
            "[mobi-engine][HuffDic] huffcdic 超出记录范围: huffcdic={}, numHuffcdic={}, record_count={}",
            huff_index, num, offsets.len()
        );
        return None;
    }

    let start = offsets[huff_index];
    let end = if huff_index + 1 < offsets.len() { offsets[huff_index + 1] } else { data.len() };
    if start >= data.len() || end > data.len() || end <= start {
        println!("[mobi-engine][HuffDic] HUFF 记录范围非法");
        return None;
    }
    let huff = &data[start..end];
    if huff.len() < 16 {
        println!("[mobi-engine][HuffDic] HUFF 记录过短: len={}", huff.len());
        return None;
    }
    if &huff[0..4] != b"HUFF" {
        println!("[mobi-engine][HuffDic] HUFF 记录魔数错误");
        return None;
    }

    let off1 = u32::from_be_bytes([huff[8], huff[9], huff[10], huff[11]]) as usize;
    let off2 = u32::from_be_bytes([huff[12], huff[13], huff[14], huff[15]]) as usize;
    if off1 + 256 * 4 > huff.len() || off2 + 32 * 8 > huff.len() {
        println!(
            "[mobi-engine][HuffDic] HUFF 表偏移异常: off1={}, off2={}, len={}",
            off1, off2, huff.len()
        );
        return None;
    }

    let mut table1 = [HuffTable1Entry {
        found: false,
        code_len: 0,
        value: 0,
    }; 256];
    for i in 0..256 {
        let offset = off1 + i * 4;
        let x = u32::from_be_bytes([huff[offset], huff[offset + 1], huff[offset + 2], huff[offset + 3]]);
        let found = (x & 0b1000_0000) != 0;
        let code_len = (x & 0b1_1111) as u8;
        let value = x >> 8;
        table1[i] = HuffTable1Entry { found, code_len, value };
    }

    let mut table2_min = [0u32; 33];
    let mut table2_base = [0u32; 33];
    for i in 0..32 {
        let offset = off2 + i * 8;
        let min = u32::from_be_bytes([huff[offset], huff[offset + 1], huff[offset + 2], huff[offset + 3]]);
        let base = u32::from_be_bytes([huff[offset + 4], huff[offset + 5], huff[offset + 6], huff[offset + 7]]);
        table2_min[i + 1] = min;
        table2_base[i + 1] = base;
    }

    let mut dictionary: Vec<HuffDicEntry> = Vec::new();
    for i in 1..num {
        let rec_index = huff_index + i;
        if rec_index >= offsets.len() {
            break;
        }
        let start = offsets[rec_index];
        let end = if rec_index + 1 < offsets.len() { offsets[rec_index + 1] } else { data.len() };
        if start >= data.len() || end > data.len() || end <= start {
            continue;
        }
        let rec = &data[start..end];
        if rec.len() < 16 {
            continue;
        }
        if &rec[0..4] != b"CDIC" {
            println!("[mobi-engine][HuffDic] CDIC 记录魔数错误: index={}", rec_index);
            return None;
        }
        let header_len = u32::from_be_bytes([rec[4], rec[5], rec[6], rec[7]]) as usize;
        if header_len > rec.len() {
            println!("[mobi-engine][HuffDic] CDIC header 长度超出记录范围");
            return None;
        }
        let num_entries_total = u32::from_be_bytes([rec[8], rec[9], rec[10], rec[11]]) as usize;
        let code_len = u32::from_be_bytes([rec[12], rec[13], rec[14], rec[15]]) as usize;
        if code_len == 0 || code_len > 32 {
            println!("[mobi-engine][HuffDic] CDIC codeLength 非法: {}", code_len);
            return None;
        }
        let buffer = &rec[header_len..];
        let remaining_entries = num_entries_total.saturating_sub(dictionary.len());
        let n = std::cmp::min(1usize << code_len, remaining_entries);
        if n == 0 {
            continue;
        }
        if buffer.len() < n * 2 {
            println!("[mobi-engine][HuffDic] CDIC offset 区域不足");
            return None;
        }
        for j in 0..n {
            let off = j * 2;
            let offset = u16::from_be_bytes([buffer[off], buffer[off + 1]]) as usize;
            if offset + 2 > buffer.len() {
                println!("[mobi-engine][HuffDic] CDIC 字典条目偏移越界");
                return None;
            }
            let x = u16::from_be_bytes([buffer[offset], buffer[offset + 1]]);
            let length = (x & 0x7FFF) as usize;
            let decompressed = (x & 0x8000) != 0;
            let value_start = offset + 2;
            let value_end = value_start + length;
            if value_end > buffer.len() {
                println!("[mobi-engine][HuffDic] CDIC 字典条目长度越界");
                return None;
            }
            let value = buffer[value_start..value_end].to_vec();
            dictionary.push(HuffDicEntry { data: value, decompressed });
        }
    }

    if dictionary.is_empty() {
        println!("[mobi-engine][HuffDic] 字典为空");
        return None;
    }

    println!(
        "[mobi-engine][HuffDic] 构建完成: entries={}, huff_index={}, numHuffcdic={}",
        dictionary.len(),
        huff_index,
        num
    );

    Some(HuffDicContext {
        table1,
        table2_min,
        table2_base,
        dictionary,
    })
}

/// 从字节数组指定位偏移处读取 64 位大端整数（越界部分补零）
fn read_u64_at(data: &[u8], byte_pos: usize) -> u64 {
    let mut buf = [0u8; 8];
    let avail = data.len().saturating_sub(byte_pos).min(8);
    if avail > 0 {
        buf[..avail].copy_from_slice(&data[byte_pos..byte_pos + avail]);
    }
    u64::from_be_bytes(buf)
}

/// HuffDic 解压核心（参考 Calibre 的 64 位窗口滑动方式）
fn huffdic_decompress_inner(
    ctx: &mut HuffDicContext,
    input: &[u8],
    out: &mut Vec<u8>,
    depth: u32,
) -> Result<(), ()> {
    if depth > 32 {
        println!("[mobi-engine][HuffDic] 递归深度过深");
        return Err(());
    }
    let mut bits_left = (input.len() as i64) * 8;
    let mut pos: usize = 0;
    let mut x = read_u64_at(input, pos);
    let mut n: i32 = 32;

    loop {
        if n <= 0 {
            pos += 4;
            x = read_u64_at(input, pos);
            n += 32;
        }
        // 从 64 位窗口中取出当前 32 位码字
        let code = ((x >> n as u32) & 0xFFFF_FFFF) as u32;
        let entry = ctx.table1[(code >> 24) as usize];
        let mut code_len = entry.code_len as i32;
        let mut value = entry.value;

        if !entry.found {
            if code_len == 0 {
                println!("[mobi-engine][HuffDic] 初始 code_len 为 0");
                return Err(());
            }
            while code_len < 33 && (code >> (32 - code_len) as u32) < ctx.table2_min[code_len as usize] {
                code_len += 1;
            }
            if code_len >= 33 {
                println!("[mobi-engine][HuffDic] 在 table2 中未找到合法码字");
                return Err(());
            }
            value = ctx.table2_base[code_len as usize];
        }

        n -= code_len;
        bits_left -= code_len as i64;
        if bits_left < 0 {
            break;
        }

        let r = value.wrapping_sub(code >> (32 - code_len) as u32);
        let idx = r as usize;
        if idx >= ctx.dictionary.len() {
            println!("[mobi-engine][HuffDic] 字典索引越界: {}", idx);
            return Err(());
        }

        if !ctx.dictionary[idx].decompressed {
            let compressed = ctx.dictionary[idx].data.clone();
            let mut expanded = Vec::new();
            huffdic_decompress_inner(ctx, &compressed, &mut expanded, depth + 1)?;
            ctx.dictionary[idx].data = expanded;
            ctx.dictionary[idx].decompressed = true;
        }
        out.extend_from_slice(&ctx.dictionary[idx].data);
    }
    Ok(())
}

fn huffdic_decompress_record(
    ctx: &mut HuffDicContext,
    input: &[u8],
    out: &mut Vec<u8>,
) -> Result<(), ()> {
    huffdic_decompress_inner(ctx, input, out, 0)
}

/// 提取并解压所有文本记录，返回原始字节流
pub(super) fn extract_raw_text_bytes(data: &[u8]) -> Option<Vec<u8>> {
    let offsets = parse_record_offsets(data)?;
    let (palmdoc, mobi) = parse_headers_with_offsets(data, &offsets)?;

    let compression_kind = compression_kind_from_u16(palmdoc.compression);
    let text_record_count = palmdoc.text_record_count;

    let mut text_length = palmdoc.text_length;

    if text_length == 0 {
        text_length = 8 * 1024 * 1024;
    } else if text_length > 16 * 1024 * 1024 {
        text_length = 16 * 1024 * 1024;
    }

    let trailing_flags = mobi.trailing_flags;
    println!(
        "[mobi-engine] text_length={}, mobi_header_length={}, trailing_flags=0x{:08X}, huffcdic={}, num_huffcdic={}, compression={}",
        text_length, mobi.length, trailing_flags, mobi.huffcdic, mobi.num_huffcdic, palmdoc.compression
    );

    let mut huff_ctx = None;
    if let CompressionKind::HuffDic = compression_kind {
        huff_ctx = build_huffdic_context(data, &offsets, &mobi);
        if huff_ctx.is_none() {
            println!("[mobi-engine] HuffDic 上下文解析失败，终止解压");
            return None;
        }
    }

    let mut all_text = Vec::with_capacity(text_length.min(1024 * 1024));
    for i in 1..=text_record_count {
        if i >= offsets.len() {
            break;
        }
        let start = offsets[i];
        let end = if i + 1 < offsets.len() { offsets[i + 1] } else { data.len() };
        if start >= data.len() || end > data.len() || start >= end {
            continue;
        }

        let raw_record = &data[start..end];
        // 裁剪 trailing bytes（含 multibyte overlap 标记和变长字段），它们是压缩数据之外的元数据
        let record_data = trim_trailing_bytes(raw_record, trailing_flags);

        let before_len = all_text.len();
        match compression_kind {
            CompressionKind::None => {
                all_text.extend_from_slice(record_data);
            }
            CompressionKind::PalmDoc => {
                all_text.extend(palmdoc_decompress(record_data));
            }
            CompressionKind::HuffDic => {
                if let Some(ref mut ctx) = huff_ctx {
                    if huffdic_decompress_record(ctx, record_data, &mut all_text).is_err() {
                        println!("[mobi-engine] HuffDic 解压失败，终止解压");
                        return None;
                    }
                } else {
                    return None;
                }
            }
            CompressionKind::Unknown(code) => {
                println!("[mobi-engine] 未知压缩类型 {}，终止解压", code);
                return None;
            }
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

/// 裁剪记录尾部的元数据字段（变长字段 + multibyte 标记）
/// 参考 JS 的 removeTrailingEntries 实现，trailing_flags 使用完整 u32
fn trim_trailing_bytes<'a>(record: &'a [u8], trailing_flags: u32) -> &'a [u8] {
    if trailing_flags == 0 || record.is_empty() {
        return record;
    }

    let mut num = 0usize;
    let size = record.len();

    // 先处理 bit 1+ 的变长尾部字段（从低位到高位依次剥离）
    let mut flags = trailing_flags >> 1;
    while flags > 0 {
        if flags & 1 != 0 {
            num += decode_trailing_entry_size(record, size.saturating_sub(num));
        }
        flags >>= 1;
    }

    // 最后处理 bit 0: multibyte overlap 标记（低 2 位 + 1 = 需跳过的字节数）
    if trailing_flags & 1 != 0 {
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
    if size == 0 {
        return 0;
    }
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
                    if i >= input.len() {
                        break;
                    }
                    output.push(input[i]);
                    i += 1;
                }
            }
            0x09..=0x7F => output.push(byte),
            0x80..=0xBF => {
                if i >= input.len() {
                    break;
                }
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
    if pos >= data.len() {
        return data.len();
    }
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
            println!(
                "[mobi-engine] 乱码位置 #{}: char_offset={}, ~byte_offset={}, 上下文字节: {:02X?}",
                count,
                char_idx,
                byte_pos,
                &raw[ctx_start..ctx_end]
            );
            if count >= 5 {
                break;
            }
        }
        byte_pos += ch.len_utf8();
    }
    if count > 0 {
        let total = decoded.chars().filter(|&c| c == '\u{FFFD}').count();
        println!("[mobi-engine] 编码诊断: 共发现 {} 个 U+FFFD 替换字符", total);
    }
}

// ====================== INDX/NCX 目录解析 ======================

/// NCX 目录条目
pub(super) struct NcxEntry {
    pub label: String,
    pub offset: usize,
    pub heading_level: u32,
    pub parent: Option<usize>,
    pub first_child: Option<usize>,
    pub last_child: Option<usize>,
}

/// 从 MOBI 二进制数据中提取 INDX/NCX 目录
pub(super) fn extract_ncx_toc(data: &[u8]) -> Option<Vec<NcxEntry>> {
    let offsets = parse_record_offsets(data)?;
    let (_, mobi) = parse_headers_with_offsets(data, &offsets)?;
    let indx_index = mobi.indx as usize;
    if indx_index == 0 || indx_index >= 0xFFFFFFFF || indx_index >= offsets.len() {
        return None;
    }
    let encoding_val = mobi.encoding;
    let encoding = map_mobi_encoding(encoding_val).unwrap_or(encoding_rs::UTF_8);

    parse_ncx_from_indx(data, &offsets, indx_index, encoding)
}

/// 解析 INDX 记录的公共头部
#[allow(dead_code)]
struct IndxHeader {
    length: usize,
    idx_type: u32,
    idxt_offset: usize,
    num_records: usize,
    idx_encoding: u32,
    num_cncx: usize,
}

fn parse_indx_header(rec: &[u8]) -> Option<IndxHeader> {
    if rec.len() < 56 || &rec[0..4] != b"INDX" {
        return None;
    }
    let length = read_u32_safe(rec, 4) as usize;
    let idx_type = read_u32_safe(rec, 8);
    let idxt_offset = read_u32_safe(rec, 20) as usize;
    let num_records = read_u32_safe(rec, 24) as usize;
    let idx_encoding = read_u32_safe(rec, 28);
    let num_cncx = read_u32_safe(rec, 52) as usize;
    Some(IndxHeader { length, idx_type, idxt_offset, num_records, idx_encoding, num_cncx })
}

/// 解析 TAGX 标签表
struct TagxInfo {
    num_control_bytes: usize,
    tags: Vec<[u8; 4]>,
}

fn parse_tagx(rec: &[u8], tagx_offset: usize) -> Option<TagxInfo> {
    if tagx_offset + 12 > rec.len() || &rec[tagx_offset..tagx_offset + 4] != b"TAGX" {
        return None;
    }
    let tagx_len = read_u32_safe(rec, tagx_offset + 4) as usize;
    let num_control_bytes = read_u32_safe(rec, tagx_offset + 8) as usize;
    let num_tags = (tagx_len - 12) / 4;
    let mut tags = Vec::with_capacity(num_tags);
    for i in 0..num_tags {
        let off = tagx_offset + 12 + i * 4;
        if off + 4 > rec.len() {
            break;
        }
        tags.push([rec[off], rec[off + 1], rec[off + 2], rec[off + 3]]);
    }
    Some(TagxInfo { num_control_bytes, tags })
}

/// 读取变长整数（VarLen），返回 (value, consumed_bytes)
fn read_varlen(data: &[u8], pos: usize) -> (usize, usize) {
    let mut value = 0usize;
    let mut consumed = 0usize;
    for i in 0..4 {
        if pos + i >= data.len() {
            break;
        }
        let b = data[pos + i];
        value = (value << 7) | (b & 0x7F) as usize;
        consumed += 1;
        if b & 0x80 != 0 {
            break;
        }
    }
    (value, consumed)
}

/// 统计 u8 值中设置位的数量
fn count_bits_set(mut x: u8) -> u32 {
    let mut count = 0u32;
    while x > 0 {
        count += (x & 1) as u32;
        x >>= 1;
    }
    count
}

/// 统计 u8 值中末尾连续未设置位的数量
fn count_unset_end(mut x: u8) -> u32 {
    if x == 0 { return 8; }
    let mut count = 0u32;
    while x & 1 == 0 {
        x >>= 1;
        count += 1;
    }
    count
}

fn read_u32_safe(data: &[u8], offset: usize) -> u32 {
    if offset + 4 > data.len() { return 0; }
    u32::from_be_bytes([data[offset], data[offset + 1], data[offset + 2], data[offset + 3]])
}

fn read_u16_safe(data: &[u8], offset: usize) -> u16 {
    if offset + 2 > data.len() { return 0; }
    u16::from_be_bytes([data[offset], data[offset + 1]])
}

/// 获取 record 的字节切片
fn get_record<'a>(data: &'a [u8], offsets: &[usize], index: usize) -> Option<&'a [u8]> {
    if index >= offsets.len() { return None; }
    let start = offsets[index];
    let end = if index + 1 < offsets.len() { offsets[index + 1] } else { data.len() };
    if start >= data.len() || end > data.len() || start >= end { return None; }
    Some(&data[start..end])
}

/// 解析 CNCX 字符串表
fn parse_cncx(
    data: &[u8],
    offsets: &[usize],
    indx_index: usize,
    num_indx_records: usize,
    num_cncx: usize,
    encoding: &'static Encoding,
) -> std::collections::HashMap<usize, String> {
    let mut cncx = std::collections::HashMap::new();
    let mut record_offset = 0usize;
    for i in 0..num_cncx {
        let rec_idx = indx_index + num_indx_records + i + 1;
        let rec = match get_record(data, offsets, rec_idx) {
            Some(r) => r,
            None => break,
        };
        let mut pos = 0;
        while pos < rec.len() {
            let index = pos;
            let (str_len, consumed) = read_varlen(rec, pos);
            pos += consumed;
            if pos + str_len > rec.len() {
                break;
            }
            let (decoded, _, _) = encoding.decode(&rec[pos..pos + str_len]);
            cncx.insert(record_offset + index, decoded.to_string());
            pos += str_len;
        }
        record_offset += 0x10000;
    }
    cncx
}

/// 从 INDX data record 中解析每个条目的 tag map
fn parse_indx_data_entries(
    rec: &[u8],
    tagx: &TagxInfo,
) -> Vec<std::collections::HashMap<u8, Vec<usize>>> {
    let indx = match parse_indx_header(rec) {
        Some(h) => h,
        None => return vec![],
    };
    let mut entries = Vec::with_capacity(indx.num_records);
    for j in 0..indx.num_records {
        let offset_offset = indx.idxt_offset + 4 + 2 * j;
        let entry_offset = read_u16_safe(rec, offset_offset) as usize;
        if entry_offset >= rec.len() { continue; }

        let name_len = rec.get(entry_offset).copied().unwrap_or(0) as usize;
        let start_pos = entry_offset + 1 + name_len;

        let mut tag_map: std::collections::HashMap<u8, Vec<usize>> = std::collections::HashMap::new();
        let mut control_byte_index = 0usize;
        let mut pos = start_pos + tagx.num_control_bytes;

        for tag_entry in &tagx.tags {
            let tag = tag_entry[0];
            let num_values = tag_entry[1];
            let mask = tag_entry[2];
            let end_flag = tag_entry[3];

            if end_flag & 1 != 0 {
                control_byte_index += 1;
                continue;
            }

            let cb_offset = start_pos + control_byte_index;
            let control_byte = rec.get(cb_offset).copied().unwrap_or(0);
            let value = control_byte & mask;

            let (value_count, value_bytes) = if value == mask {
                if count_bits_set(mask) > 1 {
                    let (v, l) = read_varlen(rec, pos);
                    pos += l;
                    (None, Some(v))
                } else {
                    (Some(1usize), None)
                }
            } else {
                (Some((value >> count_unset_end(mask)) as usize), None)
            };

            let mut values = Vec::new();
            if let Some(vc) = value_count {
                for _ in 0..(vc * num_values as usize) {
                    if pos >= rec.len() { break; }
                    let (v, l) = read_varlen(rec, pos);
                    values.push(v);
                    pos += l;
                }
            } else if let Some(vb) = value_bytes {
                let mut count = 0usize;
                while count < vb {
                    if pos >= rec.len() { break; }
                    let (v, l) = read_varlen(rec, pos);
                    values.push(v);
                    pos += l;
                    count += l;
                }
            }

            if !values.is_empty() {
                tag_map.insert(tag, values);
            }
        }
        entries.push(tag_map);
    }
    entries
}

/// 从 INDX 记录解析 NCX 目录
fn parse_ncx_from_indx(
    data: &[u8],
    offsets: &[usize],
    indx_index: usize,
    encoding: &'static Encoding,
) -> Option<Vec<NcxEntry>> {
    // 读取 INDX 主记录（索引头）
    let indx_rec = get_record(data, offsets, indx_index)?;
    let indx_header = parse_indx_header(indx_rec)?;

    // 解析 TAGX
    let tagx = parse_tagx(indx_rec, indx_header.length)?;

    // 解析 CNCX 字符串表
    let cncx = parse_cncx(
        data,
        offsets,
        indx_index,
        indx_header.num_records,
        indx_header.num_cncx,
        encoding,
    );

    // 遍历 INDX data records
    let mut all_entries = Vec::new();
    for i in 0..indx_header.num_records {
        let rec_idx = indx_index + 1 + i;
        let rec = match get_record(data, offsets, rec_idx) {
            Some(r) => r,
            None => continue,
        };
        let entries = parse_indx_data_entries(rec, &tagx);
        all_entries.extend(entries);
    }

    if all_entries.is_empty() {
        return None;
    }

    // 将 tag map 转换为 NcxEntry
    let mut ncx = Vec::with_capacity(all_entries.len());
    for tag_map in &all_entries {
        // tag 1 = offset, tag 3 = cncx label index, tag 4 = heading level
        // tag 21 = parent, tag 22 = first child, tag 23 = last child
        let offset = tag_map.get(&1).and_then(|v| v.first().copied()).unwrap_or(0);
        let label_idx = tag_map.get(&3).and_then(|v| v.first().copied());
        let heading_level = tag_map.get(&4).and_then(|v| v.first().copied()).unwrap_or(0) as u32;
        let parent = tag_map.get(&21).and_then(|v| v.first().copied());
        let first_child = tag_map.get(&22).and_then(|v| v.first().copied());
        let last_child = tag_map.get(&23).and_then(|v| v.first().copied());

        let label = label_idx
            .and_then(|idx| cncx.get(&idx))
            .cloned()
            .unwrap_or_default();

        ncx.push(NcxEntry {
            label,
            offset,
            heading_level,
            parent,
            first_child,
            last_child,
        });
    }

    if ncx.is_empty() || ncx.iter().all(|e| e.label.is_empty()) {
        return None;
    }

    println!("[mobi-engine] INDX/NCX 解析成功: {} 项", ncx.len());
    Some(ncx)
}
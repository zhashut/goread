//! 朗读文本过滤：交给语音引擎前剔除引号类符号

/// 剔除引号类符号（双引号、单引号及其中文/全角/弯引号变体），其余标点保持原样
///
/// 背景：部分语音引擎会把引号逐字朗读出来（如读出「双引号」），因此在把文本交给
/// 引擎前统一剔除；逗号、句号等承担停顿的标点必须保留，否则朗读会失去句读节奏。
///
/// 说明：
/// - 过滤仅作用于朗读文本；anchor（quote/prefix/suffix）仍基于原文生成，
///   高亮与跟读定位不受影响；
/// - 剔除后前后文字直接拼接（如 `他说“你好”` → `他说你好`），不影响朗读；
/// - 整段只有引号时返回空串，调用方需据此跳过该片段。
pub fn strip_speech_quotes(text: &str) -> String {
    let filtered: String = text.chars().filter(|ch| !is_speech_quote(*ch)).collect();
    filtered.trim().to_string()
}

/// 判断字符是否为需要剔除的引号类符号
fn is_speech_quote(ch: char) -> bool {
    matches!(
        ch,
        '"' | '\'' | '`'                    // 直双引号 / 直单引号 / 反引号
            | '\u{00AB}' | '\u{00BB}'       // « »
            | '\u{2018}' | '\u{2019}'       // ‘ ’
            | '\u{201A}' | '\u{201B}'       // ‚ ‛
            | '\u{201C}' | '\u{201D}'       // “ ”
            | '\u{201E}' | '\u{201F}'       // „ ‟
            | '\u{2039}' | '\u{203A}'       // ‹ ›
            | '\u{300C}' | '\u{300D}'       // 「 」
            | '\u{300E}' | '\u{300F}'       // 『 』
            | '\u{301D}' | '\u{301E}' | '\u{301F}' // 〝 〞 〟
            | '\u{FF02}' | '\u{FF07}'       // ＂ ＇
            | '\u{FF62}' | '\u{FF63}' // ｢ ｣
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_quotes_but_keeps_pause_punctuation() {
        assert_eq!(
            strip_speech_quotes("他说：“你好，世界！”"),
            "他说：你好，世界！"
        );
        assert_eq!(strip_speech_quotes("\"Hello, world!\""), "Hello, world!");
    }

    #[test]
    fn removes_cjk_and_fullwidth_quotes() {
        assert_eq!(strip_speech_quotes("『书名』（作者）"), "书名（作者）");
        assert_eq!(strip_speech_quotes("「あ」と『い』"), "あとい");
        assert_eq!(strip_speech_quotes("＂全角＇引号"), "全角引号");
    }

    #[test]
    fn keeps_other_punctuation() {
        assert_eq!(strip_speech_quotes("，。！？；：、——……"), "，。！？；：、——……");
        // 整段只有引号时视为无可朗读内容
        assert_eq!(strip_speech_quotes("\"''「"), "");
    }
}

//! TXT 目录解析器
//! 实现多模式正则匹配、启发式分析和层级目录构建

use once_cell::sync::Lazy;
use regex::Regex;

use crate::formats::{TocItem, TocLocation};

/// 章节模式定义
struct ChapterPatternDef {
    /// 正则表达式字符串
    pattern: &'static str,
    /// 章节级别（0=卷/部，1=章，2=节）
    level: u32,
    /// 模式优先级（越高越可信）
    priority: i32,
    /// 模式名称
    name: &'static str,
}

/// 预定义的章节模式集合
const CHAPTER_PATTERN_DEFS: &[ChapterPatternDef] = &[
    // === 高优先级：明确的章节格式 ===
    // 标准"第X章"格式
    ChapterPatternDef {
        pattern: r"^第[零一二三四五六七八九十百千万\d]+章\s*.+",
        level: 1,
        priority: 100,
        name: "chinese_chapter",
    },
    // 带冒号的章节
    ChapterPatternDef {
        pattern: r"^第[零一二三四五六七八九十百千万\d]+章[：:]\s*.+",
        level: 1,
        priority: 100,
        name: "chinese_chapter_colon",
    },
    // 括号包裹的章节 【第X章】
    ChapterPatternDef {
        pattern: r"^[【\[「]第[零一二三四五六七八九十百千万\d]+[章节回][】\]」]\s*.*",
        level: 1,
        priority: 95,
        name: "chinese_chapter_bracket",
    },
    // === 中优先级：卷/部/篇结构 ===
    // 卷结构：卷X 或 卷X标题
    ChapterPatternDef {
        pattern: r"^卷[零一二三四五六七八九十百千万\d]+\s*.*",
        level: 0,
        priority: 90,
        name: "chinese_volume",
    },
    // 部/篇/集结构
    ChapterPatternDef {
        pattern: r"^[部篇集][零一二三四五六七八九十百千万\d]+\s*.+",
        level: 0,
        priority: 90,
        name: "chinese_part",
    },
    // "正文 卷X"格式
    ChapterPatternDef {
        pattern: r"^正文\s*[卷部篇][零一二三四五六七八九十百千万\d]+\s*.*",
        level: 0,
        priority: 85,
        name: "chinese_volume_prefix",
    },
    // === 特殊章节 ===
    // 序章/楔子等（可带标题）
    ChapterPatternDef {
        pattern: r"^(楔子|序章|序言|序幕|引子|前言)[：:\s]?.*",
        level: 0,
        priority: 80,
        name: "chinese_prologue",
    },
    // 尾声/后记等（可带标题）
    ChapterPatternDef {
        pattern: r"^(尾声|后记|终章|完结|大结局)[：:\s]?.*",
        level: 0,
        priority: 80,
        name: "chinese_epilogue",
    },
    // 番外篇（带编号或标题）
    ChapterPatternDef {
        pattern: r"^番外[零一二三四五六七八九十百千万\d]*[：:\s]?.*",
        level: 1,
        priority: 75,
        name: "chinese_extra",
    },
    // === 变体格式 ===
    // 第X节/回
    ChapterPatternDef {
        pattern: r"^第[零一二三四五六七八九十百千万\d]+[节回]\s*.+",
        level: 2,
        priority: 70,
        name: "chinese_section",
    },
    // 纯数字章节 "001 标题" 或 "001.标题"
    ChapterPatternDef {
        pattern: r"^\d{1,4}[.、\s]\s*.{2,}",
        level: 1,
        priority: 60,
        name: "numeric_chapter",
    },
    // 中文数字序号 "一、标题" 或 "一. 标题"
    ChapterPatternDef {
        pattern: r"^[一二三四五六七八九十百]+[、.]\s*.+",
        level: 1,
        priority: 60,
        name: "chinese_numeric",
    },
    // === 英文格式 ===
    ChapterPatternDef {
        pattern: r"(?i)^Chapter\s+(\d+|[IVXLCM]+)\s*.*",
        level: 1,
        priority: 95,
        name: "english_chapter",
    },
    ChapterPatternDef {
        pattern: r"(?i)^(Part|Volume|Book)\s+(\d+|[IVXLCM]+)\s*.*",
        level: 0,
        priority: 90,
        name: "english_part",
    },
    ChapterPatternDef {
        pattern: r"(?i)^Section\s+(\d+|[IVXLCM]+)\s*.*",
        level: 2,
        priority: 70,
        name: "english_section",
    },
    // Prologue / Epilogue
    ChapterPatternDef {
        pattern: r"(?i)^(Prologue|Epilogue|Introduction|Preface|Foreword)\s*.*",
        level: 0,
        priority: 80,
        name: "english_prologue",
    },
];

/// 编译后的章节模式
struct CompiledPattern {
    regex: Regex,
    level: u32,
    priority: i32,
    name: &'static str,
}

/// 预编译的正则表达式集合
static COMPILED_PATTERNS: Lazy<Vec<CompiledPattern>> = Lazy::new(|| {
    CHAPTER_PATTERN_DEFS
        .iter()
        .filter_map(|def| {
            Regex::new(def.pattern).ok().map(|regex| CompiledPattern {
                regex,
                level: def.level,
                priority: def.priority,
                name: def.name,
            })
        })
        .collect()
});

/// 候选章节信息
#[derive(Debug)]
struct CandidateChapter {
    /// 原始标题
    title: String,
    /// 字符偏移量
    char_offset: usize,
    /// 行号
    line_number: usize,
    /// 匹配的模式名称
    pattern_name: String,
    /// 模式级别
    level: u32,
    /// 初始优先级
    pattern_priority: i32,
    /// 最终置信度分数（0-100）
    confidence: i32,
}

/// 文本上下文，用于启发式分析
struct TextContext<'a> {
    lines: &'a [String],
    /// 记录各模式出现次数
    pattern_counts: std::collections::HashMap<String, usize>,
}

impl<'a> TextContext<'a> {
    fn new(lines: &'a [String]) -> Self {
        Self {
            lines,
            pattern_counts: std::collections::HashMap::new(),
        }
    }

    /// 检查指定行前面是否有空行
    fn has_empty_line_before(&self, line_number: usize) -> bool {
        if line_number == 0 {
            return true; // 文件开头视为有空行
        }
        if line_number > 0 && line_number <= self.lines.len() {
            let prev_line = &self.lines[line_number - 1];
            return prev_line.trim().is_empty();
        }
        false
    }

    /// 检查指定行后面是否有空行
    fn has_empty_line_after(&self, line_number: usize) -> bool {
        if line_number + 1 >= self.lines.len() {
            return true; // 文件末尾视为有空行
        }
        let next_line = &self.lines[line_number + 1];
        next_line.trim().is_empty()
    }

    /// 检查是否在行首（无前导空格）
    fn is_line_start(&self, line_number: usize) -> bool {
        if line_number < self.lines.len() {
            let line = &self.lines[line_number];
            !line.is_empty() && !line.starts_with(' ') && !line.starts_with('\t')
        } else {
            false
        }
    }

    /// 记录模式出现次数
    fn record_pattern(&mut self, pattern_name: &str) {
        *self
            .pattern_counts
            .entry(pattern_name.to_string())
            .or_insert(0) += 1;
    }

    /// 获取相似模式出现次数
    fn similar_pattern_count(&self, pattern_name: &str) -> usize {
        *self.pattern_counts.get(pattern_name).unwrap_or(&0)
    }
}

/// 上下文感知的层级分配器
/// 根据前后文动态判断章节级别
struct LevelAssigner {
    /// 是否遇到过明确的章级别标题（如"第X章"）
    has_explicit_chapter: bool,
    /// 模式统计：用于判断 chinese_numeric 的真实级别
    chapter_count: usize,
    numeric_count: usize,
}

impl LevelAssigner {
    fn new() -> Self {
        Self {
            has_explicit_chapter: false,
            chapter_count: 0,
            numeric_count: 0,
        }
    }

    /// 预扫描候选章节，统计模式出现次数
    fn pre_scan(&mut self, candidates: &[CandidateChapter]) {
        for c in candidates {
            match c.pattern_name.as_str() {
                "chinese_chapter" | "chinese_chapter_colon" | "chinese_chapter_bracket" => {
                    self.chapter_count += 1;
                }
                "chinese_numeric" => {
                    self.numeric_count += 1;
                }
                _ => {}
            }
        }
    }

    /// 根据上下文动态分配级别
    /// 返回调整后的级别
    fn assign_level(&mut self, pattern_name: &str, original_level: u32) -> u32 {
        match pattern_name {
            // 卷/部级别，重置章级别标记
            "chinese_volume" | "chinese_part" | "chinese_volume_prefix" => {
                self.has_explicit_chapter = false;
                0
            }
            // 明确的章级别
            "chinese_chapter" | "chinese_chapter_colon" | "chinese_chapter_bracket" => {
                self.has_explicit_chapter = true;
                1
            }
            // 中文数字序号需要根据上下文判断
            "chinese_numeric" => {
                // 如果存在明确的章级别，并且 numeric 出现次数远多于 chapter，认为是节级别
                if self.has_explicit_chapter {
                    return 2; // 作为节级别（章的子级）
                }
                // 如果 chapter 数量大于 0 且 numeric 数量明显多于 chapter，认为是节级别
                if self.chapter_count > 0 && self.numeric_count > self.chapter_count * 2 {
                    return 2;
                }
                // 否则保持原级别（章级别）
                original_level
            }
            // 其他模式保持原级别
            _ => original_level,
        }
    }

    /// 记录遇到的模式，更新状态
    fn record_pattern(&mut self, pattern_name: &str) {
        match pattern_name {
            "chinese_chapter" | "chinese_chapter_colon" | "chinese_chapter_bracket" => {
                self.has_explicit_chapter = true;
            }
            "chinese_volume" | "chinese_part" | "chinese_volume_prefix" => {
                self.has_explicit_chapter = false;
            }
            _ => {}
        }
    }
}

/// 检查标题是否包含常见章节词汇
fn contains_chapter_keywords(title: &str) -> bool {
    let keywords = [
        "章", "节", "回", "卷", "部", "篇", "集", "楔子", "序章", "尾声", "后记", "番外",
    ];
    keywords.iter().any(|kw| title.contains(kw))
}

/// 检查标题是否以句子标点结尾（可能是正文）
fn ends_with_sentence_punctuation(title: &str) -> bool {
    let punctuations = ['。', '！', '？', '…', '.', '!', '?'];
    title.chars().last().map_or(false, |c| punctuations.contains(&c))
}

/// 计算候选章节的置信度分数
fn calculate_confidence(candidate: &mut CandidateChapter, context: &TextContext) {
    let mut score = candidate.pattern_priority;

    // === 位置特征加分 ===
    // 前面有空行 +10
    if context.has_empty_line_before(candidate.line_number) {
        score += 10;
    }
    // 后面有空行 +5
    if context.has_empty_line_after(candidate.line_number) {
        score += 5;
    }
    // 在行首（无前导空格）+5
    if context.is_line_start(candidate.line_number) {
        score += 5;
    }

    // === 长度特征 ===
    let title_len = candidate.title.chars().count();
    // 标题过长 -20（可能是误匹配的正文）
    if title_len > 50 {
        score -= 20;
    }
    // 标题过短（只有格式部分）-10
    if title_len < 4 {
        score -= 10;
    }
    // 合理长度 +5
    if title_len >= 4 && title_len <= 30 {
        score += 5;
    }

    // === 内容特征 ===
    // 包含常见章节词汇 +5
    if contains_chapter_keywords(&candidate.title) {
        score += 5;
    }
    // 标题以句子标点结尾 -10（可能是正文句子）
    if ends_with_sentence_punctuation(&candidate.title) {
        score -= 10;
    }

    // === 频率特征 ===
    // 相似格式出现多次 +15
    if context.similar_pattern_count(&candidate.pattern_name) >= 3 {
        score += 15;
    }

    // 归一化到 0-100
    candidate.confidence = score.clamp(0, 100);
}

/// TOC 解析配置
pub struct TocParserConfig {
    /// 最小置信度阈值（低于此值的章节会被过滤）
    pub min_confidence: i32,
    /// 启用启发式分析
    pub enable_heuristics: bool,
    /// 启用智能兜底分段
    pub enable_smart_fallback: bool,
    /// 兜底分段的最小章节数阈值
    pub fallback_threshold: usize,
}

impl Default for TocParserConfig {
    fn default() -> Self {
        Self {
            min_confidence: 50,
            enable_heuristics: true,
            enable_smart_fallback: true,
            fallback_threshold: 3,
        }
    }
}

/// TOC 解析器
pub struct TocParser {
    config: TocParserConfig,
}

impl TocParser {
    /// 创建默认配置的解析器
    pub fn new() -> Self {
        Self {
            config: TocParserConfig::default(),
        }
    }

    /// 使用自定义配置创建解析器
    #[allow(dead_code)]
    pub fn with_config(config: TocParserConfig) -> Self {
        Self { config }
    }

    /// 解析文本内容，生成目录
    pub fn parse(&self, content: &str, lines: &[String]) -> Vec<TocItem> {
        // Stage 1: 多模式正则匹配
        let mut candidates = self.match_patterns(lines);

        // Stage 2: 启发式分析与置信度评分
        if self.config.enable_heuristics {
            self.analyze_candidates(&mut candidates, lines);
        }

        // Stage 3: 过滤并构建层级目录
        let toc = self.build_toc_tree(candidates);

        // 兜底策略
        if self.config.enable_smart_fallback
            && toc.len() < self.config.fallback_threshold
            && lines.len() > 100
        {
            return self.smart_segmentation(content, lines);
        }

        // 如果仍然没有目录，创建默认条目
        if toc.is_empty() {
            return vec![TocItem {
                title: "开始".to_string(),
                location: TocLocation::Page(0),
                level: 0,
                children: vec![],
            }];
        }

        toc
    }

    /// Stage 1: 多模式正则匹配
    fn match_patterns(&self, lines: &[String]) -> Vec<CandidateChapter> {
        let mut candidates = Vec::new();
        let mut char_offset = 0usize;

        for (line_num, line) in lines.iter().enumerate() {
            let trimmed = line.trim();

            // 跳过空行
            if trimmed.is_empty() {
                char_offset += line.chars().count() + 1;
                continue;
            }

            // 尝试匹配所有模式
            for pattern in COMPILED_PATTERNS.iter() {
                if pattern.regex.is_match(trimmed) {
                    candidates.push(CandidateChapter {
                        title: trimmed.to_string(),
                        char_offset,
                        line_number: line_num,
                        pattern_name: pattern.name.to_string(),
                        level: pattern.level,
                        pattern_priority: pattern.priority,
                        confidence: pattern.priority, // 初始置信度为优先级
                    });
                    break; // 每行只匹配第一个模式
                }
            }

            char_offset += line.chars().count() + 1;
        }

        candidates
    }

    /// Stage 2: 启发式分析与置信度评分
    fn analyze_candidates(&self, candidates: &mut [CandidateChapter], lines: &[String]) {
        // 创建上下文
        let mut context = TextContext::new(lines);

        // 先统计各模式出现次数
        for candidate in candidates.iter() {
            context.record_pattern(&candidate.pattern_name);
        }

        // 计算每个候选的置信度
        for candidate in candidates.iter_mut() {
            calculate_confidence(candidate, &context);
        }
    }

    /// Stage 3: 构建层级目录树
    fn build_toc_tree(&self, candidates: Vec<CandidateChapter>) -> Vec<TocItem> {
        // 过滤低置信度章节
        let valid_chapters: Vec<_> = candidates
            .into_iter()
            .filter(|c| c.confidence >= self.config.min_confidence)
            .collect();

        // 创建层级分配器并预扫描
        let mut level_assigner = LevelAssigner::new();
        level_assigner.pre_scan(&valid_chapters);

        let mut root: Vec<TocItem> = Vec::new();
        let mut current_volume_idx: Option<usize> = None;
        let mut current_chapter_idx: Option<usize> = None;

        for chapter in valid_chapters {
            // 动态分配级别
            let adjusted_level = level_assigner.assign_level(&chapter.pattern_name, chapter.level);
            level_assigner.record_pattern(&chapter.pattern_name);

            let item = TocItem {
                title: chapter.title,
                location: TocLocation::Page(chapter.char_offset as u32),
                level: adjusted_level,
                children: vec![],
            };

            match adjusted_level {
                0 => {
                    // 卷/部级别，作为根节点
                    root.push(item);
                    current_volume_idx = Some(root.len() - 1);
                    current_chapter_idx = None; // 新卷重置章索引
                }
                1 => {
                    // 章级别
                    if let Some(vol_idx) = current_volume_idx {
                        root[vol_idx].children.push(item);
                        current_chapter_idx = Some(root[vol_idx].children.len() - 1);
                    } else {
                        root.push(item);
                        current_chapter_idx = Some(root.len() - 1);
                        current_volume_idx = None; // 无卷时章作为根，重置卷索引
                    }
                }
                _ => {
                    // 节级别（level >= 2）
                    // 优先挂到当前章下，否则挂到当前卷下，最后挂到根
                    if let Some(vol_idx) = current_volume_idx {
                        if let Some(ch_idx) = current_chapter_idx {
                            // 挂到当前卷下的当前章
                            if ch_idx < root[vol_idx].children.len() {
                                root[vol_idx].children[ch_idx].children.push(item);
                            } else {
                                root[vol_idx].children.push(item);
                            }
                        } else if let Some(last_chapter) = root[vol_idx].children.last_mut() {
                            last_chapter.children.push(item);
                        } else {
                            root[vol_idx].children.push(item);
                        }
                    } else if let Some(ch_idx) = current_chapter_idx {
                        // 无卷但有章，挂到根级别的章下
                        if ch_idx < root.len() {
                            root[ch_idx].children.push(item);
                        } else if let Some(last) = root.last_mut() {
                            last.children.push(item);
                        } else {
                            root.push(item);
                        }
                    } else if let Some(last_chapter) = root.last_mut() {
                        last_chapter.children.push(item);
                    } else {
                        root.push(item);
                    }
                }
            }
        }

        root
    }

    /// 智能分段策略（兜底）
    fn smart_segmentation(&self, content: &str, lines: &[String]) -> Vec<TocItem> {
        let total_chars = content.chars().count();
        let total_lines = lines.len();

        // 策略：基于段落密度自动计算分段大小
        let avg_line_length = total_chars / total_lines.max(1);
        let target_segment_chars = 10000; // 约 10KB 一个分段
        let segment_lines = (target_segment_chars / avg_line_length.max(1)).clamp(100, 500);

        let mut toc = Vec::new();
        let mut offset = 0usize;
        let mut segment_num = 1;

        for (i, line) in lines.iter().enumerate() {
            if i > 0 && i % segment_lines == 0 {
                // 尝试向前/后搜索最近的空行作为断点
                let break_point = self.find_natural_break(lines, i, segment_lines / 4);
                if break_point > 0 {
                    let break_offset = self.calculate_offset(lines, break_point);
                    toc.push(TocItem {
                        title: format!("第 {} 部分", segment_num),
                        location: TocLocation::Page(break_offset as u32),
                        level: 1,
                        children: vec![],
                    });
                    segment_num += 1;
                }
            }
            offset += line.len() + 1;
        }

        // 始终添加开头
        if toc.is_empty() || !matches!(toc[0].location, TocLocation::Page(0)) {
            toc.insert(
                0,
                TocItem {
                    title: "开始".to_string(),
                    location: TocLocation::Page(0),
                    level: 0,
                    children: vec![],
                },
            );
        }

        toc
    }

    /// 寻找自然断点（空行位置）
    fn find_natural_break(&self, lines: &[String], target: usize, search_range: usize) -> usize {
        // 向前搜索
        for i in (target.saturating_sub(search_range)..target).rev() {
            if i < lines.len() && lines[i].trim().is_empty() {
                return i + 1; // 返回空行后的位置
            }
        }
        // 向后搜索
        for i in target..std::cmp::min(target + search_range, lines.len()) {
            if lines[i].trim().is_empty() {
                return i + 1;
            }
        }
        target
    }

    /// 计算指定行的字符偏移量
    fn calculate_offset(&self, lines: &[String], line_number: usize) -> usize {
        let mut offset = 0;
        for line in lines.iter().take(line_number) {
            offset += line.chars().count() + 1;
        }
        offset
    }
}

impl Default for TocParser {
    fn default() -> Self {
        Self::new()
    }
}

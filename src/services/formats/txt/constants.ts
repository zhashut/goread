/**
 * TXT 进度坐标常量
 * 全模块统一使用"章节精确进度"：chapterIndex + 1 + offset
 * 以下常量用于规范化 offset 的取值范围，避免各处魔法数字不一致
 */

/** 章节内偏移量上限：offset ∈ [0, TXT_CHAPTER_OFFSET_MAX)
 * 取 0.9999 而不是 1，避免与"下一章开头"产生歧义
 */
export const TXT_CHAPTER_OFFSET_MAX = 0.9999;

/** 精确进度上限增量：max = total + TXT_PROGRESS_MAX_DELTA
 * 用于标记"章内/书内已到末尾"的浮点进度上限
 */
export const TXT_PROGRESS_MAX_DELTA = 0.999999;

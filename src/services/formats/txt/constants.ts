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

/**
 * 纵向滚动「贴边」容差（像素）
 * 视口距容器底部不足该值时视为已无可滚动余量：
 * 此时继续向下滑动不会产生 scroll 事件，依赖滚动事件的章节预追加会失效，
 * 必须由程序主动检查（入场预热 / 贴底补追加）兜底
 */
export const TXT_SCROLL_EDGE_TOLERANCE_PX = 2;

/**
 * 入场预热时允许连续追加的最大章节数
 * 用于兜底「整章不足一屏」的极端情况（如连续空章节），避免长时间阻塞入场
 */
export const TXT_INIT_APPEND_MAX_CHAPTERS = 3;

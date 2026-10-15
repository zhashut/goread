/**
 * EPUB 阅读顺序（Reading Order）
 *
 * EPUB3 的导航文档（nav.xhtml / nav.html）允许被放进 spine，
 * 但它属于机器可读目录，不应当作正文渲染。
 *
 * 设计约束（兼容性优先）：
 * - **章节索引保持稳定**：隐藏章节只做“不可见”标记，不从章节数组 / 缓存中移除，
 *   因此 `books.current_page`、书签、章节缓存索引的语义完全不变；
 * - 隐藏集合为空时（EPUB2 以及绝大多数 EPUB3）全部方法退化为恒等映射，
 *   调用方无需写分支，行为与改造前完全一致。
 */
export interface EpubReadingOrder {
  /** 该章节是否参与阅读顺序 */
  isVisible(sectionIndex: number): boolean;
  /** 下一个可见章节；已知总章节数且已到末尾时返回 -1 */
  nextVisible(sectionIndex: number): number;
  /** 上一个可见章节；已在开头时返回 -1 */
  prevVisible(sectionIndex: number): number;
  /**
   * 距该下标最近的可见章节。
   * 全部隐藏或越界时返回原值，由调用方按章节总数兜底。
   */
  nearestVisible(sectionIndex: number): number;
}

/**
 * 创建阅读顺序视图。
 *
 * @param hiddenSections 不参与阅读顺序的章节下标（原始 spine 下标）
 * @param sectionCount   书籍总章节数（原始 spine 长度）；提供后可剔除越界下标，
 *                       并让 `nextVisible` 在末尾返回 -1
 */
export function createEpubReadingOrder(
  hiddenSections?: readonly number[] | null,
  sectionCount?: number,
): EpubReadingOrder {
  const total =
    typeof sectionCount === "number" && sectionCount > 0 ? sectionCount : 0;
  const hidden = Array.from(
    new Set(
      (hiddenSections ?? []).filter(
        (n) => Number.isInteger(n) && n >= 0 && (total === 0 || n < total),
      ),
    ),
  ).sort((a, b) => a - b);

  /** 越界（末尾之后）统一返回 -1，仅当已知总章节数时判定 */
  const clampNext = (cursor: number): number =>
    total > 0 && cursor >= total ? -1 : cursor;

  // 恒等快路径：EPUB2 等无隐藏章节的书籍，行为与改造前完全一致
  if (hidden.length === 0) {
    return {
      isVisible: () => true,
      nextVisible: (sectionIndex) => clampNext(sectionIndex + 1),
      prevVisible: (sectionIndex) => (sectionIndex > 0 ? sectionIndex - 1 : -1),
      nearestVisible: (sectionIndex) => sectionIndex,
    };
  }

  const hiddenSet = new Set(hidden);

  const nextVisible = (sectionIndex: number): number => {
    let cursor = sectionIndex + 1;
    while (hiddenSet.has(cursor)) cursor += 1;
    return clampNext(cursor);
  };

  const prevVisible = (sectionIndex: number): number => {
    let cursor = sectionIndex - 1;
    while (cursor >= 0 && hiddenSet.has(cursor)) cursor -= 1;
    return cursor;
  };

  return {
    isVisible: (sectionIndex) => !hiddenSet.has(sectionIndex),
    nextVisible,
    prevVisible,
    nearestVisible: (sectionIndex) => {
      if (!hiddenSet.has(sectionIndex)) return sectionIndex;
      // 优先向后吸附；后面已无可见章节（如导航文档位于书末）时回退向前
      const next = nextVisible(sectionIndex);
      if (next >= 0) return next;
      const prev = prevVisible(sectionIndex);
      return prev >= 0 ? prev : sectionIndex;
    },
  };
}

// ========== 页码视图（页码 = 章节索引 + 1，纵向/横向渲染 hook 共用） ==========

/** 最近的可见页码；整体隐藏时回退到第 1 页 */
export const nearestVisiblePage = (
  order: EpubReadingOrder,
  page: number,
): number => Math.max(1, order.nearestVisible(page - 1) + 1);

/** 下一个可见页码；无下一页时返回 -1 */
export const nextVisiblePage = (
  order: EpubReadingOrder,
  page: number,
): number => {
  const next = order.nextVisible(page - 1);
  return next < 0 ? -1 : next + 1;
};

/** 上一个可见页码；无上一页时返回 -1 */
export const prevVisiblePage = (
  order: EpubReadingOrder,
  page: number,
): number => {
  const prev = order.prevVisible(page - 1);
  return prev < 0 ? -1 : prev + 1;
};

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
  /** 下一个可见章节，不存在时返回 -1 */
  nextVisible(sectionIndex: number): number;
  /** 上一个可见章节，不存在时返回 -1 */
  prevVisible(sectionIndex: number): number;
  /** 距该下标最近的可见章节；全部隐藏时返回原值（由调用方兜底） */
  nearestVisible(sectionIndex: number): number;
}

/**
 * 创建阅读顺序视图。
 *
 * @param hiddenSections 不参与阅读顺序的章节下标（原始 spine 下标）
 * @param sectionCount   书籍总章节数（原始 spine 长度），用于剔除越界的隐藏下标
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

  // 恒等快路径：EPUB2 等无隐藏章节的书籍，行为与改造前完全一致
  if (hidden.length === 0) {
    return {
      isVisible: () => true,
      nextVisible: (sectionIndex) => sectionIndex + 1,
      prevVisible: (sectionIndex) => (sectionIndex > 0 ? sectionIndex - 1 : -1),
      nearestVisible: (sectionIndex) => sectionIndex,
    };
  }

  const hiddenSet = new Set(hidden);

  const nextVisible = (sectionIndex: number): number => {
    let cursor = sectionIndex + 1;
    while (hiddenSet.has(cursor)) cursor += 1;
    return cursor;
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
      const next = nextVisible(sectionIndex);
      if (!hiddenSet.has(next)) return next;
      const prev = prevVisible(sectionIndex);
      return prev >= 0 ? prev : sectionIndex;
    },
  };
}

/** 导航文档常见的文件名主干（不含扩展名） */
const NAV_FILENAME_STEMS = ["nav", "toc", "contents"];

/**
 * 零成本预筛：spine 中是否存在“看起来像导航文档”的 HTML 文件。
 *
 * 仅用于判断是否需要向后端确认隐藏章节（命中不代表一定是导航文档），
 * 绝大多数 EPUB2 书籍不会命中，因此可以完全跳过额外解析。
 */
export function mayContainNavigationDocument(
  spine?: readonly string[] | null,
): boolean {
  if (!spine || spine.length === 0) return false;
  return spine.some((path) => {
    const name = path.split("/").pop() ?? "";
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    return NAV_FILENAME_STEMS.includes(stem.toLowerCase());
  });
}

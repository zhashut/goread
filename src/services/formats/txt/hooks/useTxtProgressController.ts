export interface TxtProgressContext {
  getUseChapterMode: () => boolean;
  getChapterCount: () => number;
  getPageCount: () => number;
  getCurrentChapterIndex: () => number;
  getContainer: () => HTMLElement | null;
  isVerticalMode: () => boolean;
  getScrollHeight: () => number;
  getVerticalPageTops: () => number[];
  setVerticalPageTops: (tops: number[]) => void;
  getVerticalPageHeights: () => number[];
  setVerticalPageHeights: (heights: number[]) => void;
  getCurrentPreciseProgress: () => number;
  setCurrentPreciseProgress: (value: number) => void;
  getBookPreciseProgress: () => number;
  setBookPreciseProgress: (value: number) => void;
  getCurrentPage: () => number;
  setCurrentPage: (value: number) => void;
  goToPage: (page: number) => Promise<void>;
  goToChapter: (chapterIndex: number) => Promise<void>;
  getChapterIndexByPage?: (pageIndex: number) => number;
}

export interface TxtProgressController {
  getPreciseProgress: () => number;
  updatePreciseProgress: (progress: number) => void;
  refreshVerticalPageMap: (container?: HTMLElement) => void;
  getVirtualPreciseByScrollTop: (scrollTop: number) => number;
  convertChapterPreciseToVirtualPrecise: (chapterPrecise: number) => number;
  convertVirtualPreciseToChapterPrecise: (virtualPrecise: number) => number;
  jumpToPreciseProgress: (progress: number) => Promise<void>;
  calculateVirtualPages: (viewportHeight: number) => number;
  getCurrentVirtualPage: (scrollTop: number, viewportHeight: number) => number;
  scrollToVirtualPage: (page: number, viewportHeight: number) => void;
}

function clampChapterOffset(offset: number): number {
  if (!isFinite(offset)) return 0;
  if (offset < 0) return 0;
  if (offset > 0.9999) return 0.9999;
  return offset;
}

export function useTxtProgressController(
  context: TxtProgressContext
): TxtProgressController {
  const getPreciseProgress = (): number => {
    if (context.getUseChapterMode()) {
      return context.getBookPreciseProgress();
    }
    return context.getCurrentPreciseProgress();
  };

  const updatePreciseProgress = (progress: number): void => {
    if (context.getUseChapterMode()) {
      const total = context.getChapterCount() || 1;
      const max = total + 0.999999;
      const value = Math.max(1, Math.min(progress, max));
      context.setBookPreciseProgress(value);
      return;
    }
    const total = context.getPageCount() || 1;
    // 允许精确进度略超过整数页数（最后一页内的小数偏移），与章节模式保持一致
    const max = total + 0.999999;
    const value = Math.max(1, Math.min(progress, max));
    context.setCurrentPreciseProgress(value);
  };

  const refreshVerticalPageMap = (container?: HTMLElement): void => {
    const target = container || context.getContainer();
    if (!target) {
      context.setVerticalPageTops([]);
      context.setVerticalPageHeights([]);
      return;
    }
    const wrappers = target.querySelectorAll(
      '[data-page-index]'
    ) as NodeListOf<HTMLElement>;
    const tops: number[] = new Array(wrappers.length);
    const heights: number[] = new Array(wrappers.length);
    wrappers.forEach((el, i) => {
      tops[i] = el.offsetTop;
      heights[i] = el.scrollHeight || el.offsetHeight || 1;
    });
    context.setVerticalPageTops(tops);
    context.setVerticalPageHeights(heights);
  };

  const getVirtualPreciseByScrollTop = (scrollTop: number): number => {
    const tops = context.getVerticalPageTops();
    const heights = context.getVerticalPageHeights();
    const total = tops.length;
    if (total <= 0) {
      const container = context.getContainer();
      if (!container) return 1;
      const viewportHeight = container.clientHeight;
      const maxScrollTop = Math.max(0, container.scrollHeight - viewportHeight);
      const ratio =
        maxScrollTop <= 0 ? 0 : Math.max(0, Math.min(1, scrollTop / maxScrollTop));
      const virtualTotal = Math.max(1, context.getPageCount());
      return virtualTotal <= 1 ? 1 : 1 + ratio * (virtualTotal - 1);
    }
    let lo = 0;
    let hi = total - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (tops[mid] <= scrollTop) {
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    const pageIndex = Math.max(0, Math.min(total - 1, hi));
    const top = tops[pageIndex] || 0;
    const height = heights[pageIndex] || 1;
    const rawOffset = height <= 0 ? 0 : (scrollTop - top) / height;
    const offset = Math.max(0, Math.min(0.999999, rawOffset));
    return pageIndex + 1 + offset;
  };

  const convertChapterPreciseToVirtualPrecise = (
    chapterPrecise: number
  ): number => {
    if (!context.getUseChapterMode()) return chapterPrecise;
    const chapterIndex = Math.floor(chapterPrecise) - 1;
    const chapterOffset = clampChapterOffset(
      chapterPrecise - Math.floor(chapterPrecise)
    );
    const virtualTotal = Math.max(1, context.getPageCount());
    if (virtualTotal <= 1) return 1;

    // 查找该章节在虚拟页面中的范围
    if (context.getChapterIndexByPage) {
      let chapterFirstPage = -1;
      let chapterLastPage = -1;
      for (let i = 0; i < virtualTotal; i++) {
        if (context.getChapterIndexByPage(i) === chapterIndex) {
          if (chapterFirstPage === -1) chapterFirstPage = i;
          chapterLastPage = i;
        }
      }
      // 如果找到了该章节的页面范围，精确映射
      if (chapterFirstPage !== -1) {
        const chapterPageCount = chapterLastPage - chapterFirstPage + 1;
        const ratio = chapterOffset / 0.9999;
        const pageWithinChapter = ratio * chapterPageCount;
        return chapterFirstPage + 1 + pageWithinChapter;
      }
    }

    // 回退：只有单章时使用简单映射
    const ratio = chapterOffset / 0.9999;
    return 1 + ratio * (virtualTotal - 1);
  };

  const convertVirtualPreciseToChapterPrecise = (
    virtualPrecise: number
  ): number => {
    if (!context.getUseChapterMode()) return virtualPrecise;

    const pageIndex = Math.max(0, Math.floor(virtualPrecise) - 1);
    const chapterIndex = context.getChapterIndexByPage?.(pageIndex) ?? context.getCurrentChapterIndex();
    const pageOffset = virtualPrecise - Math.floor(virtualPrecise);

    // 计算该章节在虚拟页面中的范围，得到章节内部进度
    const totalVirtualPages = context.getPageCount();
    let chapterFirstPage = 0;
    let chapterLastPage = totalVirtualPages - 1;
    if (context.getChapterIndexByPage) {
      // 向前搜索该章节的第一个页面
      for (let i = pageIndex; i >= 0; i--) {
        if (context.getChapterIndexByPage(i) !== chapterIndex) break;
        chapterFirstPage = i;
      }
      // 向后搜索该章节的最后一个页面
      for (let i = pageIndex; i < totalVirtualPages; i++) {
        if (context.getChapterIndexByPage(i) !== chapterIndex) break;
        chapterLastPage = i;
      }
    }

    const chapterPageCount = chapterLastPage - chapterFirstPage + 1;
    const pageWithinChapter = pageIndex - chapterFirstPage + pageOffset;
    const chapterOffset = chapterPageCount > 0
      ? clampChapterOffset((pageWithinChapter / chapterPageCount) * 0.9999)
      : 0;

    // 触底修正：最后一章且滚到底部时，强制进度到达上限
    const chapterCount = context.getChapterCount();
    if (chapterIndex === chapterCount - 1) {
      const container = context.getContainer();
      if (container) {
        const atBottom =
          container.scrollTop + container.clientHeight >=
          container.scrollHeight - 50;
        if (atBottom) {
          return chapterCount + 0.9999;
        }
      }
    }

    return chapterIndex + 1 + chapterOffset;
  };

  const scrollToVirtualPage = (page: number, viewportHeight: number): void => {
    const container = context.getContainer();
    if (!container || !context.isVerticalMode()) {
      context.goToPage(page);
      return;
    }
    if (viewportHeight <= 0) {
      container.scrollTop = 0;
      context.setCurrentPage(1);
      context.setCurrentPreciseProgress(1);
      return;
    }
    const totalPages = context.getPageCount() || 1;
    const validTotalPages = Math.max(1, totalPages);
    const clampedPage = Math.min(Math.max(1, page), validTotalPages);
    const pageIndex = Math.floor(clampedPage) - 1;
    const offsetRatio = Math.max(0, Math.min(1, clampedPage - Math.floor(clampedPage)));
    context.setCurrentPreciseProgress(clampedPage);
    if (context.getUseChapterMode()) {
      const chapterPrecise = convertVirtualPreciseToChapterPrecise(clampedPage);
      context.setBookPreciseProgress(chapterPrecise);
    }
    const tops = context.getVerticalPageTops();
    const heights = context.getVerticalPageHeights();
    if (pageIndex >= 0 && pageIndex < tops.length) {
      const top = tops[pageIndex] || 0;
      const height = heights[pageIndex] || 1;
      container.scrollTop = top + height * offsetRatio;
    } else {
      const pageWrapper = container.querySelector(
        `[data-page-index="${pageIndex}"]`
      ) as HTMLElement | null;
      if (pageWrapper) {
        const wrapperTop = pageWrapper.offsetTop;
        const wrapperHeight =
          pageWrapper.scrollHeight || pageWrapper.offsetHeight || 1;
        container.scrollTop = wrapperTop + wrapperHeight * offsetRatio;
      } else {
        const maxScrollTop = Math.max(0, container.scrollHeight - viewportHeight);
        if (maxScrollTop > 0 && validTotalPages > 1) {
          const ratio = (clampedPage - 1) / (validTotalPages - 1);
          const clampedRatio = Math.max(0, Math.min(1, ratio));
          container.scrollTop = clampedRatio * maxScrollTop;
        }
      }
    }
    context.setCurrentPage(Math.floor(clampedPage));
  };

  const jumpToPreciseProgress = async (progress: number): Promise<void> => {
    if (!context.getUseChapterMode()) {
      const container = context.getContainer();
      if (context.isVerticalMode() && container) {
        const viewportHeight = container.clientHeight;
        updatePreciseProgress(progress);
        scrollToVirtualPage(progress, viewportHeight);
        return;
      }
      await context.goToPage(progress);
      return;
    }
    const chapterCount = Math.max(1, context.getChapterCount());
    let chapterInt = Math.floor(progress);
    if (!isFinite(chapterInt) || chapterInt < 1) chapterInt = 1;
    if (chapterInt > chapterCount) chapterInt = chapterCount;
    const targetChapterIndex = chapterInt - 1;
    if (targetChapterIndex !== context.getCurrentChapterIndex()) {
      await context.goToChapter(targetChapterIndex);
    }
    updatePreciseProgress(progress);
    const container = context.getContainer();
    if (context.isVerticalMode() && container) {
      const viewportHeight = container.clientHeight;
      const virtualPrecise = convertChapterPreciseToVirtualPrecise(progress);
      scrollToVirtualPage(virtualPrecise, viewportHeight);
    }
  };

  const calculateVirtualPages = (viewportHeight: number): number => {
    const scrollHeight = context.getScrollHeight();
    if (scrollHeight <= 0 || viewportHeight <= 0) {
      return 1;
    }
    return Math.max(1, Math.ceil(scrollHeight / viewportHeight));
  };

  const getCurrentVirtualPage = (
    scrollTop: number,
    viewportHeight: number
  ): number => {
    if (viewportHeight <= 0) {
      return 1;
    }
    const page = Math.floor(scrollTop / viewportHeight) + 1;
    return Math.max(1, page);
  };

  return {
    getPreciseProgress,
    updatePreciseProgress,
    refreshVerticalPageMap,
    getVirtualPreciseByScrollTop,
    convertChapterPreciseToVirtualPrecise,
    convertVirtualPreciseToChapterPrecise,
    jumpToPreciseProgress,
    calculateVirtualPages,
    getCurrentVirtualPage,
    scrollToVirtualPage,
  };
}


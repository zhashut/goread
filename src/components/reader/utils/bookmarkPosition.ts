import { IBookRenderer } from "../../../services/formats";
import { IBookmark } from "../../../types";

/**
 * 书签位置采集结果
 * preciseProgress 为浮点页码（章内偏移），PDF 等不支持精确进度的格式为 null
 */
export interface BookmarkPosition {
  pageNumber: number;
  preciseProgress: number | null;
}

/**
 * 采集当前阅读位置的精确进度
 * 仅负责从渲染器读取位置信息，不涉及标题、存储等逻辑
 */
export const captureBookmarkPosition = (
  renderer: IBookRenderer | null,
  currentPage: number
): BookmarkPosition => {
  const pageNumber = Math.max(1, Math.floor(currentPage));

  let preciseProgress: number | null = null;
  if (renderer && typeof renderer.getPreciseProgress === "function") {
    try {
      const value = renderer.getPreciseProgress();
      if (typeof value === "number" && isFinite(value) && value > 0) {
        preciseProgress = value;
      }
    } catch {
      preciseProgress = null;
    }
  }

  return { pageNumber, preciseProgress };
};

/**
 * 计算书签的跳转目标页码
 * 优先使用精确进度，缺失时（旧书签/PDF）回退到整数页码
 */
export const getBookmarkTargetPage = (bookmark: IBookmark): number => {
  const precise = bookmark.precise_progress;
  if (typeof precise === "number" && isFinite(precise) && precise > 0) {
    return precise;
  }
  return bookmark.page_number;
};

/**
 * 书签排序比较器：先按页码，同页再按精确进度
 */
export const compareBookmarkPosition = (a: IBookmark, b: IBookmark): number => {
  if (a.page_number !== b.page_number) {
    return a.page_number - b.page_number;
  }
  const pa = a.precise_progress;
  const pb = b.precise_progress;
  if (typeof pa === "number" && typeof pb === "number") {
    return pa - pb;
  }
  return 0;
};

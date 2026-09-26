/**
 * 位图页面占位尺寸工具
 *
 * 目的：让占位 canvas 与真实页面保持相同的宽高比。
 * 页面渲染完成时 canvas 的宽高属性会变为位图尺寸，若与占位宽高比差异较大，
 * 会引发内容高度突变，表现为滚动/缩放时画面跳动、闪屏。
 */

/** 占位画布基准宽度（仅用于确定宽高比，实际显示宽度由 CSS 宽度决定） */
export const PLACEHOLDER_BASE_WIDTH = 800;

/** 无页面尺寸信息时的兜底宽高比（A4，高/宽） */
const FALLBACK_ASPECT_RATIO = 1.4142;

export interface PageSizeLike {
  width: number;
  height: number;
  /** 页面旋转角度，90/270 度时宽高互换 */
  rotation?: number;
}

/** 解析页面显示宽高比（高 / 宽），考虑旋转导致的宽高互换 */
const resolveAspectRatio = (size?: PageSizeLike | null): number => {
  if (!size || !(size.width > 0) || !(size.height > 0)) return FALLBACK_ASPECT_RATIO;
  const swapped = Math.abs((size.rotation ?? 0) % 180) === 90;
  const width = swapped ? size.height : size.width;
  const height = swapped ? size.width : size.height;
  return height / width;
};

/** 计算占位画布的初始像素尺寸（宽高比与真实页面一致） */
export const getPlaceholderCanvasSize = (size?: PageSizeLike | null) => {
  const aspectRatio = resolveAspectRatio(size);
  return {
    width: PLACEHOLDER_BASE_WIDTH,
    height: Math.max(1, Math.round(PLACEHOLDER_BASE_WIDTH * aspectRatio)),
  };
};

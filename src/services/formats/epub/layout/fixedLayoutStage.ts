/**
 * EPUB 固定版式缩放舞台
 *
 * 固定版式页面的尺寸与排版由书籍按逻辑像素写死，不能参与流式布局。
 * 这里把页面放进一个绝对尺寸舞台，再整体 `transform: scale()` 缩放到阅读器视口，
 * 外层视口容器仍参与正常文档流，供章节高度同步、滚动定位等既有逻辑复用。
 * 当书籍内容高于声明视口时，按实测内容高度展开页面，避免页底内容被裁切。
 */

import type { FixedLayoutViewport } from './viewportSpec';
import { readBooleanFlag } from './featureFlags';

/** 固定版式开关的 localStorage 键：'0' 强制关闭并回退流式渲染 */
const ENABLED_FLAG_KEY = 'goread:epub-fixed-layout';

/** 最小缩放比例，避免异常尺寸导致页面不可见 */
const MIN_SCALE = 0.05;

/** 最大缩放比例：fit-page 允许放大，仅用于防御异常 viewport 声明 */
const MAX_SCALE = 4;

/** 舞台相关类名（主题样式与渲染流程共用，避免多处字面量不一致） */
export const EPUB_FIXED_VIEWPORT_CLASS = 'epub-fixed-viewport';
export const EPUB_FIXED_STAGE_CLASS = 'epub-fixed-stage';
export const EPUB_FIXED_CONTENT_CLASS = 'epub-fixed-content';

/** 是否启用固定版式适配（默认启用，显式设置 '0' 关闭） */
export function isFixedLayoutEnabled(): boolean {
  return readBooleanFlag(ENABLED_FLAG_KEY, true);
}

/** 缩放计算入参 */
export interface FixedLayoutScaleOptions {
  /** 可用宽度（阅读器内容区宽度） */
  availableWidth: number;
  /** 可用高度（阅读器内容区高度），未知时传 0 */
  availableHeight: number;
  /** 垂直对齐：纵向连续阅读顶端对齐，横向翻页整页居中 */
  verticalAlign?: 'top' | 'center';
  /** 实测内容高度：超过逻辑视口时按内容高度展开页面，避免裁切 */
  contentHeight?: number;
}

/** 缩放计算结果 */
export interface FixedLayoutMetrics {
  viewport: FixedLayoutViewport;
  availableWidth: number;
  availableHeight: number;
  scale: number;
  renderedWidth: number;
  renderedHeight: number;
}

/** 固定版式舞台句柄 */
export interface FixedLayoutStageHandle {
  /** 参与文档流的视口容器 */
  host: HTMLElement;
  /** 按书籍逻辑尺寸固定、被整体缩放的舞台 */
  stage: HTMLElement;
  /** 内容容器，用于测量实际内容高度 */
  content: HTMLElement;
  /**
   * 测量页面应有的逻辑高度：先回到声明高度再测量，
   * 避免上一次展开后的高度影响本次结果（窗口变宽后页面可以缩回）。
   */
  measurePageHeight: () => number;
  /** 按当前可用空间重新计算缩放 */
  apply: (options: FixedLayoutScaleOptions) => FixedLayoutMetrics;
  /** 释放舞台节点与类名 */
  destroy: () => void;
}

/**
 * 创建固定版式舞台，并把内容容器移入舞台。
 * 内容容器的类名与内容本身保持不变，链接处理、TTS、划词等逻辑无需感知舞台。
 */
export function createFixedLayoutStage(
  content: HTMLElement,
  viewport: FixedLayoutViewport,
): FixedLayoutStageHandle {
  const host = document.createElement('div');
  host.className = EPUB_FIXED_VIEWPORT_CLASS;
  host.style.position = 'relative';
  host.style.width = '100%';
  host.style.overflow = 'hidden';

  const stage = document.createElement('div');
  stage.className = EPUB_FIXED_STAGE_CLASS;
  stage.style.position = 'absolute';
  stage.style.top = '0';
  stage.style.left = '0';
  stage.style.width = `${viewport.width}px`;
  stage.style.height = `${viewport.height}px`;
  stage.style.transformOrigin = '0 0';

  content.classList.add(EPUB_FIXED_CONTENT_CLASS);
  stage.appendChild(content);
  host.appendChild(stage);

  const apply = (options: FixedLayoutScaleOptions): FixedLayoutMetrics => {
    const availableWidth = Math.max(0, options.availableWidth);
    const availableHeight = Math.max(0, options.availableHeight);

    // 逻辑高度取声明视口与实测内容的较大值：书籍内容超出声明视口时整页展开，避免裁切
    const measuredHeight = options.contentHeight;
    const pageHeight = measuredHeight !== undefined
      && Number.isFinite(measuredHeight)
      && measuredHeight > viewport.height
      ? Math.ceil(measuredHeight)
      : viewport.height;
    stage.style.height = `${pageHeight}px`;

    // 可用宽度未知时按最小比例兜底，等待下一帧或 resize 时重新计算
    const widthScale = availableWidth > 0
      ? availableWidth / viewport.width
      : MIN_SCALE;
    const heightScale = availableHeight > 0
      ? availableHeight / pageHeight
      : Number.POSITIVE_INFINITY;

    // contain：整页可见，保持比例
    const rawScale = Math.min(widthScale, heightScale);
    const scale = clampScale(rawScale);

    const renderedWidth = viewport.width * scale;
    const renderedHeight = pageHeight * scale;

    // 横向翻页时整页在内容区居中；纵向连续阅读保持顶端对齐。
    // 高度取整避免亚像素裁切；水平方向居中，两侧留白保持对称。
    const verticalAlign = options.verticalAlign ?? 'top';
    if (verticalAlign === 'center' && availableHeight > 0) {
      host.style.height = `${Math.ceil(availableHeight)}px`;
      stage.style.top = `${Math.max(0, (availableHeight - renderedHeight) / 2)}px`;
    } else {
      host.style.height = `${Math.ceil(renderedHeight)}px`;
      stage.style.top = '0';
    }
    stage.style.transform = `scale(${scale})`;
    stage.style.left = `${Math.max(0, (availableWidth - renderedWidth) / 2)}px`;

    return {
      viewport,
      availableWidth,
      availableHeight,
      scale,
      renderedWidth,
      renderedHeight,
    };
  };

  const measurePageHeight = (): number => {
    // 临时回到声明高度测量，避免上次展开后的高度掩盖内容缩短；测量后恢复原高度
    const previousHeight = stage.style.height;
    stage.style.height = `${viewport.height}px`;
    const contentHeight = Math.ceil(content.scrollHeight);
    stage.style.height = previousHeight;
    return Number.isFinite(contentHeight) && contentHeight > viewport.height
      ? contentHeight
      : viewport.height;
  };

  const destroy = (): void => {
    content.classList.remove(EPUB_FIXED_CONTENT_CLASS);
    host.remove();
  };

  return { host, stage, content, measurePageHeight, apply, destroy };
}

/** 限制缩放比例到安全范围 */
function clampScale(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return MIN_SCALE;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

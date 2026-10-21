/**
 * EPUB 固定版式章节管理
 *
 * 维护已渲染固定版式章节的缩放舞台，并在阅读器视口尺寸变化时统一重算缩放、
 * 同步章节容器高度。舞台节点由调用方插入 DOM，管理器只负责尺寸与生命周期。
 */

import {
  type FixedLayoutScaleOptions,
  type FixedLayoutStageHandle,
} from './fixedLayoutStage';

/** 管理器依赖：由渲染 hook 提供 */
export interface FixedLayoutSectionManagerDeps {
  /** 缩放依据的滚动容器；容器未挂载时返回 null */
  getContainer: () => HTMLElement | null;
  /** 按章节索引取章节容器，用于同步缩放后的高度 */
  getSectionWrapper: (index: number) => HTMLElement | null;
}

/** 管理器选项 */
export interface FixedLayoutSectionManagerOptions {
  /** 每章节舞台的固定应用参数（如横向翻页整页居中） */
  applyOptions?: Pick<FixedLayoutScaleOptions, 'verticalAlign'>;
  /** 是否由管理器监听容器尺寸；外部已有 ResizeObserver 时可关闭 */
  observeContainer?: boolean;
}

/** 固定版式章节管理器 */
export interface FixedLayoutSectionManager {
  /** 登记章节舞台 */
  register: (index: number, handle: FixedLayoutStageHandle) => void;
  /** 按当前容器尺寸重算缩放并同步章节高度 */
  rescale: (index: number) => void;
  /** 释放单个章节舞台 */
  release: (index: number) => void;
  /** 释放全部舞台与监听 */
  releaseAll: () => void;
  /** 章节是否为固定版式 */
  has: (index: number) => boolean;
}

/** 章节舞台登记项 */
interface FixedLayoutSectionEntry {
  handle: FixedLayoutStageHandle;
}

/** 创建固定版式章节管理器 */
export function createFixedLayoutSectionManager(
  deps: FixedLayoutSectionManagerDeps,
  options: FixedLayoutSectionManagerOptions = {},
): FixedLayoutSectionManager {
  const sections = new Map<number, FixedLayoutSectionEntry>();
  let resizeObserver: ResizeObserver | null = null;
  let resizeRafId: number | null = null;

  const rescale = (index: number): void => {
    const entry = sections.get(index);
    if (!entry) return;

    const container = deps.getContainer();
    if (!container || container.clientWidth <= 0) return;

    const scaleOptions = {
      availableWidth: container.clientWidth,
      availableHeight: container.clientHeight,
      ...options.applyOptions,
    };

    // 内容高于声明视口时整页展开，保持原有宽度不变。
    // 展开后百分比高度的子元素可能继续变高，最多迭代三次直到高度稳定。
    let pageHeight = entry.handle.measurePageHeight();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      entry.handle.apply({ ...scaleOptions, contentHeight: pageHeight });
      const nextHeight = entry.handle.measurePageHeight();
      if (nextHeight <= pageHeight + 1) break;
      pageHeight = nextHeight;
    }

    // 舞台高度由缩放结果决定，章节容器高度必须同步，否则滚动定位会错位
    const wrapper = deps.getSectionWrapper(index);
    if (!wrapper) return;
    const nextHeight = Math.ceil(entry.handle.host.getBoundingClientRect().height);
    if (nextHeight > 0 && Math.abs((parseFloat(wrapper.style.height) || 0) - nextHeight) > 1) {
      wrapper.style.height = `${nextHeight}px`;
    }
  };

  const ensureResizeObserver = (): void => {
    if (resizeObserver || options.observeContainer === false) return;
    const container = deps.getContainer();
    if (!container || typeof ResizeObserver === 'undefined') return;

    resizeObserver = new ResizeObserver(() => {
      if (resizeRafId !== null) return;
      resizeRafId = requestAnimationFrame(() => {
        resizeRafId = null;
        sections.forEach((_, index) => rescale(index));
      });
    });
    resizeObserver.observe(container);
  };

  /** 图片、字体加载完成后重新计算页面高度，避免初始测量偏小 */
  const watchContentGrowth = (index: number, handle: FixedLayoutStageHandle): void => {
    const scheduleRescale = (): void => rescale(index);

    handle.content.querySelectorAll('img').forEach((image) => {
      if (image.complete) return;
      image.addEventListener('load', scheduleRescale, { once: true, passive: true });
      image.addEventListener('error', scheduleRescale, { once: true, passive: true });
    });

    const fontsReady = typeof document !== 'undefined' ? document.fonts?.ready : undefined;
    fontsReady?.then(scheduleRescale).catch(() => { });
  };

  const release = (index: number): void => {
    const entry = sections.get(index);
    if (!entry) return;
    sections.delete(index);
    entry.handle.destroy();
  };

  const releaseAll = (): void => {
    Array.from(sections.keys()).forEach((index) => release(index));
    if (resizeObserver) {
      try {
        resizeObserver.disconnect();
      } catch { }
      resizeObserver = null;
    }
    if (resizeRafId !== null) {
      try {
        cancelAnimationFrame(resizeRafId);
      } catch { }
      resizeRafId = null;
    }
  };

  const register = (index: number, handle: FixedLayoutStageHandle): void => {
    sections.set(index, { handle });
    ensureResizeObserver();
    watchContentGrowth(index, handle);
  };

  return {
    register,
    rescale,
    release,
    releaseAll,
    has: (index: number) => sections.has(index),
  };
}

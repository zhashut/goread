/**
 * EPUB 横向渲染 Hook
 * 使用后端章节缓存实现按章节翻页阅读模式
 */

import { RenderOptions, ReaderTheme, TocItem } from '../../types';
import {
  type IEpubSectionCache,
  type IEpubResourceCache,
} from '../cache';
import { epubCacheService } from '../epubCacheService';
import { EpubThemeHook } from './useEpubTheme';
import { EpubResourceHook } from './useEpubResource';
import { getTocHrefForSection, getSpineIndexForHref } from './tocMapping';
import { extractBodyContent } from '../../../../utils/htmlUtils';
import { stabilizeScrollTop } from './scrollStabilizer';

/** 横向渲染上下文 */
export interface HorizontalRenderContext {
  bookId: string | null;
  sectionCount: number;
  totalPages: number;
  currentTheme: ReaderTheme;
  themeHook: EpubThemeHook;
  resourceHook: EpubResourceHook;
  toc?: TocItem[];
  spine?: string[];
  sectionCache?: IEpubSectionCache;
  resourceCache?: IEpubResourceCache;
  onPageChange?: (page: number) => void;
  onTocChange?: (href: string) => void;
}

/** 横向渲染状态 */
export interface HorizontalRenderState {
  currentPage: number;
  currentPreciseProgress: number;
  readingMode: 'horizontal' | 'vertical';
  container: HTMLElement | null;
}

/** 横向渲染 Hook 返回接口 */
export interface HorizontalRenderHook {
  state: HorizontalRenderState;
  renderHorizontal: (page: number, container: HTMLElement, options?: RenderOptions) => Promise<void>;
  updateThemeStyles: (options?: RenderOptions) => void;
  getInstantPreciseProgress: () => number;
  applyThemeUpdateAndRestoreAnchor: (options?: RenderOptions) => Promise<boolean>;
  goToPage: (page: number) => Promise<void>;
  goToHref: (href: string) => Promise<void>;
  nextPage: () => Promise<void>;
  prevPage: () => Promise<void>;
  scrollBy: (deltaY: number) => void;
  destroy: () => void;
}

export function useHorizontalRender(context: HorizontalRenderContext): HorizontalRenderHook {
  const state: HorizontalRenderState = {
    currentPage: 1,
    currentPreciseProgress: 1,
    readingMode: 'horizontal',
    container: null,
  };

  const MAX_RATIO = 0.999999;
  let lastRenderOptions: RenderOptions | undefined;
  let resizeObserver: ResizeObserver | null = null;
  let isSnapping = false;
  let isGestureActive = false;

  /** 内容区 padding 两侧总和，与 useEpubTheme 中 .epub-section-content { padding: 16px } 对应 */
  const CONTENT_PADDING_X = 32;

  /**
   * 设置横向布局 CSS 变量
   * 关键约束: columnWidth + columnGap = clientWidth，保证翻屏步长精确等于视口宽度
   */
  const applyHorizontalLayoutVars = (container: HTMLElement, _options?: RenderOptions): void => {
    const columnGap = CONTENT_PADDING_X;
    const pageWidth = Math.max(1, Math.floor(container.clientWidth - columnGap));
    container.style.setProperty('--epub-page-gap', `${columnGap}px`);
    container.style.setProperty('--epub-page-width', `${pageWidth}px`);
  };

  const getHorizontalDenom = (container: HTMLElement): number => {
    return container.scrollWidth - container.clientWidth;
  };

  /**
   * 补齐容器 scrollWidth 到翻屏步长的整数倍，
   * 避免最后一屏因 scrollLeft 被浏览器截断导致右侧间距缺失。
   * 通过给 .epub-section-content 设置 min-width 来强制 scrollWidth 对齐，
   * 不能用 spacer 子元素（多列布局中子元素会被分配到列内，无法水平撑宽容器）
   */
  const ensureScrollWidthAligned = (container: HTMLElement): void => {
    const shadow = container.shadowRoot;
    if (!shadow) return;

    const contentEl = shadow.querySelector('.epub-section-content') as HTMLElement | null;
    if (!contentEl) return;

    // 先清除旧的 min-width，获取内容真实的 scrollWidth
    contentEl.style.minWidth = '';

    const step = Math.max(1, getColumnStepPx(container));
    const currentScrollWidth = container.scrollWidth;
    const remainder = currentScrollWidth % step;

    // 已对齐则无需处理（浮点容差 1px）
    if (remainder < 1) return;

    // 向上取整到 step 的整数倍
    const alignedWidth = currentScrollWidth + (step - remainder);
    contentEl.style.minWidth = `${alignedWidth}px`;
  };

  const clampRatio = (ratio: number): number => {
    if (!isFinite(ratio)) return 0;
    return Math.max(0, Math.min(MAX_RATIO, ratio));
  };

  const getRatioFromProgress = (progress: number): number => {
    const intPage = Math.floor(progress);
    return clampRatio(progress - intPage);
  };

  const scrollToRatio = (container: HTMLElement, ratio: number, behavior: ScrollBehavior): void => {
    const denom = getHorizontalDenom(container);
    const left = denom > 0 ? clampRatio(ratio) * denom : 0;
    try {
      container.scrollTo({ left, top: 0, behavior });
    } catch {
      container.scrollLeft = left;
    }
  };

  /** 翻屏步长，等于容器视口宽度（由布局约束保证 columnWidth + columnGap = clientWidth） */
  const getColumnStepPx = (container: HTMLElement): number => {
    return container.clientWidth;
  };

  const snapToNearest = (container: HTMLElement): number => {
    const denom = getHorizontalDenom(container);
    if (denom <= 0) return 0;

    const step = Math.max(1, getColumnStepPx(container));
    const maxIndex = Math.max(0, Math.ceil(denom / step));
    const idx = Math.max(0, Math.min(maxIndex, Math.round(container.scrollLeft / step)));
    const targetLeft = Math.max(0, idx * step);

    if (Math.abs(targetLeft - container.scrollLeft) > 0.5) {
      isSnapping = true;
      try {
        container.scrollLeft = targetLeft;
      } finally {
        setTimeout(() => {
          isSnapping = false;
        }, 0);
      }
    }

    return targetLeft;
  };

  const scrollToIndex = (container: HTMLElement, index: number, behavior: ScrollBehavior): number => {
    const denom = getHorizontalDenom(container);
    if (denom <= 0) return 0;

    const step = Math.max(1, getColumnStepPx(container));
    const maxIndex = Math.max(0, Math.ceil(denom / step));
    const idx = Math.max(0, Math.min(maxIndex, Math.floor(index)));
    const left = Math.max(0, idx * step);
    try {
      container.scrollTo({ left, top: 0, behavior });
    } catch {
      container.scrollLeft = left;
    }
    return left;
  };

  const ensureResizeObserver = (container: HTMLElement): void => {
    if (resizeObserver) return;
    resizeObserver = new ResizeObserver(() => {
      if (!state.container) return;
      applyHorizontalLayoutVars(state.container, lastRenderOptions);
      ensureScrollWidthAligned(state.container);
      const ratio = getRatioFromProgress(state.currentPreciseProgress);
      scrollToRatio(state.container, ratio, 'auto');
      snapToNearest(state.container);
    });
    resizeObserver.observe(container);
  };

  /**
   * 监听滚动以更新精确进度
   */
  const setupScrollListener = (container: HTMLElement) => {
    let scrollTimeout: ReturnType<typeof setTimeout> | null = null;
    if ((container as any)._scrollHandler) {
      try {
        container.removeEventListener('scroll', (container as any)._scrollHandler);
      } catch { }
      delete (container as any)._scrollHandler;
    }
    const handleScroll = () => {
      if (isSnapping) return;
      if (isGestureActive) return;
      if (scrollTimeout) {
        clearTimeout(scrollTimeout);
      }
      scrollTimeout = setTimeout(() => {
        scrollTimeout = null;
        if (!container) return;
        applyHorizontalLayoutVars(container, lastRenderOptions);
        const denom = getHorizontalDenom(container);
        if (denom <= 0) return;

        const left = snapToNearest(container);
        const ratio = clampRatio(left / denom);
        const preciseProgress = state.currentPage + ratio;

        if (Math.abs(preciseProgress - state.currentPreciseProgress) > 0.001) {
          state.currentPreciseProgress = preciseProgress;
          if (context.onPageChange) {
            context.onPageChange(preciseProgress);
          }
        }
      }, 120);
    };

    container.addEventListener('scroll', handleScroll, { passive: true });

    // 保存清理函数到 container 元素上（简单 hack），或者在 destroy 中移除
    // 由于 destroy 中 container 可能为 null，我们这里暂时不显式 removeEventListener，
    // 依赖 container 被销毁时事件监听自动失效（DOM 回收）。
    // 但为了严谨，最好维护一个 cleanup。
    (container as any)._scrollHandler = handleScroll;
  };

  const setupTouchScroll = (container: HTMLElement) => {
    if ((container as any)._touchScrollCleanup) {
      try {
        (container as any)._touchScrollCleanup();
      } catch { }
      delete (container as any)._touchScrollCleanup;
    }

    const isInteractiveTarget = (el: EventTarget | null): boolean => {
      const target = el as HTMLElement | null;
      if (!target) return false;
      if (target.tagName === 'A') return true;
      if (target.tagName === 'BUTTON') return true;
      if (target.tagName === 'INPUT') return true;
      if (target.tagName === 'TEXTAREA') return true;
      if ((target as any).isContentEditable) return true;
      if (target.closest('a')) return true;
      if (target.closest('button')) return true;
      return false;
    };

    let start: { x: number; y: number; left: number; dx: number; decided: boolean; horizontal: boolean } | null = null;

    const reset = () => {
      start = null;
      isGestureActive = false;
    };

    const finalizePreciseProgress = () => {
      applyHorizontalLayoutVars(container, lastRenderOptions);
      const denom = getHorizontalDenom(container);
      if (denom <= 0) return;
      const left = snapToNearest(container);
      const ratio = clampRatio(left / denom);
      const precise = state.currentPage + ratio;
      state.currentPreciseProgress = precise;
      context.onPageChange?.(precise);
    };

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      if (isInteractiveTarget(e.target)) return;
      const t = e.touches[0];
      const x = t.clientX;
      if (x < 55 || x > window.innerWidth - 55) return;
      start = { x, y: t.clientY, left: container.scrollLeft, dx: 0, decided: false, horizontal: false };
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!start) return;
      if (e.touches.length !== 1) {
        reset();
        return;
      }
      const t = e.touches[0];
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      start.dx = dx;

      if (!start.decided) {
        if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
        start.decided = true;
        start.horizontal = Math.abs(dx) > Math.abs(dy) * 1.2;
        if (!start.horizontal) {
          reset();
          return;
        }
        isGestureActive = true;
      }

      if (!start.horizontal) return;
      try {
        e.preventDefault();
      } catch { }
    };

    const onTouchEnd = (_e: TouchEvent) => {
      if (!start) return;
      const { horizontal, dx, left } = start;
      reset();
      if (!horizontal) return;

      applyHorizontalLayoutVars(container, lastRenderOptions);
      const denom = getHorizontalDenom(container);
      if (denom <= 0) {
        finalizePreciseProgress();
        return;
      }

      const step = Math.max(1, getColumnStepPx(container));
      const baseIndex = Math.max(0, Math.round(left / step));
      const trigger = Math.max(24, Math.min(72, step * 0.18));

      const maxIndex = Math.max(0, Math.ceil(denom / step));
      const wantNext = dx <= -trigger;
      const wantPrev = dx >= trigger;

      if (wantNext && baseIndex >= maxIndex) {
        void nextPage();
        return;
      }
      if (wantPrev && baseIndex <= 0) {
        void prevPage();
        return;
      }

      let targetIndex = baseIndex;
      if (wantNext) targetIndex = baseIndex + 1;
      else if (wantPrev) targetIndex = baseIndex - 1;

      targetIndex = Math.max(0, Math.min(maxIndex, targetIndex));

      const targetLeft = scrollToIndex(container, targetIndex, 'auto');
      const ratio = clampRatio(targetLeft / denom);
      const precise = state.currentPage + ratio;
      state.currentPreciseProgress = precise;
      context.onPageChange?.(precise);
    };

    const onTouchCancel = (_e: TouchEvent) => reset();

    container.addEventListener('touchstart', onTouchStart, { passive: true });
    container.addEventListener('touchmove', onTouchMove, { passive: false });
    container.addEventListener('touchend', onTouchEnd, { passive: true });
    container.addEventListener('touchcancel', onTouchCancel, { passive: true });

    (container as any)._touchScrollCleanup = () => {
      try {
        container.removeEventListener('touchstart', onTouchStart as any);
        container.removeEventListener('touchmove', onTouchMove as any);
        container.removeEventListener('touchend', onTouchEnd as any);
        container.removeEventListener('touchcancel', onTouchCancel as any);
      } catch { }
      reset();
    };
  };

  /**
   * 将章节缓存渲染到容器
   */
  const renderSection = async (
    sectionIndex: number,
    container: HTMLElement,
    options?: RenderOptions,
    progressToEmit?: number,
  ): Promise<void> => {
    const bookId = context.bookId;
    const sectionCache = context.sectionCache;
    const resourceCache = context.resourceCache;

    if (!bookId || !sectionCache || !resourceCache) {
      return;
    }

    lastRenderOptions = options;
    applyHorizontalLayoutVars(container, options);

    let cacheEntry = sectionCache.getSection(bookId, sectionIndex);

    // 内存缓存未命中时，从后端磁盘缓存加载
    if (!cacheEntry) {
      try {
        cacheEntry = await epubCacheService.loadSectionFromDB(bookId, sectionIndex);
        if (cacheEntry) {
          sectionCache.setSection(cacheEntry);
        }
      } catch (e) {
        // 后端加载失败
      }

      if (!cacheEntry) {
        return;
      }

      // 确保资源已在内存缓存中，必要时从后端恢复
      for (const ref of cacheEntry.resourceRefs) {
        let data = resourceCache.get(bookId, ref);

        if (!data) {
          try {
            const dbEntry = await epubCacheService.loadResourceFromDB(bookId, ref);
            if (dbEntry) {
              resourceCache.set(bookId, ref, dbEntry.data, dbEntry.mimeType);
              data = dbEntry.data;
            }
          } catch (e) {
            // 资源加载失败
          }
        }
      }
    }

    // 使用资源缓存恢复 Blob URL
    let restoredHtml = cacheEntry.rawHtml;
    try {
      restoredHtml = context.resourceHook.restoreBlobUrls(
        cacheEntry.rawHtml,
        cacheEntry.resourceRefs,
        bookId,
        resourceCache,
      );
    } catch (e) {
      // 资源恢复失败
    }

    // 构建 Shadow DOM，注入主题样式和原始样式
    let shadow = container.shadowRoot;
    if (!shadow) {
      shadow = container.attachShadow({ mode: 'open' });
    } else {
      shadow.innerHTML = '';
    }

    const theme = options?.theme || context.currentTheme || 'light';
    const themeStyle = document.createElement('style');
    themeStyle.setAttribute('data-epub-theme-style', '');
    themeStyle.textContent = context.themeHook.getThemeStyles({
      ...options,
      theme,
      readingMode: 'horizontal',
    });
    shadow.appendChild(themeStyle);

    if (cacheEntry.rawStyles.length > 0) {
      // 替换样式中的资源占位符为 Blob URL
      let stylesText = cacheEntry.rawStyles.join('\n');
      for (const resRef of cacheEntry.resourceRefs) {
        const placeholder = `__EPUB_RES__:${resRef}`;
        if (!stylesText.includes(placeholder)) continue;
        const data = resourceCache.get(bookId, resRef);
        if (data) {
          const blobUrl = context.resourceHook.getOrCreateBlobUrl(resRef, data);
          stylesText = stylesText.split(placeholder).join(blobUrl);
        }
      }
      const originalStyle = document.createElement('style');
      originalStyle.textContent = stylesText;
      shadow.appendChild(originalStyle);
    }

    const content = document.createElement('div');
    content.className = 'epub-section-content';
    content.innerHTML = extractBodyContent(restoredHtml);
    shadow.appendChild(content);

    // 渲染完成后补齐 scrollWidth 对齐到翻屏步长整数倍
    requestAnimationFrame(() => {
      ensureScrollWidthAligned(container);
    });

    // 更新当前页码和进度
    const page = sectionIndex + 1;
    state.currentPage = page;
    const emitted = typeof progressToEmit === 'number' && isFinite(progressToEmit) && progressToEmit > 0
      ? progressToEmit
      : page;
    state.currentPreciseProgress = emitted;

    if (context.onPageChange) {
      context.onPageChange(emitted);
    }

    const tocHref = getTocHrefForSection(sectionIndex, context.toc, context.spine);
    if (tocHref && context.onTocChange) {
      context.onTocChange(tocHref);
    }
  };

  /**
   * 渲染横向模式
   */
  const renderHorizontal = async (
    page: number,
    container: HTMLElement,
    options?: RenderOptions,
  ): Promise<void> => {

    const theme = options?.theme || context.currentTheme || 'light';
    state.readingMode = 'horizontal';
    state.container = container;

    lastRenderOptions = options;
    applyHorizontalLayoutVars(container, options);

    // 启用滚动监听
    setupScrollListener(container);
    ensureResizeObserver(container);
    setupTouchScroll(container);

    container.innerHTML = '';
    container.scrollLeft = 0;
    container.style.cssText = `
        width: 100%;
        height: 100%;
        overflow-x: auto;
        overflow-y: hidden;
        overscroll-behavior: contain;
      `;

    const initialProgress = options?.initialVirtualPage;
    const targetPage = initialProgress && initialProgress > 0
      ? Math.floor(initialProgress)
      : page;
    const clampedPage = Math.min(
      Math.max(1, targetPage),
      context.sectionCount > 0 ? context.sectionCount : context.totalPages || 1,
    );

    await renderSection(clampedPage - 1, container, {
      ...options,
      theme,
    }, typeof initialProgress === 'number' && isFinite(initialProgress) && initialProgress > 0 ? initialProgress : undefined);

    // 如果有初始精确进度，恢复滚动位置
    if (initialProgress && initialProgress > 0) {
      const ratio = getRatioFromProgress(initialProgress);
      if (ratio > 0) {
        requestAnimationFrame(() => {
          if (!container) return;
          scrollToRatio(container, ratio, 'auto');
          const left = snapToNearest(container);
          const denom = getHorizontalDenom(container);
          const snappedRatio = denom > 0 ? clampRatio(left / denom) : 0;
          const precise = state.currentPage + snappedRatio;
          state.currentPreciseProgress = precise;
          context.onPageChange?.(precise);
        });
      }
    }
  };

  const updateThemeStyles = (options?: RenderOptions): void => {
    const container = state.container;
    if (!container) return;
    const shadow = container.shadowRoot;
    if (!shadow) return;
    const theme = options?.theme || context.currentTheme || 'light';
    const next = context.themeHook.getThemeStyles({ ...options, theme, readingMode: 'horizontal' });
    const styleEl =
      shadow.querySelector('style[data-epub-theme-style]') || shadow.querySelector('style');
    if (!styleEl) return;
    styleEl.textContent = next;
  };

  const getInstantPreciseProgress = (): number => {
    const container = state.container;
    const page = state.currentPage || 1;
    if (!container) return page;
    const denom = getHorizontalDenom(container);
    if (denom <= 0) return page;
    const ratio = clampRatio(container.scrollLeft / denom);
    return page + ratio;
  };

  const applyThemeUpdateAndRestoreAnchor = async (options?: RenderOptions): Promise<boolean> => {
    const container = state.container;
    if (!container) return false;
    const shadow = container.shadowRoot;
    if (!shadow) return false;

    const initialProgress = options?.initialVirtualPage;
    const targetPage =
      typeof initialProgress === 'number' && isFinite(initialProgress) && initialProgress > 0
        ? Math.floor(initialProgress)
        : state.currentPage;
    if (targetPage !== state.currentPage) return false;

    const hasThemeChange =
      options?.theme !== undefined ||
      options?.fontSize !== undefined ||
      options?.lineHeight !== undefined ||
      options?.fontFamily !== undefined;
    if (!hasThemeChange) return false;

    lastRenderOptions = options;
    applyHorizontalLayoutVars(container, options);

    const denom = getHorizontalDenom(container);
    const ratio = denom > 0 ? container.scrollLeft / denom : 0;
    const clampedRatio = clampRatio(ratio);

    const theme = options?.theme || context.currentTheme || 'light';
    updateThemeStyles({ ...options, theme });

    const contentEl =
      shadow.querySelector('.epub-section-content') ||
      shadow.querySelector('body') ||
      shadow.firstElementChild ||
      null;

    await stabilizeScrollTop({
      container,
      getTargetScrollTop: () => {
        const d = getHorizontalDenom(container);
        if (d <= 0) return 0;
        return clampedRatio * d;
      },
      observeElements: contentEl ? [contentEl] : [container],
      imageRoot: shadow,
      axis: 'x',
    });

    applyHorizontalLayoutVars(container, lastRenderOptions);
    ensureScrollWidthAligned(container);
    const left = snapToNearest(container);
    const d = getHorizontalDenom(container);
    const ratioAfter = d > 0 ? clampRatio(left / d) : 0;
    state.currentPreciseProgress = state.currentPage + ratioAfter;
    return true;
  };

  const goToPage = async (page: number): Promise<void> => {
    if (!state.container) return;
    const intPage = Math.floor(page);
    const ratio = clampRatio(page - intPage);

    if (intPage < 1 || intPage > (context.sectionCount || context.totalPages || 1)) {
      return;
    }

    if (intPage !== state.currentPage || !state.container.shadowRoot) {
      await renderSection(intPage - 1, state.container, {
        ...lastRenderOptions,
        theme: context.currentTheme,
      }, intPage + ratio);
    }

    requestAnimationFrame(() => {
      if (!state.container) return;
      applyHorizontalLayoutVars(state.container, lastRenderOptions);
      scrollToRatio(state.container, ratio, 'auto');
      const left = snapToNearest(state.container);
      const d = getHorizontalDenom(state.container);
      const snappedRatio = d > 0 ? clampRatio(left / d) : 0;
      const precise = intPage + snappedRatio;
      state.currentPreciseProgress = precise;
      context.onPageChange?.(precise);
    });
  };

  const goToHref = async (href: string): Promise<void> => {
    const sectionCount = context.sectionCount || 0;
    if (sectionCount <= 0) return;

    const sectionIndex = getSpineIndexForHref(href, context.spine);
    if (sectionIndex >= 0 && sectionIndex < sectionCount) {
      await goToPage(sectionIndex + 1);
    }
  };

  const nextPage = async (): Promise<void> => {
    const container = state.container;
    if (!container) return;

    const denom = getHorizontalDenom(container);
    if (denom > 0) {
      applyHorizontalLayoutVars(container, lastRenderOptions);
      const step = Math.max(1, getColumnStepPx(container));
      const maxIndex = Math.max(0, Math.ceil(denom / step));
      const currentIndex = Math.max(0, Math.min(maxIndex, Math.round(container.scrollLeft / step)));
      if (currentIndex < maxIndex) {
        const left = scrollToIndex(container, currentIndex + 1, 'auto');
        const ratio = clampRatio(left / denom);
        const precise = state.currentPage + ratio;
        state.currentPreciseProgress = precise;
        context.onPageChange?.(precise);
        return;
      }
    }

    const next = state.currentPage + 1;
    if (next > (context.sectionCount || context.totalPages || 1)) return;
    await goToPage(next);
  };

  const prevPage = async (): Promise<void> => {
    const container = state.container;
    if (!container) return;

    const denom = getHorizontalDenom(container);
    if (denom > 0) {
      applyHorizontalLayoutVars(container, lastRenderOptions);
      const step = Math.max(1, getColumnStepPx(container));
      const maxIndex = Math.max(0, Math.ceil(denom / step));
      const currentIndex = Math.max(0, Math.min(maxIndex, Math.round(container.scrollLeft / step)));
      if (currentIndex > 0) {
        const left = scrollToIndex(container, currentIndex - 1, 'auto');
        const ratio = clampRatio(left / denom);
        const precise = state.currentPage + ratio;
        state.currentPreciseProgress = precise;
        context.onPageChange?.(precise);
        return;
      }
    }

    const prev = state.currentPage - 1;
    if (prev < 1) return;
    await renderSection(prev - 1, container, {
      ...lastRenderOptions,
      theme: context.currentTheme,
    });
    requestAnimationFrame(() => {
      if (!state.container) return;
      applyHorizontalLayoutVars(state.container, lastRenderOptions);
      const d = getHorizontalDenom(state.container);
      let left = 0;
      if (d > 0) {
        const step = Math.max(1, getColumnStepPx(state.container));
        const maxIndex = Math.max(0, Math.ceil(d / step));
        left = scrollToIndex(state.container, maxIndex, 'auto');
      } else {
        state.container.scrollLeft = 0;
      }
      const ratio = d > 0 ? clampRatio(left / d) : 0;
      const precise = prev + ratio;
      state.currentPreciseProgress = precise;
      context.onPageChange?.(precise);
    });
  };

  const scrollBy = (deltaY: number): void => {
    if (!state.container) return;
    try {
      state.container.scrollBy({ top: deltaY, behavior: 'smooth' });
    } catch { }
  };

  const destroy = (): void => {
    if (resizeObserver) {
      try {
        resizeObserver.disconnect();
      } catch { }
      resizeObserver = null;
    }
    if (state.container) {
      try {
        // 尝试移除 scroll handler
        if ((state.container as any)._scrollHandler) {
          state.container.removeEventListener('scroll', (state.container as any)._scrollHandler);
          delete (state.container as any)._scrollHandler;
        }
        if ((state.container as any)._touchScrollCleanup) {
          try {
            (state.container as any)._touchScrollCleanup();
          } catch { }
          delete (state.container as any)._touchScrollCleanup;
        }
        state.container.innerHTML = '';
        state.container.removeAttribute('style'); // 清除样式
      } catch { }
    }
    state.container = null;
  };

  return {
    state,
    renderHorizontal,
    updateThemeStyles,
    getInstantPreciseProgress,
    applyThemeUpdateAndRestoreAnchor,
    goToPage,
    goToHref,
    nextPage,
    prevPage,
    scrollBy,
    destroy,
  };
}

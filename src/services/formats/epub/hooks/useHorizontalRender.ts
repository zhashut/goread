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

  /**
   * 监听滚动以更新精确进度
   */
  const setupScrollListener = (container: HTMLElement) => {
    let scrollTimeout: ReturnType<typeof setTimeout> | null = null;
    const handleScroll = () => {
      if (scrollTimeout) return;
      scrollTimeout = setTimeout(() => {
        scrollTimeout = null;
        if (!container) return;
        const scrollTop = container.scrollTop;
        const scrollHeight = container.scrollHeight;
        const clientHeight = container.clientHeight;

        if (scrollHeight > clientHeight) {
          const ratio = scrollTop / (scrollHeight - clientHeight);
          // 确保 ratio 在 0-1 之间
          const clampedRatio = Math.max(0, Math.min(1, ratio));
          // 使用当前整数页码 + 滚动比例
          const preciseProgress = state.currentPage + clampedRatio;

          if (Math.abs(preciseProgress - state.currentPreciseProgress) > 0.001) {
            state.currentPreciseProgress = preciseProgress;
            if (context.onPageChange) {
              context.onPageChange(preciseProgress);
            }
          }
        }
      }, 200); // 节流
    };

    container.addEventListener('scroll', handleScroll, { passive: true });

    // 保存清理函数到 container 元素上（简单 hack），或者在 destroy 中移除
    // 由于 destroy 中 container 可能为 null，我们这里暂时不显式 removeEventListener，
    // 依赖 container 被销毁时事件监听自动失效（DOM 回收）。
    // 但为了严谨，最好维护一个 cleanup。
    (container as any)._scrollHandler = handleScroll;
  };

  /**
   * 将章节缓存渲染到容器
   */
  const renderSection = async (
    sectionIndex: number,
    container: HTMLElement,
    options?: RenderOptions,
  ): Promise<void> => {
    const bookId = context.bookId;
    const sectionCache = context.sectionCache;
    const resourceCache = context.resourceCache;

    if (!bookId || !sectionCache || !resourceCache) {
      return;
    }

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
    themeStyle.textContent = context.themeHook.getThemeStyles({
      ...options,
      theme,
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

    // 更新当前页码和进度
    const page = sectionIndex + 1;
    state.currentPage = page;
    state.currentPreciseProgress = page;

    if (context.onPageChange) {
      context.onPageChange(page);
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

    // 启用滚动监听
    setupScrollListener(container);

    container.innerHTML = '';
    container.scrollTop = 0; // 重置滚动位置
    container.style.cssText = `
        width: 100%;
        height: 100%;
        overflow-y: auto;
        overflow-x: hidden;
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
    });

    // 如果有初始精确进度，恢复滚动位置
    if (initialProgress && initialProgress > 0) {
      const progress = initialProgress - Math.floor(initialProgress);
      if (progress > 0) {
        requestAnimationFrame(() => {
          if (!container) return;
          const scrollHeight = container.scrollHeight;
          const clientHeight = container.clientHeight;
          if (scrollHeight > clientHeight) {
            // 使用与 setupScrollListener 一致的公式：
            // progress = scrollTop / (scrollHeight - clientHeight)
            // => scrollTop = progress * (scrollHeight - clientHeight)
            container.scrollTop = progress * (scrollHeight - clientHeight);

            // 更新当前精确进度状态，避免 setupScrollListener 再次触发不必要的更新
            state.currentPreciseProgress = initialProgress;
          }
        });
      }
    }
  };

  const goToPage = async (page: number): Promise<void> => {
    if (!state.container) return;
    const intPage = Math.floor(page);
    const progress = page - intPage;

    if (intPage < 1 || intPage > (context.sectionCount || context.totalPages || 1)) {
      return;
    }

    await renderSection(intPage - 1, state.container, {
      theme: context.currentTheme,
    });

    // 如果有精确进度，或者只是简单的翻页（进度为0），都需要处理滚动位置
    // renderSection 会重建 Shadow DOM，通常会导致滚动重置，但为了保险起见显式处理
    if (state.container) {
      if (progress > 0) {
        // 恢复精确进度（百分比）
        // 需要等待 DOM 渲染完成，scrollHeight 准确
        requestAnimationFrame(() => {
          if (!state.container) return;
          const scrollHeight = state.container.scrollHeight;
          const clientHeight = state.container.clientHeight;
          // 只有当可滚动时才应用进度
          if (scrollHeight > clientHeight) {
            // 修正公式：与 setupScrollListener 保持一致
            // progress = scrollTop / (scrollHeight - clientHeight)
            state.container.scrollTop = progress * (scrollHeight - clientHeight);
            state.currentPreciseProgress = page;
          }
        });
      } else {
        // 整数页码，确保滚动到顶部
        state.container.scrollTop = 0;
        state.currentPreciseProgress = intPage;
      }
    }
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
    const next = state.currentPage + 1;
    if (next > (context.sectionCount || context.totalPages || 1)) return;
    await goToPage(next);
  };

  const prevPage = async (): Promise<void> => {
    const prev = state.currentPage - 1;
    if (prev < 1) return;
    await goToPage(prev);
  };

  const scrollBy = (deltaY: number): void => {
    if (!state.container) return;
    try {
      state.container.scrollBy({ top: deltaY, behavior: 'smooth' });
    } catch { }
  };

  const destroy = (): void => {
    if (state.container) {
      try {
        // 尝试移除 scroll handler
        if ((state.container as any)._scrollHandler) {
          state.container.removeEventListener('scroll', (state.container as any)._scrollHandler);
          delete (state.container as any)._scrollHandler;
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
    goToPage,
    goToHref,
    nextPage,
    prevPage,
    scrollBy,
    destroy,
  };
}

/**
 * EPUB 纵向连续渲染 Hook
 * 实现纵向连续阅读模式的完整逻辑
 */

import { RenderOptions, ReaderTheme, TocItem } from '../../types';
import { log, logError } from '../../../index';
import { EpubResourceHook } from './useEpubResource';
import { EpubThemeHook } from './useEpubTheme';
import { EpubNavigationHook } from './useEpubNavigation';
import {
  type IEpubSectionCache,
  type IEpubResourceCache,
  getMimeType,
} from '../cache';
import { epubCacheService } from '../epubCacheService';
import { createDividerEl, toggleDividerVisibility, updateDividerStyle } from '../../../../components/reader/PageDivider';
import { getTocHrefForSection } from './tocMapping';
import { extractBodyContent } from '../../../../utils/htmlUtils';

/** 纵向渲染上下文 */
export interface VerticalRenderContext {
  sectionCount: number;
  currentTheme: ReaderTheme;
  currentPageGap: number;
  toc?: TocItem[];
  spine?: string[];
  onPageChange?: (page: number) => void;
  onTocChange?: (href: string) => void;
  onScrollActivity?: () => void;
  /** 首屏渲染完成回调（用于提前隐藏 loading） */
  onFirstScreenReady?: () => void;
  /** 资源 hook */
  resourceHook: EpubResourceHook;
  /** 主题 hook */
  themeHook: EpubThemeHook;
  /** 书籍唯一标识（用于缓存） */
  bookId?: string;
  /** 章节缓存管理器 */
  sectionCache?: IEpubSectionCache;
  /** 资源缓存管理器 */
  resourceCache?: IEpubResourceCache;
}

/** 纵向渲染状态 */
export interface VerticalRenderState {
  verticalContinuousMode: boolean;
  sectionContainers: Map<number, HTMLElement>;
  renderedSections: Set<number>;
  /** 正在渲染中的章节索引，用于防止并发渲染 */
  renderingInProgress: Set<number>;
  scrollContainer: HTMLElement | null;
  dividerElements: HTMLElement[];
  isNavigating: boolean;
  currentPage: number;
  currentPreciseProgress: number;
  scrollRafId: number | null;
}

/** 纵向渲染 Hook 返回接口 */
export interface VerticalRenderHook {
  state: VerticalRenderState;
  /** 纵向连续渲染入口 */
  renderVerticalContinuous: (container: HTMLElement, options?: RenderOptions) => Promise<void>;
  /** 设置章节可见性观察器 */
  setupSectionObserver: (container: HTMLElement, options?: RenderOptions) => void;
  /** 渲染单个章节 */
  renderSection: (index: number, options?: RenderOptions) => Promise<void>;
  /** 计算当前章节内的滚动偏移比例 */
  calculateScrollOffset: () => number;
  /** 更新滚动进度和目录高亮 */
  updateScrollProgress: () => void;
  /** 确保指定章节及邻近章节已渲染 */
  ensureSectionsRendered: (sectionIndex: number) => void;
  /** 跳转到指定页面 */
  goToPage: (page: number) => Promise<void>;
  /** 更新章节间距 */
  updatePageGap: (pageGap: number) => void;
  /** 更新分隔线可见性 */
  updateDividerVisibility: (hidden: boolean) => void;
  /** 清理资源 */
  cleanup: () => void;
  /** 设置导航 hook（在初始化后设置，解决循环依赖） */
  setNavigationHook: (hook: EpubNavigationHook) => void;
  /** 离屏预渲染指定章节到缓存（用于导入阶段预热） */
  preloadSectionsOffscreen: (indices: number[]) => Promise<void>;
}

/**
 * EPUB 纵向连续渲染 Hook
 * 提供纵向连续阅读模式的完整实现
 */
export function useVerticalRender(context: VerticalRenderContext): VerticalRenderHook {
  const { sectionCount, resourceHook, themeHook } = context;

  // 内部状态
  const state: VerticalRenderState = {
    verticalContinuousMode: false,
    sectionContainers: new Map(),
    renderedSections: new Set(),
    renderingInProgress: new Set(),
    scrollContainer: null,
    dividerElements: [],
    isNavigating: false,
    currentPage: 1,
    currentPreciseProgress: 1,
    scrollRafId: null,
  };

  // 观察器引用
  let sectionObserver: IntersectionObserver | null = null;
  let navigationHook: EpubNavigationHook | null = null;

  /**
   * 设置导航 hook
   */
  const setNavigationHook = (hook: EpubNavigationHook): void => {
    navigationHook = hook;
  };

  /**
   * 计算当前章节内的滚动偏移比例
   * @returns 0.0~1.0 的比例值，表示在当前章节中的相对位置
   */
  const calculateScrollOffset = (): number => {
    if (!state.scrollContainer || !state.verticalContinuousMode) return 0;

    const container = state.scrollContainer;
    const scrollTop = container.scrollTop;
    const currentIndex = state.currentPage - 1;
    const wrapper = state.sectionContainers.get(currentIndex);

    if (!wrapper) return 0;

    const wrapperRect = wrapper.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    // 计算 wrapper 相对于滚动容器的顶部位置
    const wrapperTop = wrapperRect.top - containerRect.top + scrollTop;
    // 计算滚动位置在章节内的偏移
    const offsetInSection = scrollTop - wrapperTop;
    const sectionHeight = wrapper.scrollHeight;

    if (sectionHeight <= 0) return 0;
    // 返回 0~1 之间的比例
    return Math.max(0, Math.min(1, offsetInSection / sectionHeight));
  };

  /**
   * 更新滚动进度和目录高亮
   */
  const updateScrollProgress = (): void => {
    if (!state.scrollContainer || !state.verticalContinuousMode) return;
    if (state.isNavigating) return;

    const container = state.scrollContainer;
    const scrollTop = container.scrollTop;
    const viewportHeight = container.clientHeight;
    const scrollHeight = container.scrollHeight;
    const centerY = scrollTop + viewportHeight / 2;

    let currentSectionIndex = -1;

    if (scrollHeight > viewportHeight && scrollTop + viewportHeight >= scrollHeight - 50 && sectionCount > 0) {
      currentSectionIndex = sectionCount - 1;
    } else {
      state.sectionContainers.forEach((wrapper, index) => {
        const rect = wrapper.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        const relativeTop = rect.top - containerRect.top + scrollTop;
        const relativeBottom = relativeTop + rect.height;

        if (centerY >= relativeTop && centerY < relativeBottom) {
          currentSectionIndex = index;
        }
      });
    }

    if (currentSectionIndex >= 0) {
      const newPage = currentSectionIndex + 1;

      if (newPage !== state.currentPage) {
        state.currentPage = newPage;
      }

      const offset = calculateScrollOffset();
      const preciseProgress = newPage + offset;
      state.currentPreciseProgress = preciseProgress;

      if (context.onPageChange) {
        context.onPageChange(preciseProgress);
      }

      if (context.onTocChange) {
        const tocHref = getTocHrefForSection(currentSectionIndex, context.toc, context.spine);
        if (tocHref) {
          context.onTocChange(tocHref);
        }
      }
    }
  };

  /**
   * 设置滚动监听器，用于更新目录高亮和进度
   */
  const setupScrollListener = (container: HTMLElement): void => {
    const handleScroll = () => {
      if (state.scrollRafId !== null) return;

      state.scrollRafId = requestAnimationFrame(() => {
        state.scrollRafId = null;
        updateScrollProgress();

        // 通知滚动活跃
        if (context.onScrollActivity) {
          context.onScrollActivity();
        }
      });
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    (container as any)._verticalScrollHandler = handleScroll;
  };

  /**
   * 按需插入分隔线
   * 仅在章节渲染成功后调用，确保分隔线在内容之后出现
   */
  const ensureDividerForSection = (index: number, options?: RenderOptions): void => {
    // 第一个章节前面不需要分隔线
    if (index <= 0) return;

    const wrapper = state.sectionContainers.get(index);
    if (!wrapper || !wrapper.parentElement) return;

    // 检查前面是否已有分隔线
    const prevSibling = wrapper.previousElementSibling as HTMLElement | null;
    if (prevSibling && prevSibling.classList.contains('epub-section-divider')) {
      return;
    }

    // 计算分隔线样式参数
    const theme = options?.theme || context.currentTheme || 'light';
    const pageGap = options?.pageGap ?? context.currentPageGap;
    const bandHeight = pageGap * 2 + 1;
    const isDark = theme === 'dark';
    const dividerColor = isDark ? '#ffffff' : '#000000';

    // 创建分隔线
    const divider = createDividerEl({
      height: bandHeight,
      color: dividerColor,
      hidden: options?.hideDivider ?? false
    });
    divider.classList.add('epub-section-divider');

    // 插入到章节容器之前
    wrapper.parentElement.insertBefore(divider, wrapper);
    state.dividerElements.push(divider);
  };

  /**
   * 渲染单个章节
   * 使用 renderingInProgress 防止并发渲染同一章节
   */
  const renderSection = async (index: number, options?: RenderOptions): Promise<void> => {
    // 幂等性检查：已渲染的章节跳过
    if (state.renderedSections.has(index)) {
      return;
    }

    // 并发控制：正在渲染中的章节跳过
    if (state.renderingInProgress.has(index)) {
      return;
    }

    const wrapper = state.sectionContainers.get(index);
    if (!wrapper) {
      return;
    }

    // 标记渲染开始
    state.renderingInProgress.add(index);

    const { bookId, sectionCache, resourceCache } = context;

    // 尝试从缓存读取（一级内存缓存 -> 二级后端磁盘缓存）
    if (bookId && sectionCache && resourceCache) {
      let cacheEntry = sectionCache.getSection(bookId, index);

      // 内存缓存未命中时，尝试从后端磁盘缓存加载
      if (!cacheEntry) {
        try {
          cacheEntry = await epubCacheService.loadSectionFromDB(bookId, index);
          if (cacheEntry) {
            // 加载到内存缓存
            sectionCache.setSection(cacheEntry);
          }
        } catch {
          // 后端加载失败，继续常规渲染
        }
      }

      if (cacheEntry) {
        try {
          // 使用 shadow DOM 隔离样式（复用已存在的 Shadow Root 或创建新的）
          let shadow = wrapper.shadowRoot;
          if (shadow) {
            // 清空已存在的 Shadow Root 内容
            shadow.innerHTML = '';
          } else {
            shadow = wrapper.attachShadow({ mode: 'open' });
          }

          // 注入主题样式
          const style = document.createElement('style');
          style.textContent = themeHook.getThemeStyles(options);
          shadow.appendChild(style);

          // 注入原文档样式（占位符稍后统一替换）
          let stylesText = cacheEntry.rawStyles.length > 0
            ? cacheEntry.rawStyles.join('\n')
            : '';

          // 从缓存恢复 HTML，替换占位符为 Blob URL（内存缓存 -> 后端磁盘缓存 -> 网络加载）
          let restoredHtml = cacheEntry.rawHtml;
          for (const ref of cacheEntry.resourceRefs) {
            let data = resourceCache.get(bookId, ref);

            // 内存缓存未命中时，尝试从后端磁盘缓存加载
            if (!data) {
              try {
                const dbEntry = await epubCacheService.loadResourceFromDB(bookId, ref);
                if (dbEntry) {
                  // 恢复到内存缓存
                  resourceCache.set(bookId, ref, dbEntry.data, dbEntry.mimeType);
                  data = dbEntry.data;
                }
              } catch {
                // IndexedDB 加载失败，继续尝试网络加载
              }
            }

            // 如果仍未命中，尝试通过 resourceHook 加载（需要 book 对象）
            if (!data && resourceHook) {
              try {
                data = await resourceHook.loadResourceData(ref);
                if (data) {
                  const mimeType = getMimeType(ref);
                  resourceCache.set(bookId, ref, data, mimeType);
                  // 异步写入 IndexedDB
                  epubCacheService.saveResourceToDB({
                    bookId,
                    resourcePath: ref,
                    data,
                    mimeType,
                    sizeBytes: data.byteLength,
                    lastAccessTime: Date.now(),
                  }).catch(() => {});
                }
              } catch {
                // 网络加载失败
              }
            }

            if (data) {
              const blobUrl = resourceHook.getOrCreateBlobUrl(ref, data);
              const placeholder = `__EPUB_RES__:${ref}`;
              restoredHtml = restoredHtml.split(placeholder).join(blobUrl);
              stylesText = stylesText.split(placeholder).join(blobUrl);
            }
          }

          // 注入经过占位符替换的原文档样式
          if (stylesText) {
            const originalStyleEl = document.createElement('style');
            originalStyleEl.textContent = stylesText;
            shadow.appendChild(originalStyleEl);
          }

          // 提取 body 内容后注入（EPUB 的 HTML 是完整 XHTML 文档，不能直接放入 div）
          const content = document.createElement('div');
          content.className = 'epub-section-content';
          content.innerHTML = extractBodyContent(restoredHtml);
          shadow.appendChild(content);

          // 处理链接点击事件
          if (navigationHook) {
            navigationHook.setupLinkHandlers(content, index);
          }

          // 按需插入分隔线（仅在章节渲染成功后创建）
          ensureDividerForSection(index, options);

          state.renderedSections.add(index);
          state.renderingInProgress.delete(index);
          wrapper.dataset.rendered = 'true';
          return;
        } catch (e) {
          logError(`[VerticalRender] 章节 ${index + 1} 渲染异常: ${e}`).catch(() => {});
          state.renderingInProgress.delete(index);
        }
      }
    }

    // 缓存未命中，纵向模式要求章节必须在后端缓存中
    state.renderingInProgress.delete(index);
    return;
  };

  /**
   * 设置章节可见性观察器，实现懒加载
   */
  const setupSectionObserver = (container: HTMLElement, options?: RenderOptions): void => {
    sectionObserver = new IntersectionObserver(
      (entries) => {
        // 导航过程中跳过渲染，避免平滑滚动时渲染所有中间章节
        if (state.isNavigating) return;

        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const wrapper = entry.target as HTMLElement;
            const index = parseInt(wrapper.dataset.sectionIndex || '-1', 10);

            if (index >= 0 && !state.renderedSections.has(index)) {
              // 渲染当前章节
              renderSection(index, options).catch(() => { });

              // 预加载相邻章节
              const prevIndex = index - 1;
              const nextIndex = index + 1;

              if (prevIndex >= 0 && !state.renderedSections.has(prevIndex)) {
                renderSection(prevIndex, options).catch(() => { });
              }

              if (nextIndex < sectionCount && !state.renderedSections.has(nextIndex)) {
                renderSection(nextIndex, options).catch(() => { });
              }
            }
          }
        });
      },
      {
        root: container,
        rootMargin: '200px 0px', // 提前200px开始加载
        threshold: [0, 0.3, 0.5, 1.0],
      }
    );

    // 观察所有章节容器
    state.sectionContainers.forEach((wrapper) => {
      sectionObserver!.observe(wrapper);
    });
  };

  /**
   * 确保指定章节及邻近章节已渲染（用于导航完成后补充渲染）
   */
  const ensureSectionsRendered = (sectionIndex: number): void => {
    const renderOptions = {
      theme: context.currentTheme,
      pageGap: context.currentPageGap,
    };

    // 渲染当前章节
    if (!state.renderedSections.has(sectionIndex)) {
      renderSection(sectionIndex, renderOptions).catch(() => { });
    }

    // 渲染前一章节
    const prevIndex = sectionIndex - 1;
    if (prevIndex >= 0 && !state.renderedSections.has(prevIndex)) {
      renderSection(prevIndex, renderOptions).catch(() => { });
    }

    // 渲染后一章节
    const nextIndex = sectionIndex + 1;
    if (nextIndex < sectionCount && !state.renderedSections.has(nextIndex)) {
      renderSection(nextIndex, renderOptions).catch(() => { });
    }
  };

  /**
   * 跳转到指定页面
   * 支持精确进度：page 可以是浮点数，整数部分表示章节，小数部分表示章节内偏移
   */
  const goToPage = async (page: number): Promise<void> => {
    // 提取整数页码和章节内偏移
    const intPage = Math.floor(page);
    const offsetRatio = page - intPage;

    if (intPage < 1 || intPage > sectionCount) return;

    const targetWrapper = state.sectionContainers.get(intPage - 1);
    if (targetWrapper) {
      state.isNavigating = true;

      // 使用立即滚动代替平滑滚动，避免中间章节被渲染
      targetWrapper.scrollIntoView({ behavior: 'auto', block: 'start' });

      // 应用章节内偏移
      if (offsetRatio > 0 && state.scrollContainer) {
        const sectionHeight = targetWrapper.scrollHeight;
        const offsetPx = sectionHeight * offsetRatio;
        state.scrollContainer.scrollTop += offsetPx;
      }

      state.currentPage = intPage;
      state.currentPreciseProgress = page;

      setTimeout(() => {
        state.isNavigating = false;

        // 导航完成后主动渲染目标章节及邻近章节
        ensureSectionsRendered(intPage - 1);

        if (context.onPageChange) {
          context.onPageChange(page);
        }

        if (context.onFirstScreenReady) {
          context.onFirstScreenReady();
        }
      }, 300);
    }
  };

  /**
   * 更新章节间距
   */
  const updatePageGap = (pageGap: number): void => {
    const bandHeight = pageGap * 2 + 1;
    state.dividerElements.forEach((divider) => {
      divider.style.height = `${bandHeight}px`;
    });
  };

  /**
   * 更新分隔线可见性
   */
  const updateDividerVisibilityFn = (hidden: boolean): void => {
    const theme = context.currentTheme || 'light';
    const pageGap = context.currentPageGap ?? 4;
    const bandHeight = pageGap * 2 + 1;
    const isDark = theme === 'dark';
    const dividerColor = isDark ? '#ffffff' : '#000000';

    state.dividerElements.forEach((divider) => {
      if (hidden) {
        toggleDividerVisibility(divider as HTMLDivElement, true);
      } else {
        updateDividerStyle(divider as HTMLDivElement, {
          height: bandHeight,
          color: dividerColor,
          hidden: false,
        });
      }
    });
  };

  /**
   * 纵向连续渲染入口
   */
  const renderVerticalContinuous = async (
    container: HTMLElement,
    options?: RenderOptions
  ): Promise<void> => {

    // 清理之前的资源
    resourceHook.clearBlobUrls();

    // 标记为纵向连续模式
    state.verticalContinuousMode = true;

    // 清理旧的观察器
    if (sectionObserver) {
      sectionObserver.disconnect();
      sectionObserver = null;
    }

    // 保存滚动容器引用
    state.scrollContainer = container;

    // 清空容器
    container.innerHTML = '';
    container.style.cssText = `
      overflow-y: auto;
      overflow-x: hidden;
      height: 100%;
      width: 100%;
      position: relative;
    `;

    // 清空之前的容器映射
    state.sectionContainers.clear();
    state.renderedSections.clear();
    state.dividerElements = [];

    const theme = options?.theme || context.currentTheme || 'light';
    const pageGap = options?.pageGap ?? context.currentPageGap;

    // 同步最新的主题和页间距到上下文，确保后续渲染保持一致
    context.currentTheme = theme;
    context.currentPageGap = pageGap;

    // 只创建章节容器，分隔线在 renderSection 中按需插入
    for (let i = 0; i < sectionCount; i++) {
      const wrapper = document.createElement('div');
      wrapper.className = 'epub-section-wrapper';
      wrapper.dataset.sectionIndex = String(i);
      wrapper.style.cssText = `
        min-height: 200px;
        padding: 0 16px;
        box-sizing: border-box;
      `;

      container.appendChild(wrapper);
      state.sectionContainers.set(i, wrapper);
    }

    // 初始化时应用当前的 hideDivider 状态
    if (typeof options?.hideDivider === 'boolean') {
      updateDividerVisibilityFn(options.hideDivider);
    }

    // 设置滚动监听，用于更新目录高亮和进度
    setupScrollListener(container);

    // 初始渲染当前章节及前后各1章
    const rawProgress =
      typeof options?.initialVirtualPage === 'number' && isFinite(options.initialVirtualPage)
        ? options.initialVirtualPage
        : 1;
    let initialPageInt = Math.floor(rawProgress);
    if (initialPageInt < 1) initialPageInt = 1;
    if (sectionCount > 0 && initialPageInt > sectionCount) {
      initialPageInt = sectionCount;
    }
    let initialOffset = rawProgress - Math.floor(rawProgress);
    if (!isFinite(initialOffset) || initialOffset < 0) initialOffset = 0;
    if (initialOffset > 1) initialOffset = 1;
    if (sectionCount > 0 && initialPageInt === sectionCount) {
      initialOffset = 0;
    }
    state.currentPage = initialPageInt;
    state.currentPreciseProgress = initialPageInt + initialOffset;

    const currentIndex = initialPageInt - 1;
    let sectionsToRender = [
      currentIndex,
      Math.max(0, currentIndex - 1),
      Math.min(sectionCount - 1, currentIndex + 1),
    ].filter((v, i, arr) => arr.indexOf(v) === i && v >= 0 && v < sectionCount);

    if (sectionsToRender.length === 0 && sectionCount > 0) {
      sectionsToRender = [0];
      state.currentPage = 1;
      state.currentPreciseProgress = 1;
    }

    // 优化：优先渲染当前章节，渲染完成后立即触发首屏回调
    // 相邻章节异步渲染，不阻塞首屏显示
    const currentSectionIndex = sectionsToRender[0]; // 当前章节索引
    const neighborSections = sectionsToRender.slice(1); // 相邻章节

    // 渲染当前章节
    await renderSection(currentSectionIndex, options);

    // 当前章节渲染完成，立即触发首屏回调
    if (context.onFirstScreenReady) {
      context.onFirstScreenReady();
    }

    // 相邻章节异步渲染，不阻塞
    for (const index of neighborSections) {
      renderSection(index, options).catch(() => { });
    }

    // 滚动到当前章节并恢复精确偏移位置
    if (initialPageInt > 1 || initialOffset > 0) {
      const targetWrapper = state.sectionContainers.get(currentIndex);
      if (targetWrapper) {
        // 等待滚动完成，确保 DOM 更新
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => {
            // 先滚动到章节开头
            targetWrapper.scrollIntoView({ behavior: 'auto', block: 'start' });
            // 等待滚动生效后应用章节内偏移
            requestAnimationFrame(() => {
              // 应用章节内偏移：根据偏移比例计算具体像素值
              if (initialOffset > 0 && targetWrapper.scrollHeight > 0) {
                const offsetPx = targetWrapper.scrollHeight * initialOffset;
                container.scrollTop += offsetPx;
              }
              resolve();
            });
          });
        });
      }
    }

    // 滚动完成后再设置 IntersectionObserver 进行懒加载，避免初始位置触发首页渲染
    setupSectionObserver(container, options);

    // 初始化目录高亮：首次渲染完成后主动更新，确保目录面板正确定位
    // 使用 async IIFE 处理懒加载场景，等待书籍加载完成后再更新
    (async () => {
      // 等待 DOM 更新完成
      await new Promise(resolve => requestAnimationFrame(resolve));
      updateScrollProgress();
    })();
  };

  /**
   * 清理资源
   */
  const cleanup = (): void => {
    if (sectionObserver) {
      try {
        sectionObserver.disconnect();
      } catch { }
      sectionObserver = null;
    }

    if (state.scrollRafId !== null) {
      try {
        cancelAnimationFrame(state.scrollRafId);
      } catch { }
      state.scrollRafId = null;
    }

    if (state.scrollContainer) {
      try {
        if ((state.scrollContainer as any)._verticalScrollHandler) {
          state.scrollContainer.removeEventListener('scroll', (state.scrollContainer as any)._verticalScrollHandler);
          delete (state.scrollContainer as any)._verticalScrollHandler;
        }
        state.scrollContainer.innerHTML = '';
        state.scrollContainer.removeAttribute('style'); // 清除样式
      } catch { }
      state.scrollContainer = null;
    }

    state.verticalContinuousMode = false;
    state.sectionContainers.clear();
    state.renderedSections.clear();
    state.renderingInProgress.clear();
    state.dividerElements = [];
  };

  /**
   * 离屏预渲染指定章节到缓存
   * 用于导入阶段预热，在后台执行渲染并写入缓存，不影响 UI
   */
  const preloadSectionsOffscreen = async (indices: number[]): Promise<void> => {
    if (indices.length === 0) return;

    const { bookId, sectionCache } = context;
    if (!bookId || !sectionCache) {
      throw new Error('缓存服务未初始化');
    }

    // 创建离屏容器（不插入 DOM 树，避免影响页面）
    const offscreenContainer = document.createElement('div');
    offscreenContainer.style.cssText = `
    position: absolute;
    left: -10000px;
    top: -10000px;
    width: 800px;
    height: 600px;
    visibility: hidden;
    pointer - events: none;
    `;
    document.body.appendChild(offscreenContainer);

    // 临时保存原有状态
    const originalSectionContainers = state.sectionContainers;
    const originalRenderedSections = state.renderedSections;

    // 创建临时状态
    state.sectionContainers = new Map();
    state.renderedSections = new Set();

    try {
      // 为每个待预热章节创建临时容器
      for (const index of indices) {
        // 跳过已缓存的章节
        const cached = sectionCache.getSection(bookId, index);
        if (cached) {
          continue;
        }

        const wrapper = document.createElement('div');
        wrapper.dataset.sectionIndex = String(index);
        wrapper.style.cssText = `
          min-height: 200px;
          padding: 0 16px;
          box-sizing: border-box;
        `;
        offscreenContainer.appendChild(wrapper);
        state.sectionContainers.set(index, wrapper);
      }

      // 执行渲染（会自动写入缓存）
      for (const index of indices) {
        if (!state.sectionContainers.has(index)) continue;

        try {
          await renderSection(index, { theme: 'light' });
        } catch (e) {
          logError(`[EPUB预热] 章节 ${index + 1} 预热失败: ${e}`).catch(() => { });
        }
      }

      log(`[EPUB预热] 预热流程完成`).catch(() => { });
    } finally {
      // 清理临时容器
      offscreenContainer.remove();

      // 恢复原有状态
      state.sectionContainers = originalSectionContainers;
      state.renderedSections = originalRenderedSections;
    }
  };

  return {
    state,
    renderVerticalContinuous,
    setupSectionObserver,
    renderSection,
    calculateScrollOffset,
    updateScrollProgress,
    ensureSectionsRendered,
    goToPage,
    updatePageGap,
    cleanup,
    setNavigationHook,
    preloadSectionsOffscreen,
    updateDividerVisibility: updateDividerVisibilityFn,
  };
}

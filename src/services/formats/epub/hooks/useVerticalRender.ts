/**
 * EPUB 纵向连续渲染 Hook
 * 实现纵向连续阅读模式的完整逻辑
 */

import { RenderOptions, ReaderTheme } from '../../types';
import { logError } from '../../../index';
import { EpubBook } from './useEpubLoader';
import { EpubResourceHook } from './useEpubResource';
import { EpubThemeHook } from './useEpubTheme';
import { EpubNavigationHook } from './useEpubNavigation';
import {
  type IEpubSectionCache,
  type IEpubResourceCache,
  type EpubSectionCacheEntry,
  getMimeType,
} from '../cache';
import { epubCacheService } from '../epubCacheService';

/** 纵向渲染上下文 */
export interface VerticalRenderContext {
  book: EpubBook | null;
  sectionCount: number;
  currentTheme: ReaderTheme;
  currentPageGap: number;
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
  /** 确保书籍已加载（用于懒加载模式） */
  ensureBookLoaded?: () => Promise<void>;
}

/** 纵向渲染状态 */
export interface VerticalRenderState {
  verticalContinuousMode: boolean;
  sectionContainers: Map<number, HTMLElement>;
  renderedSections: Set<number>;
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
  /** 清理资源 */
  cleanup: () => void;
  /** 设置导航 hook（在初始化后设置，解决循环依赖） */
  setNavigationHook: (hook: EpubNavigationHook) => void;
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

    // 跳转期间不更新页码，避免冲突
    if (state.isNavigating) return;

    const container = state.scrollContainer;
    const scrollTop = container.scrollTop;
    const viewportHeight = container.clientHeight;
    const centerY = scrollTop + viewportHeight / 2;

    // 查找视口中心所在的章节
    let currentSectionIndex = -1;

    state.sectionContainers.forEach((wrapper, index) => {
      const rect = wrapper.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const relativeTop = rect.top - containerRect.top + scrollTop;
      const relativeBottom = relativeTop + rect.height;

      // 检查视口中心是否在这个章节内
      if (centerY >= relativeTop && centerY < relativeBottom) {
        currentSectionIndex = index;
      }
    });

    if (currentSectionIndex >= 0) {
      const newPage = currentSectionIndex + 1;

      // 更新当前页码
      if (newPage !== state.currentPage) {
        state.currentPage = newPage;
      }

      const offset = calculateScrollOffset();
      const preciseProgress = newPage + offset;
      state.currentPreciseProgress = preciseProgress;

      if (context.onPageChange) {
        context.onPageChange(preciseProgress);
      }

      // 更新目录高亮（通过 href）
      if (context.onTocChange && context.book) {
        const section = context.book.sections[currentSectionIndex];
        if (section && section.id) {
          context.onTocChange(section.id);
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
  };

  /**
   * 渲染单个章节
   */
  const renderSection = async (index: number, options?: RenderOptions): Promise<void> => {
    if (state.renderedSections.has(index)) {
      return;
    }

    const wrapper = state.sectionContainers.get(index);
    if (!wrapper) {
      return;
    }

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
            logError(`[EpubRenderer] 从后端磁盘恢复章节 ${index + 1} 到内存`).catch(() => {});
          }
        } catch {
          // 后端加载失败，继续常规渲染
        }
      }

      if (cacheEntry) {
        logError(`[EpubRenderer] 从缓存加载章节 ${index + 1}`).catch(() => {});

        try {
          // 使用 shadow DOM 隔离样式
          const shadow = wrapper.attachShadow({ mode: 'open' });

          // 注入主题样式
          const style = document.createElement('style');
          style.textContent = themeHook.getThemeStyles(options);
          shadow.appendChild(style);

          // 注入原文档样式
          if (cacheEntry.rawStyles.length > 0) {
            const originalStyleEl = document.createElement('style');
            originalStyleEl.textContent = cacheEntry.rawStyles.join('\n');
            shadow.appendChild(originalStyleEl);
          }

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
                  logError(`[EpubRenderer] 从 IndexedDB 恢复资源: ${ref}`).catch(() => {});
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
              const mimeType = getMimeType(ref);
              const blob = new Blob([data], { type: mimeType });
              const blobUrl = URL.createObjectURL(blob);
              // 记录 blobUrl 以便后续清理（通过 resourceHook 管理）
              const placeholder = `__EPUB_RES__:${ref}`;
              restoredHtml = restoredHtml.split(placeholder).join(blobUrl);
            }
          }

          // 注入恢复后的内容
          const content = document.createElement('div');
          content.className = 'epub-section-content';
          content.innerHTML = restoredHtml;
          shadow.appendChild(content);

          // 处理链接点击事件
          if (navigationHook) {
            navigationHook.setupLinkHandlers(content, index);
          }

          // 标记已渲染
          state.renderedSections.add(index);
          wrapper.dataset.rendered = 'true';

          logError(`[EpubRenderer] 章节 ${index + 1} 从缓存加载完成`).catch(() => {});
          return;
        } catch (e) {
          logError(`[EpubRenderer] 从缓存恢复章节 ${index + 1} 失败，回退到解析:`, e).catch(() => {});
        }
      }
    }

    // 缓存未命中，按原逻辑解析
    logError(`[EpubRenderer] 开始解析渲染章节 ${index + 1}`).catch(() => {});

    // 如果书籍对象不可用且支持懒加载，尝试等待
    if (!context.book && context.ensureBookLoaded) {
      try {
        logError(`[EpubRenderer] 章节 ${index + 1} 等待书籍加载...`).catch(() => {});
        await context.ensureBookLoaded();
      } catch (e) {
        logError(`[EpubRenderer] 等待书籍加载失败:`, e).catch(() => {});
      }
    }

    const currentBook = context.book;
    if (!currentBook) {
      logError(`[EpubRenderer] 章节 ${index + 1} 渲染失败: 书籍未就绪`).catch(() => {});
      return;
    }

    try {
      const section = currentBook.sections[index];
      if (!section || !section.createDocument) {
        logError(`[EpubRenderer] 章节 ${index + 1} 无效`).catch(() => {});
        return;
      }

      const doc = await section.createDocument();

      // 创建临时容器，在注入 Shadow DOM 之前处理资源路径
      const tempContent = document.createElement('div');
      tempContent.innerHTML = doc.body.innerHTML;

      // 收集资源引用（在修复路径之前）
      const resourceRefs = resourceHook.collectResourceRefs(tempContent, section);

      // 加载原文档样式
      const originalStyles = await resourceHook.loadAndProcessStyles(doc, section);

      // 在原始文档上下文中解析资源路径
      await resourceHook.fixResourcePaths(tempContent, section);

      // 使用 shadow DOM 隔离样式
      const shadow = wrapper.attachShadow({ mode: 'open' });

      // 注入主题样式
      const style = document.createElement('style');
      style.textContent = themeHook.getThemeStyles(options);
      shadow.appendChild(style);

      // 注入原文档样式（包括外部 CSS）
      if (originalStyles) {
        const originalStyleEl = document.createElement('style');
        originalStyleEl.textContent = originalStyles;
        shadow.appendChild(originalStyleEl);
      }

      // 注入已处理的内容
      const content = document.createElement('div');
      content.className = 'epub-section-content';
      content.innerHTML = tempContent.innerHTML;
      shadow.appendChild(content);

      // 处理链接点击事件
      if (navigationHook) {
        navigationHook.setupLinkHandlers(content, index);
      }

      // 标记已渲染
      state.renderedSections.add(index);
      wrapper.dataset.rendered = 'true';

      // 写入缓存（异步执行，不阻塞渲染）
      if (bookId && sectionCache && resourceCache) {
        (async () => {
          try {
            // 将 HTML 中的资源路径替换为占位符
            const normalizedHtml = resourceHook.normalizeHtmlResources(
              doc.body.innerHTML,
              resourceRefs,
              section
            );

            // 缓存资源数据（内存 + IndexedDB 双写）
            for (const ref of resourceRefs) {
              if (!resourceCache.has(bookId, ref)) {
                const data = await resourceHook.loadResourceData(ref);
                if (data) {
                  const mimeType = getMimeType(ref);
                  resourceCache.set(bookId, ref, data, mimeType);
                  // 同时写入 IndexedDB 持久化
                  epubCacheService.saveResourceToDB({
                    bookId,
                    resourcePath: ref,
                    data,
                    mimeType,
                    sizeBytes: data.byteLength,
                    lastAccessTime: Date.now(),
                  }).catch(() => {});
                }
              } else {
                resourceCache.addRef(bookId, ref);
              }
            }

            // 构建缓存条目
            const cacheEntry: EpubSectionCacheEntry = {
              bookId,
              sectionIndex: index,
              rawHtml: normalizedHtml,
              rawStyles: originalStyles ? [originalStyles] : [],
              resourceRefs,
              meta: {
                sizeBytes: 0,
                createdAt: Date.now(),
                lastAccessTime: Date.now(),
                sectionId: section.id || null,
              },
            };

            // 写入内存缓存
            sectionCache.setSection(cacheEntry);
            
            // 同时写入 IndexedDB 持久化（异步，不阻塞）
            epubCacheService.saveSectionToDB(cacheEntry).catch(() => {});
            
            logError(`[EpubRenderer] 章节 ${index + 1} 已写入缓存`).catch(() => {});
          } catch (e) {
            logError(`[EpubRenderer] 写入章节 ${index + 1} 缓存失败:`, e).catch(() => {});
          }
        })();
      }

      logError(`[EpubRenderer] 章节 ${index + 1} 渲染完成`).catch(() => {});
    } catch (e) {
      logError(`[EpubRenderer] 渲染章节 ${index + 1} 失败:`, e).catch(() => {});
    }
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
              renderSection(index, options).catch(async (e) => {
                await logError('渲染章节失败', { error: String(e), sectionIndex: index });
              });

              // 预加载相邻章节
              const prevIndex = index - 1;
              const nextIndex = index + 1;

              if (prevIndex >= 0 && !state.renderedSections.has(prevIndex)) {
                renderSection(prevIndex, options).catch(async (e) => {
                  await logError('渲染章节失败', { error: String(e), sectionIndex: prevIndex });
                });
              }

              if (nextIndex < sectionCount && !state.renderedSections.has(nextIndex)) {
                renderSection(nextIndex, options).catch(async (e) => {
                  await logError('渲染章节失败', { error: String(e), sectionIndex: nextIndex });
                });
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
      renderSection(sectionIndex, renderOptions).catch(() => {});
    }

    // 渲染前一章节
    const prevIndex = sectionIndex - 1;
    if (prevIndex >= 0 && !state.renderedSections.has(prevIndex)) {
      renderSection(prevIndex, renderOptions).catch(() => {});
    }

    // 渲染后一章节
    const nextIndex = sectionIndex + 1;
    if (nextIndex < sectionCount && !state.renderedSections.has(nextIndex)) {
      renderSection(nextIndex, renderOptions).catch(() => {});
    }
  };

  /**
   * 跳转到指定页面
   */
  const goToPage = async (page: number): Promise<void> => {
    if (page < 1 || page > sectionCount) return;

    const targetWrapper = state.sectionContainers.get(page - 1);
    if (targetWrapper) {
      state.isNavigating = true;

      // 使用立即滚动代替平滑滚动，避免中间章节被渲染
      targetWrapper.scrollIntoView({ behavior: 'auto', block: 'start' });
      state.currentPage = page;
      state.currentPreciseProgress = page;

      // 立即滚动完成较快，300ms 足够
      setTimeout(() => {
        state.isNavigating = false;

        // 导航完成后主动渲染目标章节及邻近章节
        ensureSectionsRendered(page - 1);

        if (context.onPageChange) {
          context.onPageChange(page);
        }
      }, 300);
    }
  };

  /**
   * 更新章节间距
   * 注意：外层 EpubRenderer.updatePageGap 已做重复值检查，这里直接执行 DOM 更新
   */
  const updatePageGap = (pageGap: number): void => {
    state.dividerElements.forEach((divider) => {
      const bandHeight = pageGap * 2 + 1;
      divider.style.height = `${bandHeight}px`;
    });
  };

  /**
   * 纵向连续渲染入口
   */
  const renderVerticalContinuous = async (
    container: HTMLElement,
    options?: RenderOptions
  ): Promise<void> => {
    logError('[EpubRenderer] 开始纵向连续渲染模式').catch(() => {});

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
    const dividerBandHeight = pageGap * 2 + 1;    
    // 获取分隔线颜色
    const isDark = theme === 'dark';
    const dividerColor = isDark ? '#ffffff' : '#000000';

    for (let i = 0; i < sectionCount; i++) {
      if (i > 0) {
        const divider = document.createElement('div');
        divider.className = 'epub-section-divider';
        divider.style.cssText = `
          height: ${dividerBandHeight}px;
          background-color: ${dividerColor};
          margin: 0;
          width: 100%;
        `;
        container.appendChild(divider);
        state.dividerElements.push(divider);
      }

      // 创建章节容器
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
      logError('[EpubRenderer] 首屏渲染完成，触发回调').catch(() => {});
    }
    
    // 相邻章节异步渲染，不阻塞
    for (const index of neighborSections) {
      renderSection(index, options).catch(() => {});
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

    logError('[EpubRenderer] 纵向连续渲染模式初始化完成').catch(() => {});
  };

  /**
   * 清理资源
   */
  const cleanup = (): void => {
    if (sectionObserver) {
      try {
        sectionObserver.disconnect();
      } catch {}
      sectionObserver = null;
    }

    if (state.scrollRafId !== null) {
      try {
        cancelAnimationFrame(state.scrollRafId);
      } catch {}
      state.scrollRafId = null;
    }

    state.scrollContainer = null;
    state.verticalContinuousMode = false;
    state.sectionContainers.clear();
    state.renderedSections.clear();
    state.dividerElements = [];
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
  };
}

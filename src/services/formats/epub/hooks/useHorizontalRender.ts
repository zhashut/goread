/**
 * EPUB 横向渲染 Hook
 * 处理基于 foliate-js 的横向翻页模式
 */

import { RenderOptions, ReaderTheme } from '../../types';
import { logError } from '../../../index';
import { EpubBook } from './useEpubLoader';
import { FoliateView, EpubThemeHook } from './useEpubTheme';
import { EpubResourceHook } from './useEpubResource';
// import { epubCacheService } from '../epubCacheService';

/** 横向渲染上下文 */
export interface HorizontalRenderContext {
  book: EpubBook | null;
  bookId: string | null;
  sectionCount: number;
  totalPages: number;
  currentTheme: ReaderTheme;
  themeHook: EpubThemeHook;
  resourceHook: EpubResourceHook;
  onPageChange?: (page: number) => void;
  onTocChange?: (href: string) => void;
  /** 确保书籍加载（用于懒加载等待） */
  ensureBookLoaded: () => Promise<void>;
  /** 书籍加载 Promise（用于检查是否正在加载） */
  bookLoadPromise?: Promise<void> | null;
  /** 用于判断是否就绪 */
  isReady: boolean;
}

/** 横向渲染状态 */
export interface HorizontalRenderState {
  view: FoliateView | null;
  currentPage: number;
  currentPreciseProgress: number;
  readingMode: 'horizontal' | 'vertical';
}

/** 横向渲染 Hook 返回接口 */
export interface HorizontalRenderHook {
  state: HorizontalRenderState;
  /** 渲染横向模式 */
  renderHorizontal: (page: number, container: HTMLElement, options?: RenderOptions) => Promise<void>;
  /** 跳转页面 */
  goToPage: (page: number) => Promise<void>;
  /** 跳转链接 */
  goToHref: (href: string) => Promise<void>;
  /** 下一页 */
  nextPage: () => Promise<void>;
  /** 上一页 */
  prevPage: () => Promise<void>;
  /** 滚动（用于处理触摸板等） */
  scrollBy: (deltaY: number) => void;
  /** 销毁 */
  destroy: () => void;
}

export function useHorizontalRender(context: HorizontalRenderContext): HorizontalRenderHook {
  const state: HorizontalRenderState = {
    view: null,
    currentPage: 1,
    currentPreciseProgress: 1,
    readingMode: 'horizontal',
  };

  let _resizeObserver: ResizeObserver | null = null;
  let _lastRenderContainer: HTMLElement | null = null;

  /**
   * 应用流式布局设置（安全地）
   */
  const _applyFlowSafely = (): void => {
    const r: any = state.view?.renderer;
    if (!r) return;
    const hasContents = typeof r.getContents === 'function'
      && Array.isArray(r.getContents())
      && r.getContents().length > 0
      && r.getContents()[0]?.doc;
    const apply = () => {
      try {
        // 始终使用滚动模式，以确保内容完整显示并支持滚动
        r.setAttribute('flow', 'scrolled');
      } catch {}
    };
    if (hasContents) {
      apply();
    } else if (typeof r.addEventListener === 'function') {
      const once = () => {
        apply();
        try { r.removeEventListener('load', once as any); } catch {}
      };
      r.addEventListener('load', once as any);
    }
  };

  /**
   * 禁用 foliate-view 内部的触摸交互
   */
  const _disableFoliateTouch = (): void => {
    try {
      // 保留默认指针事件，避免滚动与滚轮被屏蔽
      // foliate-js 的触摸翻页由内部处理，我们通过外层控件进行点击翻页即可
    } catch (e) {
      logError('[HorizontalRender] 禁用触摸事件失败:', e).catch(() => {});
    }
  };

  /**
   * 处理位置变化事件
   */
  const _handleRelocate = (detail: any): void => {
    // 兼容不同的事件数据结构：优先使用 index，否则尝试从 section.current 获取
    let pageIndex: number | undefined;
    if (typeof detail?.index === 'number') {
      pageIndex = detail.index;
    } else if (typeof detail?.section?.current === 'number') {
      pageIndex = detail.section.current;
    }

    if (typeof pageIndex === 'number') {
      state.currentPage = pageIndex + 1;
      state.currentPreciseProgress = state.currentPage;
    }

    // 更新当前目录项 href（用于高亮）
    const currentTocHref = detail?.tocItem?.href;
    
    // 触发回调
    if (context.onPageChange) {
      context.onPageChange(state.currentPage);
    }
    if (context.onTocChange && currentTocHref) {
      context.onTocChange(currentTocHref);
    }
  };

  /**
   * 应用主题
   */
  const _applyTheme = (view: FoliateView, options?: RenderOptions): void => {
    context.themeHook.applyTheme(view, options);
  };

  /**
   * 渲染横向模式
   */
  const renderHorizontal = async (
    page: number,
    container: HTMLElement,
    options?: RenderOptions
  ): Promise<void> => {
    // 必须等待 book 加载完成
    if (!context.book && context.bookLoadPromise) {
      logError('[HorizontalRender] 等待懒加载完成...').catch(() => {});
      await context.ensureBookLoaded();
    }

    if (!context.isReady || !context.book) {
      throw new Error('Document not loaded');
    }

    const theme = options?.theme || context.currentTheme || 'light';
    state.readingMode = 'horizontal';

    // 检查是否可以复用现有视图
    const canReuseView = state.view 
      && _lastRenderContainer === container
      && container.contains(state.view);

    if (canReuseView) {
      // 复用现有视图
      _applyTheme(state.view!, {
        ...options,
        theme,
      });
      _applyFlowSafely();
      
      // 跳转到指定位置
      const initialProgress = options?.initialVirtualPage;
      const targetPage = initialProgress && initialProgress > 0
        ? Math.floor(initialProgress)
        : page; 
      const clampedTarget = Math.min(context.sectionCount, Math.max(1, targetPage));

      if (clampedTarget !== state.currentPage) {
        await goToPage(clampedTarget);
      }
      return;
    }

    // 清空容器
    container.innerHTML = '';
    _lastRenderContainer = container;

    // 创建 foliate-view 元素
    // @ts-ignore - foliate-js
    await import('../../../../lib/foliate-js/view.js');

    const view = document.createElement('foliate-view') as FoliateView;
    view.style.cssText = `
      width: 100%;
      height: 100%;
      display: block;
    `;

    const containerWidth = container.clientWidth;

    _applyTheme(view, {
      ...options,
      theme,
    });

    container.appendChild(view);
    state.view = view;

    // 监听位置变化事件
    view.addEventListener('relocate', (e: any) => {
      _handleRelocate(e.detail);
    });

    // 禁用触摸事件
    view.addEventListener('load', () => {
      _disableFoliateTouch();
      _applyFlowSafely();
    });

    // 打开书籍
    await view.open(context.book);

    // 注入缓存（如果 resourceHook 支持）
    // 暂时禁用以排查白屏问题（与旧代码保持一致）
    // if (context.resourceHook.injectResourceCacheToBook && context.bookId) {
    //   context.resourceHook.injectResourceCacheToBook(
    //     context.book, 
    //     context.bookId, 
    //     epubCacheService.resourceCache
    //   );
    // }
    
    const r: any = view.renderer;
    if (r?.setAttribute) {
      const effectiveWidth = containerWidth > 0
        ? Math.max(280, containerWidth - 32)
        : 360;
      r.setAttribute('max-inline-size', `${effectiveWidth}px`);
      r.setAttribute('max-column-count', '1');
      r.setAttribute('margin', '24px');
    }

    // ResizeObserver
    try {
      if (_resizeObserver) {
        _resizeObserver.disconnect();
        _resizeObserver = null;
      }
      _resizeObserver = new ResizeObserver((entries) => {
        const width = entries[0]?.contentRect?.width || 0;
        if (width > 0 && state.view?.renderer?.setAttribute && state.view.isConnected) {
          const effectiveWidth = Math.max(280, width - 32);
          state.view.renderer.setAttribute('max-inline-size', `${effectiveWidth}px`);
        }
      });
      _resizeObserver.observe(container);
    } catch {}

    _applyFlowSafely();
    
    // 初始化位置
    const initialProgress = options?.initialVirtualPage;
    const initialPage = initialProgress && initialProgress > 0
      ? Math.floor(initialProgress)
      : page;
    const clampedInitialPage = Math.min(context.sectionCount, Math.max(1, initialPage));

    if (clampedInitialPage > 1) {
      await view.init({ lastLocation: clampedInitialPage - 1 });
      state.currentPage = clampedInitialPage;
    } else {
      await view.init({ showTextStart: true });
      state.currentPage = 1;
    }
    state.currentPreciseProgress = initialProgress && initialProgress > 0
      ? initialProgress
      : state.currentPage;

    // 等待渲染
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
    });

    _applyFlowSafely();

    // 回流兜底
    try {
      const r: any = state.view?.renderer;
      if (r?.setAttribute) {
        const containerWidth2 = container.clientWidth || 0;
        const effectiveWidth2 = containerWidth2 > 0
          ? Math.max(280, containerWidth2 - 32)
          : 360;
        const tweak = Math.max(200, effectiveWidth2 - 1);
        r.setAttribute('max-inline-size', `${tweak}px`);
        r.setAttribute('max-inline-size', `${effectiveWidth2}px`);
        r.setAttribute('flow', 'scrolled');
        r.setAttribute('max-column-count', '1');
      }
    } catch {}

    // 白屏检测与重试逻辑
    const isReady = () => {
      try {
        const r: any = state.view?.renderer;
        const doc = r?.getContents?.()[0]?.doc;
        if (!doc) return false;
        const h = Math.max(doc.body?.scrollHeight || 0, doc.documentElement?.scrollHeight || 0);
        const w = Math.max(doc.body?.scrollWidth || 0, doc.documentElement?.scrollWidth || 0);
        return h > 0 || w > 0;
      } catch { return false; }
    };

    const waitFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

    if (!isReady()) {
      await waitFrame();
      _applyFlowSafely();
    }
    if (!isReady()) {
      await state.view!.init({ showTextStart: true });
      await waitFrame();
      _applyFlowSafely();
    }
    if (!isReady()) {
      // 这里的重试逻辑比较复杂，创建了 view2，我简化一下，如果这里失败，就尝试 close and recreate
      // 但为了保持原逻辑一致性，我应该尽可能保留。
      // 原逻辑是删除旧的，创建新的。
      try {
        const old = state.view!;
        old.close();
        container.removeChild(old);
      } catch {}
      
      const view2 = document.createElement('foliate-view') as FoliateView;
      view2.style.cssText = `
        width: 100%;
        height: 100%;
        display: block;
      `;
      _applyTheme(view2, { ...options, theme });
      container.appendChild(view2);
      state.view = view2;
      view2.addEventListener('relocate', (e: any) => _handleRelocate(e.detail));
      view2.addEventListener('load', () => { _disableFoliateTouch(); _applyFlowSafely(); });
      await view2.open(context.book);
      
      // 暂时禁用资源缓存注入
      // if (context.resourceHook.injectResourceCacheToBook && context.bookId) {
      //   context.resourceHook.injectResourceCacheToBook(
      //     context.book, 
      //     context.bookId, 
      //     epubCacheService.resourceCache
      //   );
      // }

      const r2: any = view2.renderer;
      if (r2?.setAttribute) {
        const w2 = container.clientWidth;
        const eff2 = w2 > 0 ? Math.max(280, w2 - 32) : 360;
        r2.setAttribute('max-inline-size', `${eff2}px`);
        r2.setAttribute('max-column-count', '1');
        r2.setAttribute('margin', '24px');
      }
      await view2.init({ showTextStart: true });
      await waitFrame();
      _applyFlowSafely();
    }
  };

  /** 跳转页面 */
  const goToPage = async (page: number): Promise<void> => {
      if (!state.view || page < 1 || page > context.totalPages) return;
      const sectionIndex = page - 1;
      try {
        await state.view.goTo(sectionIndex);
        state.currentPage = page;
        state.currentPreciseProgress = page;
        setTimeout(() => {
          if (context.onPageChange) context.onPageChange(page);
        }, 300);
      } catch (e) {
        logError('[HorizontalRender] 跳转失败', { error: String(e), page }).catch(() => {});
      }
  };

  return {
    state,
    renderHorizontal,
    goToPage,
    goToHref: async (href: string) => {
      if (!state.view) return;
      try {
        await state.view.goTo(href);
      } catch (e) {
        logError('[HorizontalRender] 跳转到 href 失败', { error: String(e), href }).catch(() => {});
      }
    },
    nextPage: async () => {
      if (!state.view) return;
      await state.view.next();
    },
    prevPage: async () => {
      if (!state.view) return;
      await state.view.prev();
    },
    scrollBy: (deltaY: number) => {
      const r = state.view?.renderer;
      if (!r || typeof r.scrollBy !== 'function') return;
      try {
        r.scrollBy(deltaY, deltaY);
      } catch {}
    },
    destroy: () => {
      if (_resizeObserver) {
        _resizeObserver.disconnect();
        _resizeObserver = null;
      }
      if (state.view) {
        try { state.view.close(); } catch {}
        state.view = null;
      }
      _lastRenderContainer = null;
    },
  };
}

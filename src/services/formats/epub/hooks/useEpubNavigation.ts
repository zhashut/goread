/**
 * EPUB 导航 Hook
 * 处理 EPUB 内部链接的点击和跳转
 */

import { TocItem } from '../../types';

/** 导航上下文 */
export interface NavigationContext {
  /** 动态获取滚动容器的函数，解决初始化时引用为 null 的问题 */
  getScrollContainer: () => HTMLElement | null;
  sectionContainers: Map<number, HTMLElement>;
  goToPage: (page: number) => Promise<void>;
  toc?: TocItem[];
  sectionCount?: number;
}

/** 导航 Hook 返回接口 */
export interface EpubNavigationHook {
  /** 设置链接点击处理 */
  setupLinkHandlers: (content: HTMLElement, sectionIndex: number) => void;
  /** 滚动到锚点 */
  scrollToAnchor: (anchor: string, currentSectionIndex: number) => void;
  /** 导航到指定 href（跨章节） */
  navigateToHref: (href: string) => void;
}

/**
 * EPUB 导航 Hook
 * 提供链接点击处理、锚点跳转等功能
 */
export function useEpubNavigation(context: NavigationContext): EpubNavigationHook {
  const { getScrollContainer, sectionContainers, goToPage } = context;

  /**
   * 滚动到锚点
   */
  const scrollToAnchor = (anchor: string, currentSectionIndex: number): void => {
    const scrollContainer = getScrollContainer();
    if (!scrollContainer) return;

    // 在当前章节中查找锚点
    const wrapper = sectionContainers.get(currentSectionIndex);
    if (!wrapper || !wrapper.shadowRoot) return;

    const target =
      wrapper.shadowRoot.getElementById(anchor) ||
      wrapper.shadowRoot.querySelector(`[name="${anchor}"]`);

    if (target) {
      // 计算目标元素相对于滚动容器的位置
      const containerRect = scrollContainer.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();

      const scrollTop = scrollContainer.scrollTop;
      const targetTop = targetRect.top - containerRect.top + scrollTop;

      scrollContainer.scrollTo({
        top: targetTop,
        behavior: 'smooth',
      });
    }
  };

  /**
   * 导航到指定 href（跨章节）
   */
  const navigateToHref = (href: string): void => {
    const toc = context.toc;
    const sectionCount = context.sectionCount || 0;
    if (!toc || toc.length === 0 || sectionCount <= 0) {
      return;
    }

    const [_, anchor] = href.split('#');

    const normalizeHref = (h: string) => h?.split('#')[0] || '';
    const hrefBase = normalizeHref(href);

    const flat: TocItem[] = [];
    const walk = (items: TocItem[]) => {
      for (const item of items) {
        flat.push(item);
        if (item.children && item.children.length > 0) {
          walk(item.children);
        }
      }
    };

    walk(toc);

    let sectionIndex = -1;
    const normalizedHref = hrefBase || href;

    sectionIndex = flat.findIndex((item) => {
      const loc = item.location;
      if (typeof loc !== 'string' || !loc) return false;
      const locBase = normalizeHref(loc);
      return (
        loc === href ||
        (normalizedHref && locBase === normalizedHref) ||
        loc.endsWith(href) ||
        (normalizedHref && locBase.endsWith(normalizedHref))
      );
    });

    if (sectionIndex >= 0 && sectionCount > 0) {
      if (sectionIndex >= sectionCount) {
        sectionIndex = sectionCount - 1;
      }
    }

    if (sectionIndex >= 0) {
      goToPage(sectionIndex + 1).then(() => {
        if (anchor) {
          setTimeout(() => {
            scrollToAnchor(anchor, sectionIndex);
          }, 300);
        }
      });
    }
  };

  /**
   * 设置链接点击处理
   */
  const setupLinkHandlers = (content: HTMLElement, sectionIndex: number): void => {
    const links = content.querySelectorAll('a[href]');

    links.forEach((link) => {
      const href = link.getAttribute('href');
      if (!href) return;

      link.addEventListener('click', (e) => {
        e.preventDefault();

        // 处理锚点链接（#开头）
        if (href.startsWith('#')) {
          const anchor = href.substring(1);
          scrollToAnchor(anchor, sectionIndex);
          return;
        }

        // 处理相对路径链接（跨章节）
        if (!href.startsWith('http://') && !href.startsWith('https://')) {
          navigateToHref(href);
          return;
        }

        // 外部链接：在浏览器中打开
        window.open(href, '_blank');
      });
    });
  };

  return {
    setupLinkHandlers,
    scrollToAnchor,
    navigateToHref,
  };
}

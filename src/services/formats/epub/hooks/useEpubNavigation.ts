/**
 * EPUB 导航 Hook
 * 处理 EPUB 内部链接的点击和跳转
 */

import { EpubBook } from './useEpubLoader';

/** 导航上下文 */
export interface NavigationContext {
  book: EpubBook | null;
  /** 动态获取滚动容器的函数，解决初始化时引用为 null 的问题 */
  getScrollContainer: () => HTMLElement | null;
  sectionContainers: Map<number, HTMLElement>;
  goToPage: (page: number) => Promise<void>;
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
  const { book, getScrollContainer, sectionContainers, goToPage } = context;

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
    // 解析 href，找到对应的章节
    const [path, anchor] = href.split('#');

    // 查找匹配的章节
    if (book) {
      const sectionIndex = book.sections.findIndex((section: any) => {
        return section.id === path || section.id.endsWith(path);
      });

      if (sectionIndex >= 0) {
        // 跳转到目标章节
        goToPage(sectionIndex + 1).then(() => {
          // 如果有锚点，滚动到锚点
          if (anchor) {
            setTimeout(() => {
              scrollToAnchor(anchor, sectionIndex);
            }, 300);
          }
        });
      }
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

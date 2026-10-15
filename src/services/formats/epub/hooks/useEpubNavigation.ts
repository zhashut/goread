/**
 * EPUB 导航 Hook
 * 处理 EPUB 内部链接的点击和跳转
 *
 * 支持的链接形态：
 * - `#anchor`：章内锚点跳转（含 EPUB3 脚注 `epub:type="noteref"` 引用）
 * - `xx.xhtml#anchor`：跨章节跳转 + 章内锚点定位
 * - `__EPUB_RES__:dir/#anchor`、`epub://dir/#anchor`：旧缓存中被写坏的章内锚点（兼容处理）
 * - `http(s)://`：外部链接
 */

import { TocItem } from '../../types';
import { getSpineIndexForHref } from './tocMapping';

/** 锚点定位重试间隔与次数：跨章节跳转后目标 DOM 可能尚未渲染完成 */
const ANCHOR_RETRY_DELAY_MS = 200;
const ANCHOR_MAX_RETRY = 6;

/** 资源占位符前缀（与 cache/types.ts 保持一致，避免循环依赖此处直接内联） */
const RESOURCE_PLACEHOLDER_PREFIX = '__EPUB_RES__:';

/** 导航上下文 */
export interface NavigationContext {
  /** 取指定章节的 shadow root（纵向为对应章节容器，横向为当前章节容器） */
  getSectionRoot: (sectionIndex: number) => ShadowRoot | null;
  /** 取当前滚动容器 */
  getScrollContainer: () => HTMLElement | null;
  /** 滚动主轴：纵向连续阅读为 y，横向翻页为 x */
  getScrollAxis: () => 'x' | 'y';
  goToPage: (page: number) => Promise<void>;
  toc?: TocItem[];
  spine?: string[];
  sectionCount?: number;
}

/** 导航 Hook 返回接口 */
export interface EpubNavigationHook {
  /** 设置链接点击处理 */
  setupLinkHandlers: (content: HTMLElement, sectionIndex: number) => void;
  /**
   * 滚动到锚点
   * @returns 是否成功定位到目标（目标未渲染时返回 false，供调用方重试）
   */
  scrollToAnchor: (anchor: string, currentSectionIndex: number) => boolean;
  /** 带重试的锚点定位（跨章节跳转后目标 DOM 可能尚未渲染完成） */
  scrollToAnchorWithRetry: (anchor: string, currentSectionIndex: number) => void;
  /** 导航到指定 href（跨章节） */
  navigateToHref: (href: string) => void;
}

/**
 * 归一化链接 href：
 * 旧缓存的章节 HTML 里，章内锚点被 epub crate 写坏成
 * `__EPUB_RES__:OEBPS/#fn1`（或 `epub://OEBPS/#fn1`），
 * 此处识别出“只指向章节目录、没有具体文件”的形态并还原为纯锚点。
 */
export function normalizeAnchorHref(href: string): string {
  const hashIndex = href.indexOf('#');
  if (hashIndex < 0) return href;

  const beforeHash = href.slice(0, hashIndex);
  if (beforeHash === '') return href;

  let stripped: string | null = null;
  if (beforeHash.startsWith(RESOURCE_PLACEHOLDER_PREFIX)) {
    stripped = beforeHash.slice(RESOURCE_PLACEHOLDER_PREFIX.length);
  } else if (beforeHash.startsWith('epub://')) {
    stripped = beforeHash.slice('epub://'.length);
  }
  if (stripped === null) return href;

  // 路径部分为空或以 / 结尾，说明只指向章节目录本身 → 章内锚点
  if (stripped === '' || stripped.endsWith('/')) {
    return href.slice(hashIndex);
  }
  return href;
}

/**
 * EPUB 导航 Hook
 * 提供链接点击处理、锚点跳转等功能
 */
export function useEpubNavigation(context: NavigationContext): EpubNavigationHook {
  const { goToPage } = context;

  /**
   * 滚动到锚点
   * 纵向模式按容器纵向偏移滚动；横向模式按内联方向对齐到目标列
   */
  const scrollToAnchor = (anchor: string, currentSectionIndex: number): boolean => {
    const root = context.getSectionRoot(currentSectionIndex);
    if (!root) return false;

    const target =
      root.getElementById(anchor) ||
      (root.querySelector(`[name="${anchor}"]`) as Element | null);
    if (!target) return false;

    const scrollContainer = context.getScrollContainer();
    if (!scrollContainer) return false;

    if (context.getScrollAxis() === 'x') {
      // 横向翻页：交给浏览器按内联方向对齐，避免跨列定位错位
      try {
        target.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' });
      } catch {
        target.scrollIntoView();
      }
      return true;
    }

    // 纵向连续阅读：计算目标相对滚动容器的偏移
    const containerRect = scrollContainer.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const targetTop = targetRect.top - containerRect.top + scrollContainer.scrollTop;

    scrollContainer.scrollTo({ top: targetTop, behavior: 'smooth' });
    return true;
  };

  /**
   * 目标章节渲染存在延迟时重试定位锚点
   */
  const scrollToAnchorWithRetry = (anchor: string, sectionIndex: number): void => {
    let attempt = 0;
    const tryScroll = () => {
      if (scrollToAnchor(anchor, sectionIndex)) return;
      attempt += 1;
      if (attempt < ANCHOR_MAX_RETRY) {
        setTimeout(tryScroll, ANCHOR_RETRY_DELAY_MS);
      }
    };
    setTimeout(tryScroll, ANCHOR_RETRY_DELAY_MS);
  };

  /**
   * 导航到指定 href（跨章节 + 章内锚点）
   */
  const navigateToHref = (href: string): void => {
    const sectionCount = context.sectionCount || 0;
    if (sectionCount <= 0) return;

    const hashIndex = href.indexOf('#');
    const anchor = hashIndex >= 0 ? href.slice(hashIndex + 1) : '';
    const sectionIndex = getSpineIndexForHref(href, context.spine);

    if (sectionIndex >= 0 && sectionIndex < sectionCount) {
      goToPage(sectionIndex + 1).then(() => {
        if (anchor) {
          scrollToAnchorWithRetry(anchor, sectionIndex);
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
      const rawHref = link.getAttribute('href');
      if (!rawHref) return;

      // 兼容旧缓存：还原被写坏的章内锚点
      const href = normalizeAnchorHref(rawHref);

      link.addEventListener('click', (e) => {
        e.preventDefault();

        // 处理章内锚点链接（# 开头）
        if (href.startsWith('#')) {
          scrollToAnchor(href.substring(1), sectionIndex);
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
    scrollToAnchorWithRetry,
    navigateToHref,
  };
}

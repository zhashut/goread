import { findFirstVisibleTextRange } from '../../../../utils/ttsDOM';
import type { PageRange } from './useTxtRendererCore';
import type { TxtBookMeta } from '../txtCacheService';

export interface TxtTTSContext {
  getIsReady: () => boolean;
  getContent: () => string;
  getPages: () => PageRange[];
  getIsVerticalMode: () => boolean;
  getContainer: () => HTMLElement | null;
  getCurrentPage: () => number;
  setCurrentPage: (page: number) => void;
  getVerticalPageTops: () => number[];

  getUseChapterMode: () => boolean;
  getBookMeta: () => TxtBookMeta | null;
  getCurrentChapterIndex: () => number;

  goToPage: (page: number) => Promise<void>;
  goToChapter: (chapterIndex: number) => Promise<void>;
  appendNextChapter: () => Promise<boolean>;
}

export interface TxtTTSHook {
  getTTSDocument: () =>
    | { type: 'dom'; doc: Document | Element }
    | { type: 'text'; text: string }
    | null;
  getVisibleStartForTTS: () => { type: 'range'; range: Range } | null;
  advanceForTTS: () => Promise<boolean>;
}

export function useTxtTTS(context: TxtTTSContext): TxtTTSHook {
  let pinnedWrapperIndex: number | null = null;
  let pendingWrapperIndex: number | null = null;

  const clearPinnedWrapper = (): void => {
    pinnedWrapperIndex = null;
    pendingWrapperIndex = null;
  };

  const clampIndex = (index: number, total: number): number => {
    if (total <= 1) return 0;
    if (index < 0) return 0;
    if (index >= total) return total - 1;
    return index;
  };

  const getVisibleWrapperIndexByScrollTop = (
    scrollTop: number,
    wrappers: NodeListOf<HTMLElement>,
  ): number => {
    const total = wrappers.length;
    if (total <= 1) return 0;

    const adjustedScrollTop = scrollTop + 1;
    const tops = context.getVerticalPageTops();
    if (tops.length === total) {
      let lo = 0;
      let hi = total - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const top = tops[mid] ?? 0;
        if (top <= adjustedScrollTop) {
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      return Math.max(0, Math.min(total - 1, hi));
    }

    let best = 0;
    for (let i = 0; i < total; i++) {
      const top = wrappers[i]?.offsetTop ?? 0;
      if (top <= adjustedScrollTop) best = i;
      else break;
    }
    return best;
  };

  const getTTSDocument = ():
    | { type: 'dom'; doc: Document | Element }
    | { type: 'text'; text: string }
    | null => {
    const isReady = context.getIsReady();
    const content = context.getContent();
    if (!isReady || !content) return null;

    const isVerticalMode = context.getIsVerticalMode();
    if (isVerticalMode) {
      const container = context.getContainer();
      if (!container) return null;

      const wrappers = container.querySelectorAll(
        '[data-page-index]',
      ) as NodeListOf<HTMLElement>;
      if (wrappers.length === 0) return null;

      let index: number;
      if (pendingWrapperIndex !== null) {
        index = clampIndex(pendingWrapperIndex, wrappers.length);
        pinnedWrapperIndex = index;
        pendingWrapperIndex = null;
      } else if (pinnedWrapperIndex !== null) {
        index = clampIndex(pinnedWrapperIndex, wrappers.length);
        pinnedWrapperIndex = index;
      } else {
        index = getVisibleWrapperIndexByScrollTop(container.scrollTop, wrappers);
      }

      let wrapper = wrappers[index];
      if (!wrapper || !wrapper.textContent?.trim()) {
        clearPinnedWrapper();
        index = getVisibleWrapperIndexByScrollTop(container.scrollTop, wrappers);
        wrapper = wrappers[index];
      }
      if (!wrapper) return null;
      if (!wrapper.textContent?.trim()) return null;
      return { type: 'dom', doc: wrapper };
    }

    if (!isVerticalMode) {
      clearPinnedWrapper();
      const pageIndex = context.getCurrentPage() - 1;
      const pages = context.getPages();
      if (pageIndex < 0 || pageIndex >= pages.length) return null;
      const pageInfo = pages[pageIndex];
      const text = content.slice(pageInfo.startOffset, pageInfo.endOffset);
      return text.trim() ? { type: 'text', text } : null;
    }

    return null;
  };

  const getVisibleStartForTTS = (): { type: 'range'; range: Range } | null => {
    const container = context.getContainer();
    if (!container) return null;

    if (!context.getIsVerticalMode()) {
      clearPinnedWrapper();
      return null;
    }

    const wrappers = container.querySelectorAll(
      '[data-page-index]',
    ) as NodeListOf<HTMLElement>;
    if (wrappers.length === 0) return null;

    const index = getVisibleWrapperIndexByScrollTop(container.scrollTop, wrappers);
    pinnedWrapperIndex = clampIndex(index, wrappers.length);
    pendingWrapperIndex = null;
    const wrapper = wrappers[index];
    if (!wrapper) return null;
    const range = findFirstVisibleTextRange(wrapper, container);
    return range ? { type: 'range', range } : null;
  };

  const advanceForTTS = async (): Promise<boolean> => {
    if (!context.getIsReady()) return false;

    if (!context.getIsVerticalMode()) {
      clearPinnedWrapper();
      const nextPage = context.getCurrentPage() + 1;
      const pages = context.getPages();
      if (nextPage > pages.length) {
        if (context.getUseChapterMode()) {
          const bookMeta = context.getBookMeta();
          if (bookMeta) {
            const nextChapter = context.getCurrentChapterIndex() + 1;
            if (nextChapter < bookMeta.chapters.length) {
              await context.goToChapter(nextChapter);
              return true;
            }
          }
        }
        return false;
      }
      await context.goToPage(nextPage);
      return true;
    }

    const container = context.getContainer();
    if (!container) return false;

    const wrappers = container.querySelectorAll(
      '[data-page-index]',
    ) as NodeListOf<HTMLElement>;
    if (wrappers.length === 0) return false;

    const currentIndex =
      pinnedWrapperIndex !== null
        ? clampIndex(pinnedWrapperIndex, wrappers.length)
        : getVisibleWrapperIndexByScrollTop(container.scrollTop, wrappers);
    const nextIndex = currentIndex + 1;

    if (nextIndex < wrappers.length) {
      const tops = context.getVerticalPageTops();
      const top = tops[nextIndex] ?? wrappers[nextIndex]?.offsetTop ?? 0;
      container.scrollTop = top;
      context.setCurrentPage(nextIndex + 1);
      pinnedWrapperIndex = nextIndex;
      pendingWrapperIndex = nextIndex;
      return true;
    }

    if (context.getUseChapterMode()) {
      const appended = await context.appendNextChapter();
      if (!appended) return false;

      const newWrappers = container.querySelectorAll(
        '[data-page-index]',
      ) as NodeListOf<HTMLElement>;
      if (nextIndex < newWrappers.length) {
        const tops = context.getVerticalPageTops();
        const top = tops[nextIndex] ?? newWrappers[nextIndex]?.offsetTop ?? 0;
        container.scrollTop = top;
        context.setCurrentPage(nextIndex + 1);
        pinnedWrapperIndex = nextIndex;
        pendingWrapperIndex = nextIndex;
        return true;
      }
    }

    return false;
  };

  return {
    getTTSDocument,
    getVisibleStartForTTS,
    advanceForTTS,
  };
}


import { log } from '../../../index';
import { findFirstVisibleTextRange } from '../../../../utils/ttsDOM';

export interface EpubTTSContext {
  getReadingMode: () => 'horizontal' | 'vertical';
  getContainer: () => HTMLElement | null;
  getHasVerticalHook: () => boolean;
  getVerticalRenderState: () => {
    sectionContainers: Map<number, HTMLElement>;
    renderedSections: Set<number>;
    currentPage: number;
  } | null;
  getCurrentPage: () => number;
  getPageCount: () => number;
  nextPage: () => Promise<void>;
}

export interface EpubTTSHook {
  advanceForTTS: () => Promise<boolean>;
  getVisibleStartForTTS: () => { type: 'range'; range: Range } | null;
  getTTSDocument: () => { type: 'dom'; doc: Document | Element } | null;
}

export function useEpubTTS(context: EpubTTSContext): EpubTTSHook {
  const getTTSDocument = (): { type: 'dom'; doc: Document | Element } | null => {
    const mode = context.getReadingMode();
    const container = context.getContainer();
    const hasVerticalHook = context.getHasVerticalHook();
    log(`[TTS] getTTSDocument: mode=${mode}, hasContainer=${!!container}, hasVerticalHook=${hasVerticalHook}`, 'info');

    if (mode === 'horizontal') {
      const currentContainer = container;
      if (!currentContainer) {
        log('[TTS] getTTSDocument(horizontal): container 为空', 'warn');
        return null;
      }
      const shadow = currentContainer.shadowRoot;
      if (!shadow) {
        log('[TTS] getTTSDocument(horizontal): shadowRoot 为空', 'warn');
        return null;
      }
      const content = shadow.querySelector('.epub-section-content');
      log(`[TTS] getTTSDocument(horizontal): content=${!!content}, textLen=${content?.textContent?.length ?? 0}`, 'info');
      return content ? { type: 'dom', doc: content } : null;
    }

    if (mode === 'vertical' && hasVerticalHook) {
      const verticalState = context.getVerticalRenderState();
      const sectionContainers = verticalState?.sectionContainers;
      const renderedSections = verticalState?.renderedSections;
      const currentPage = verticalState?.currentPage ?? 1;
      const currentIndex = currentPage - 1;

      log(`[TTS] getTTSDocument(vertical): currentPage=${currentPage}, containers=${sectionContainers?.size ?? 0}, rendered=${renderedSections?.size ?? 0}`, 'info');

      if (!sectionContainers || !renderedSections) return null;

      const primaryWrapper = sectionContainers.get(currentIndex);
      if (primaryWrapper) {
        const shadow = primaryWrapper.shadowRoot;
        if (shadow) {
          const content = shadow.querySelector('.epub-section-content');
          if (content && content.textContent?.trim()) {
            log(`[TTS] getTTSDocument(vertical): 通过 currentPage=${currentPage} 定位成功, textLen=${content.textContent.length}`, 'info');
            return { type: 'dom', doc: content };
          }
        }
        log(`[TTS] getTTSDocument(vertical): currentPage=${currentPage} wrapper 存在但 shadow/content 无效 (shadowRoot=${!!shadow})`, 'warn');
      }

      const currentContainer = container;
      if (currentContainer) {
        const scrollTop = currentContainer.scrollTop;
        const viewportHeight = currentContainer.clientHeight;
        const viewportCenter = scrollTop + viewportHeight / 2;

        for (const idx of renderedSections) {
          const wrapper = sectionContainers.get(idx);
          if (!wrapper) continue;
          const top = wrapper.offsetTop;
          const bottom = top + wrapper.offsetHeight;
          if (viewportCenter >= top && viewportCenter < bottom) {
            const shadow = wrapper.shadowRoot;
            if (!shadow) continue;
            const content = shadow.querySelector('.epub-section-content');
            if (content && content.textContent?.trim()) {
              log(`[TTS] getTTSDocument(vertical): 滚动位置匹配到 section=${idx + 1}, textLen=${content.textContent.length}`, 'info');
              return { type: 'dom', doc: content };
            }
          }
        }
        log(`[TTS] getTTSDocument(vertical): 滚动位置匹配失败, scrollTop=${scrollTop}, viewportH=${viewportHeight}`, 'warn');
      }

      for (const idx of renderedSections) {
        const wrapper = sectionContainers.get(idx);
        if (!wrapper) continue;
        const shadow = wrapper.shadowRoot;
        if (!shadow) continue;
        const content = shadow.querySelector('.epub-section-content');
        if (content && content.textContent?.trim()) {
          log(`[TTS] getTTSDocument(vertical): 兜底使用已渲染 section=${idx + 1}`, 'warn');
          return { type: 'dom', doc: content };
        }
      }

      log('[TTS] getTTSDocument(vertical): 所有策略均失败', 'error');
    }

    return null;
  };

  const getVisibleStartForTTS = (): { type: 'range'; range: Range } | null => {
    const mode = context.getReadingMode();
    const container = context.getContainer();
    if (!container) return null;

    if (mode === 'horizontal') {
      const ttsDoc = getTTSDocument();
      if (!ttsDoc) return null;

      const content = ttsDoc.doc;
      // 横向模式使用 X 轴判断可见性
      const range = findFirstVisibleTextRange(content as Element, container, 'horizontal');
      if (range) {
        log('[TTS] getVisibleStartForTTS(epub-horizontal): 定位到可见文本位置', 'info');
        return { type: 'range', range };
      }
      return null;
    }

    if (mode === 'vertical') {
      const ttsDoc = getTTSDocument();
      if (!ttsDoc) return null;

      const content = ttsDoc.doc;
      const range = findFirstVisibleTextRange(content as Element, container);
      if (range) {
        log('[TTS] getVisibleStartForTTS(epub-vertical): 定位到可见文本位置', 'info');
        return { type: 'range', range };
      }
    }

    return null;
  };

  const advanceForTTS = async (): Promise<boolean> => {
    const currentPage = context.getCurrentPage();
    const totalPages = context.getPageCount();
    if (currentPage >= totalPages) return false;

    await context.nextPage();

    await new Promise(resolve => setTimeout(resolve, 300));

    const newPage = context.getCurrentPage();
    return newPage > currentPage;
  };

  return {
    advanceForTTS,
    getVisibleStartForTTS,
    getTTSDocument,
  };
}

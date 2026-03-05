import { findFirstVisibleTextRange } from '../../../../utils/ttsDOM';

export interface MobiTTSContext {
  getShadowRoot: () => ShadowRoot | null;
  getScrollContainer: () => HTMLElement | null;
}

export interface MobiTTSHook {
  getTTSDocument: () => { type: 'dom'; doc: Document | Element } | null;
  getVisibleStartForTTS: () => { type: 'range'; range: Range } | null;
  advanceForTTS: () => Promise<boolean>;
}

export function useMobiTTS(context: MobiTTSContext): MobiTTSHook {
  const getTTSDocument = (): { type: 'dom'; doc: Document | Element } | null => {
    const shadowRoot = context.getShadowRoot();
    if (!shadowRoot) return null;

    const scrollContainer = context.getScrollContainer();
    const sections = shadowRoot.querySelectorAll('.mobi-section');
    if (!sections.length) return null;

    if (scrollContainer) {
      const scrollTop = scrollContainer.scrollTop;
      const viewportHeight = scrollContainer.clientHeight;
      const viewportCenter = scrollTop + viewportHeight / 2;

      for (const section of sections) {
        const el = section as HTMLElement;
        const top = el.offsetTop;
        const bottom = top + el.offsetHeight;
        if (viewportCenter >= top && viewportCenter < bottom) {
          return { type: 'dom', doc: el };
        }
      }
    }

    return { type: 'dom', doc: sections[0] };
  };

  const getVisibleStartForTTS = (): { type: 'range'; range: Range } | null => {
    const scrollContainer = context.getScrollContainer();
    if (!scrollContainer) return null;

    const ttsDoc = getTTSDocument();
    if (!ttsDoc) return null;

    const range = findFirstVisibleTextRange(ttsDoc.doc as Element, scrollContainer);
    return range ? { type: 'range', range } : null;
  };

  const advanceForTTS = async (): Promise<boolean> => {
    const shadowRoot = context.getShadowRoot();
    const scrollContainer = context.getScrollContainer();
    if (!shadowRoot || !scrollContainer) return false;

    const sections = shadowRoot.querySelectorAll('.mobi-section');
    if (!sections.length) return false;

    const scrollTop = scrollContainer.scrollTop;
    const viewportHeight = scrollContainer.clientHeight;
    const viewportCenter = scrollTop + viewportHeight / 2;

    let currentIdx = -1;
    for (let i = 0; i < sections.length; i++) {
      const el = sections[i] as HTMLElement;
      const top = el.offsetTop;
      const bottom = top + el.offsetHeight;
      if (viewportCenter >= top && viewportCenter < bottom) {
        currentIdx = i;
        break;
      }
    }

    const nextIdx = currentIdx + 1;
    if (nextIdx >= sections.length) return false;

    const nextEl = sections[nextIdx] as HTMLElement;
    nextEl.scrollIntoView({ behavior: 'smooth', block: 'start' });

    await new Promise(resolve => setTimeout(resolve, 400));
    return true;
  };

  return {
    getTTSDocument,
    getVisibleStartForTTS,
    advanceForTTS,
  };
}

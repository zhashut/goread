export class HighlightManager {
  #highlightStyleInjected = false;
  #highlightStyleEl: HTMLStyleElement | null = null;
  #highlightStyleRoot: ShadowRoot | Document | null = null;

  apply(range: Range): void {
    try {
      if (typeof CSS !== 'undefined' && 'highlights' in CSS) {
        const hl = new (globalThis as any).Highlight(range);
        (CSS as any).highlights.set('tts-reading', hl);
        this.#injectHighlightStyle(range);
        return;
      }
    } catch {
      // ignore
    }

    try {
      const node = range.startContainer;
      const root = node.getRootNode?.() as ShadowRoot | Document;
      const sel = root instanceof ShadowRoot ? (root as any).getSelection?.() : window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
    } catch {
      // ignore
    }
  }

  clear(): void {
    try {
      if (typeof CSS !== 'undefined' && 'highlights' in CSS) {
        (CSS as any).highlights.delete('tts-reading');
      }
    } catch {
      // ignore
    }

    try {
      window.getSelection()?.removeAllRanges();
    } catch {
      // ignore
    }
  }

  resetStyle(): void {
    this.clear();
    try {
      this.#highlightStyleEl?.parentNode?.removeChild(this.#highlightStyleEl);
    } catch {
      // ignore
    }
    this.#highlightStyleEl = null;
    this.#highlightStyleInjected = false;
    this.#highlightStyleRoot = null;
  }

  maybeScrollIntoView(range: Range): void {
    try {
      const rect = range.getBoundingClientRect();
      if (!rect || rect.height === 0) return;

      const viewportHeight = window.innerHeight;
      const margin = viewportHeight * 0.15;

      if (rect.bottom > viewportHeight - margin) {
        const scrollAmount = rect.bottom - viewportHeight + margin;
        this.#getScrollContainer(range)?.scrollBy({ top: scrollAmount, behavior: 'smooth' });
      } else if (rect.top < margin) {
        const scrollAmount = rect.top - margin;
        this.#getScrollContainer(range)?.scrollBy({ top: scrollAmount, behavior: 'smooth' });
      }
    } catch {
      // ignore
    }
  }

  #injectHighlightStyle(range: Range): void {
    try {
      const node = range.startContainer;
      const ownerDoc = node.ownerDocument;
      if (!ownerDoc) return;

      const root = node.getRootNode?.() as ShadowRoot | Document;
      const styleRoot: ShadowRoot | Document = root instanceof ShadowRoot ? root : ownerDoc;

      if (
        this.#highlightStyleInjected &&
        this.#highlightStyleEl &&
        this.#highlightStyleEl.isConnected &&
        this.#highlightStyleRoot === styleRoot
      ) {
        return;
      }

      try {
        this.#highlightStyleEl?.parentNode?.removeChild(this.#highlightStyleEl);
      } catch {
        // ignore
      }
      this.#highlightStyleEl = null;
      this.#highlightStyleInjected = false;
      this.#highlightStyleRoot = null;

      const style = ownerDoc.createElement('style');
      style.textContent =
        '::highlight(tts-reading) { background-color: rgba(255, 200, 0, 0.35); border-radius: 2px; }';

      if (styleRoot instanceof ShadowRoot) {
        styleRoot.appendChild(style);
      } else if (ownerDoc.head) {
        ownerDoc.head.appendChild(style);
      }
      this.#highlightStyleEl = style;
      this.#highlightStyleInjected = true;
      this.#highlightStyleRoot = styleRoot;
    } catch {
      // ignore
    }
  }

  #getScrollContainer(range: Range): Element | null {
    try {
      const node = range.startContainer;
      let el = node instanceof Element ? node : node.parentElement;
      while (el) {
        const style = window.getComputedStyle(el);
        const overflowY = style.overflowY;
        if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight) {
          return el;
        }
        const root = el.getRootNode();
        if (root instanceof ShadowRoot) {
          el = root.host as HTMLElement;
          continue;
        }
        el = el.parentElement;
      }
    } catch {
      // ignore
    }
    return document.scrollingElement || document.documentElement;
  }
}


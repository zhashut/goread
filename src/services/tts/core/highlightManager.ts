export class HighlightManager {
  #highlightStyleInjected = false;
  #highlightStyleEl: HTMLStyleElement | null = null;
  #highlightStyleRoot: ShadowRoot | Document | null = null;
  #overlayRoot: HTMLDivElement | null = null;
  #overlayHost: HTMLElement | null = null;
  #overlayHostPrevPosition: string | null = null;
  #overlayRects: HTMLDivElement[] = [];

  apply(range: Range): void {
    try {
      if (typeof CSS !== 'undefined' && 'highlights' in CSS) {
        const hl = new (globalThis as any).Highlight(range);
        (CSS as any).highlights.set('tts-reading', hl);
        this.#injectHighlightStyle(range);
        this.#clearOverlay();
        return;
      }
    } catch {
      // ignore
    }

    try {
      if (this.#applyOverlay(range)) {
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

    this.#clearOverlay();

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

  #applyOverlay(range: Range): boolean {
    const host = this.#getScrollContainer(range);
    const hostEl = (host instanceof HTMLElement ? host : null) ?? range.startContainer.ownerDocument?.documentElement ?? null;
    const doc = range.startContainer.ownerDocument;
    if (!doc || !hostEl) return false;

    this.#ensureOverlay(hostEl, doc);
    if (!this.#overlayRoot) return false;

    let rects: DOMRect[] = [];
    try {
      rects = Array.from(range.getClientRects());
    } catch {
      rects = [];
    }

    const hostRect = hostEl.getBoundingClientRect();
    const scrollLeft = hostEl.scrollLeft || 0;
    const scrollTop = hostEl.scrollTop || 0;

    const filtered: DOMRect[] = [];
    for (const r of rects) {
      if (!r || r.width <= 0 || r.height <= 0) continue;
      filtered.push(r);
      if (filtered.length >= 64) break;
    }

    this.#overlayRoot.style.width = `${Math.max(hostEl.scrollWidth, hostEl.clientWidth)}px`;
    this.#overlayRoot.style.height = `${Math.max(hostEl.scrollHeight, hostEl.clientHeight)}px`;

    while (this.#overlayRects.length < filtered.length) {
      const d = doc.createElement('div');
      d.style.position = 'absolute';
      d.style.backgroundColor = 'rgba(255, 200, 0, 0.35)';
      d.style.borderRadius = '2px';
      this.#overlayRoot.appendChild(d);
      this.#overlayRects.push(d);
    }
    while (this.#overlayRects.length > filtered.length) {
      const d = this.#overlayRects.pop();
      try {
        d?.parentNode?.removeChild(d);
      } catch {
        // ignore
      }
    }

    for (let i = 0; i < filtered.length; i++) {
      const r = filtered[i];
      const d = this.#overlayRects[i];
      const left = r.left - hostRect.left + scrollLeft;
      const top = r.top - hostRect.top + scrollTop;
      d.style.left = `${left}px`;
      d.style.top = `${top}px`;
      d.style.width = `${r.width}px`;
      d.style.height = `${r.height}px`;
    }

    return filtered.length > 0;
  }

  #ensureOverlay(hostEl: HTMLElement, doc: Document): void {
    if (this.#overlayRoot && this.#overlayHost === hostEl && this.#overlayRoot.isConnected) return;

    this.#clearOverlay();

    const hostPosition = window.getComputedStyle(hostEl).position;
    if (hostPosition === 'static') {
      this.#overlayHostPrevPosition = hostEl.style.position || '';
      hostEl.style.position = 'relative';
    }

    const root = doc.createElement('div');
    root.style.position = 'absolute';
    root.style.left = '0';
    root.style.top = '0';
    root.style.pointerEvents = 'none';
    root.style.zIndex = '2';
    root.style.width = `${Math.max(hostEl.scrollWidth, hostEl.clientWidth)}px`;
    root.style.height = `${Math.max(hostEl.scrollHeight, hostEl.clientHeight)}px`;

    hostEl.appendChild(root);
    this.#overlayRoot = root;
    this.#overlayHost = hostEl;
  }

  #clearOverlay(): void {
    this.#overlayRects = [];
    try {
      this.#overlayRoot?.parentNode?.removeChild(this.#overlayRoot);
    } catch {
      // ignore
    }
    this.#overlayRoot = null;

    if (this.#overlayHost && this.#overlayHostPrevPosition != null) {
      try {
        this.#overlayHost.style.position = this.#overlayHostPrevPosition;
      } catch {
        // ignore
      }
    }
    this.#overlayHost = null;
    this.#overlayHostPrevPosition = null;
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


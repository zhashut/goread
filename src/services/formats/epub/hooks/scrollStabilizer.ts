export function stabilizeScrollTop(params: {
  container: HTMLElement;
  getTargetScrollTop: () => number;
  observeElements: Element[];
  imageRoot: ParentNode | null;
  durationMs?: number;
}): Promise<void> {
  const { container, getTargetScrollTop, observeElements, imageRoot } = params;
  const durationMs = typeof params.durationMs === 'number' ? params.durationMs : 550;

  const applyOnce = () => {
    if (!container.isConnected) return;
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    let target = getTargetScrollTop();
    if (!isFinite(target)) return;
    if (target < 0) target = 0;
    if (target > maxScrollTop) target = maxScrollTop;
    container.scrollTop = target;
  };

  return new Promise((resolve) => {
    const start = performance.now();
    let finished = false;

    const imageTargets: HTMLImageElement[] = [];
    if (imageRoot && (imageRoot as any).querySelectorAll) {
      try {
        imageTargets.push(...Array.from((imageRoot as ParentNode).querySelectorAll('img')));
      } catch { }
    }

    const onImage = () => {
      if (finished) return;
      applyOnce();
    };

    for (const img of imageTargets) {
      try {
        img.addEventListener('load', onImage);
        img.addEventListener('error', onImage);
      } catch { }
    }

    let ro: ResizeObserver | null = null;
    try {
      ro = new ResizeObserver(() => {
        if (finished) return;
        applyOnce();
      });
      for (const el of observeElements) {
        try {
          ro.observe(el);
        } catch { }
      }
    } catch {
      ro = null;
    }

    const cleanup = () => {
      if (finished) return;
      finished = true;

      if (ro) {
        try {
          ro.disconnect();
        } catch { }
      }

      for (const img of imageTargets) {
        try {
          img.removeEventListener('load', onImage);
          img.removeEventListener('error', onImage);
        } catch { }
      }

      resolve();
    };

    const timerId = window.setTimeout(cleanup, durationMs);

    const fontsReady = (document as any).fonts?.ready;
    if (fontsReady && typeof fontsReady.then === 'function') {
      Promise.resolve(fontsReady)
        .then(() => {
          if (finished) return;
          if (performance.now() - start <= durationMs) {
            applyOnce();
          }
        })
        .catch(() => { });
    }

    requestAnimationFrame(() => {
      if (finished) return;
      applyOnce();
      requestAnimationFrame(() => {
        if (finished) return;
        applyOnce();
        if (performance.now() - start > durationMs) {
          window.clearTimeout(timerId);
          cleanup();
        }
      });
    });
  });
}


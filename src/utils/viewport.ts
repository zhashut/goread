export function applyScalable(): void {
  const m = ensureViewportMeta();
  const content = "width=device-width, initial-scale=1.0, maximum-scale=5, user-scalable=yes, viewport-fit=cover";
  if (m.getAttribute("content") !== content) m.setAttribute("content", content);
}

export function applyNonScalable(): void {
  const m = ensureViewportMeta();
  const content = "width=device-width, initial-scale=1.0, maximum-scale=1, user-scalable=no, viewport-fit=cover";
  if (m.getAttribute("content") !== content) m.setAttribute("content", content);
}

export function resetZoom(): void {
  applyNonScalable();
  setTimeout(() => {
    const m = ensureViewportMeta();
    const content = "width=device-width, initial-scale=1.0, maximum-scale=1, user-scalable=no, viewport-fit=cover";
    if (m.getAttribute("content") !== content) m.setAttribute("content", content);
    try { window.scrollTo(0, 0); } catch {}
  }, 0);
}

function ensureViewportMeta(): HTMLMetaElement {
  let m = document.querySelector('meta[name="viewport"]') as HTMLMetaElement | null;
  if (!m) {
    m = document.createElement("meta");
    m.setAttribute("name", "viewport");
    document.head.appendChild(m);
  }
  return m!;
}


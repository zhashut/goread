/** 禁用浏览器原生缩放，缩放由 JS 手势 + CSS Transform 接管 */
export function applyNonScalable(): void {
  const m = ensureViewportMeta();
  const content = "width=device-width, initial-scale=1.0, maximum-scale=1, user-scalable=no, viewport-fit=cover";
  if (m.getAttribute("content") !== content) m.setAttribute("content", content);
}

/** 重置缩放状态并滚动到顶部 */
export function resetZoom(): void {
  applyNonScalable();
  try { window.scrollTo(0, 0); } catch {}
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

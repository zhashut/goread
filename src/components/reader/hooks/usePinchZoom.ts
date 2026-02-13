import { useRef, useCallback, useEffect } from "react";

const MIN_SCALE = 1;
const MAX_SCALE = 5;
/** 缩放回弹阈值，低于此值自动重置 */
const RESET_THRESHOLD = 1.05;

/** 全局缩放状态标记，供 paginator.js 等外部模块读取 */
declare global {
  var __goread_pinch_zoomed: boolean;
}

/** 手势中间态 */
interface GestureState {
  active: boolean;
  initialDistance: number;
  initialScale: number;
  lastScale: number;
  lastTx: number;
  lastTy: number;
  centerX: number;
  centerY: number;
  pendingScale?: number;
  pendingTx?: number;
  pendingTy?: number;
  panning: boolean;
  panStartX: number;
  panStartY: number;
  panBaseTx: number;
  panBaseTy: number;
}

// ─── 纯函数工具 ───

function touchDistance(t1: Touch, t2: Touch): number {
  const dx = t1.clientX - t2.clientX;
  const dy = t1.clientY - t2.clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

function clampTranslate(tx: number, ty: number, scale: number, rect: DOMRect) {
  if (scale <= 1) return { x: 0, y: 0 };
  const maxTx = rect.width * (scale - 1);
  const maxTy = rect.height * (scale - 1);
  return {
    x: Math.max(-maxTx, Math.min(0, tx)),
    y: Math.max(-maxTy, Math.min(0, ty)),
  };
}

// ─── Hook ───

/**
 * 双指缩放 Hook
 * 在 contentRef 元素上监听原生 touch 事件，通过 CSS transform 缩放内容区域。
 * 所有 touch 监听均为 passive:false，双指时 preventDefault 阻止系统接管手势。
 */
export const usePinchZoom = (
  contentRef: React.RefObject<HTMLElement | null>,
  options?: { onZoomEnd?: (scale: number) => void }
) => {
  const onZoomEndRef = useRef(options?.onZoomEnd);
  onZoomEndRef.current = options?.onZoomEnd;
  const gestureRef = useRef<GestureState>({
    active: false,
    initialDistance: 0,
    initialScale: 1,
    lastScale: 1,
    lastTx: 0,
    lastTy: 0,
    centerX: 0,
    centerY: 0,
    panning: false,
    panStartX: 0,
    panStartY: 0,
    panBaseTx: 0,
    panBaseTy: 0,
  });

  const applyTransform = useCallback(
    (scale: number, tx: number, ty: number) => {
      const el = contentRef.current;
      if (!el) return;
      if (scale <= 1) {
        el.style.transform = "";
        el.style.transformOrigin = "";
      } else {
        el.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
        el.style.transformOrigin = "0 0";
      }
    },
    [contentRef]
  );

  const resetZoom = useCallback(() => {
    const g = gestureRef.current;
    g.lastScale = 1;
    g.lastTx = 0;
    g.lastTy = 0;
    applyTransform(1, 0, 0);
    globalThis.__goread_pinch_zoomed = false;
    if (contentRef.current) contentRef.current.style.touchAction = "pan-y";
    onZoomEndRef.current?.(1);
  }, [applyTransform, contentRef]);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;

    // 禁止浏览器合成器接管缩放手势，但保留纵向滚动
    el.style.touchAction = "pan-y";

    const onTouchStart = (e: TouchEvent) => {
      const g = gestureRef.current;
      if (e.touches.length === 2) {
        e.preventDefault();
        const [t1, t2] = [e.touches[0], e.touches[1]];
        g.active = true;
        g.panning = false;
        g.initialDistance = touchDistance(t1, t2);
        g.initialScale = g.lastScale;
        g.centerX = (t1.clientX + t2.clientX) / 2;
        g.centerY = (t1.clientY + t2.clientY) / 2;
      } else if (e.touches.length === 1 && g.lastScale > 1) {
        e.preventDefault();
        g.panning = true;
        g.panStartX = e.touches[0].clientX;
        g.panStartY = e.touches[0].clientY;
        g.panBaseTx = g.lastTx;
        g.panBaseTy = g.lastTy;
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      const g = gestureRef.current;
      if (g.active && e.touches.length === 2) {
        e.preventDefault();
        const [t1, t2] = [e.touches[0], e.touches[1]];
        const dist = touchDistance(t1, t2);
        const raw = g.initialScale * (dist / g.initialDistance);
        const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, raw));

        const rect = el.getBoundingClientRect();
        const cx = g.centerX - rect.left;
        const cy = g.centerY - rect.top;
        const ratio = scale / g.initialScale;
        const tx = cx * (1 - ratio) + g.lastTx * ratio;
        const ty = cy * (1 - ratio) + g.lastTy * ratio;

        const clamped = clampTranslate(tx, ty, scale, rect);
        applyTransform(scale, clamped.x, clamped.y);
        g.pendingScale = scale;
        g.pendingTx = clamped.x;
        g.pendingTy = clamped.y;
      } else if (g.panning && e.touches.length === 1 && g.lastScale > 1) {
        e.preventDefault();
        const dx = e.touches[0].clientX - g.panStartX;
        const dy = e.touches[0].clientY - g.panStartY;
        const rect = el.getBoundingClientRect();
        const clamped = clampTranslate(g.panBaseTx + dx, g.panBaseTy + dy, g.lastScale, rect);
        g.lastTx = clamped.x;
        g.lastTy = clamped.y;
        applyTransform(g.lastScale, clamped.x, clamped.y);
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      const g = gestureRef.current;
      if (g.active) {
        if (g.pendingScale !== undefined) {
          g.lastScale = g.pendingScale;
          g.lastTx = g.pendingTx ?? 0;
          g.lastTy = g.pendingTy ?? 0;
          g.pendingScale = undefined;
          g.pendingTx = undefined;
          g.pendingTy = undefined;
        }
        g.active = false;
        if (g.lastScale <= RESET_THRESHOLD) {
          resetZoom();
        } else {
          globalThis.__goread_pinch_zoomed = true;
          el.style.touchAction = "none";
          onZoomEndRef.current?.(g.lastScale);
        }
      }
      if (e.touches.length === 0) g.panning = false;
    };

    el.addEventListener("touchstart", onTouchStart, { passive: false });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: false });

    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.style.touchAction = "";
      globalThis.__goread_pinch_zoomed = false;
    };
  }, [contentRef, applyTransform, resetZoom]);

  return { resetZoom };
};

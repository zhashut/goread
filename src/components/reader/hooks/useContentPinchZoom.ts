import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type UseContentPinchZoomOptions = {
  enabled: boolean;
  viewportRef: React.RefObject<HTMLElement>;
  getContentElement: () => HTMLElement | null;
  minScale?: number;
  maxScale?: number;
  tapMoveThresholdPx?: number;
};

type PointerPoint = { x: number; y: number };

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

const distance = (a: PointerPoint, b: PointerPoint) => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
};

const midpoint = (a: PointerPoint, b: PointerPoint): PointerPoint => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
});

const getElementContentSize = (el: HTMLElement) => {
  const baseWidth = Math.max(el.scrollWidth || 0, el.offsetWidth || 0, el.clientWidth || 0);
  const baseHeight = Math.max(el.scrollHeight || 0, el.offsetHeight || 0, el.clientHeight || 0);
  return { width: baseWidth, height: baseHeight };
};

const getViewportSize = (viewportEl: HTMLElement) => ({
  width: viewportEl.clientWidth || 0,
  height: viewportEl.clientHeight || 0,
});

const getRelativePoint = (viewportEl: HTMLElement, clientX: number, clientY: number): PointerPoint => {
  const rect = viewportEl.getBoundingClientRect();
  return { x: clientX - rect.left, y: clientY - rect.top };
};

const isElementScrollable = (el: HTMLElement) => {
  const vScrollable = (el.scrollHeight || 0) > (el.clientHeight || 0) + 1;
  const hScrollable = (el.scrollWidth || 0) > (el.clientWidth || 0) + 1;
  return vScrollable || hScrollable;
};

export const useContentPinchZoom = ({
  enabled,
  viewportRef,
  getContentElement,
  minScale = 1,
  maxScale = 4,
  tapMoveThresholdPx = 6,
}: UseContentPinchZoomOptions) => {
  const pointersRef = useRef(new Map<number, PointerPoint>());

  const scaleRef = useRef(1);
  const translateRef = useRef({ x: 0, y: 0 });

  const isGestureActiveRef = useRef(false);
  const isPanActiveRef = useRef(false);
  const gestureMovedRef = useRef(false);
  const lastGestureEndAtRef = useRef(0);
  const hasTransferredScrollRef = useRef(false);

  const pinchStartRef = useRef<{
    scale: number;
    dist: number;
    mid: PointerPoint;
    contentMid: PointerPoint;
  } | null>(null);

  const panStartRef = useRef<{
    x: number;
    y: number;
    tx: number;
    ty: number;
  } | null>(null);

  const rafIdRef = useRef<number | null>(null);
  const [styleVersion, setStyleVersion] = useState(0);

  const updateStyleRaf = useCallback(() => {
    if (rafIdRef.current != null) return;
    rafIdRef.current = window.requestAnimationFrame(() => {
      rafIdRef.current = null;
      setStyleVersion((v) => v + 1);
    });
  }, []);

  const clampTranslate = useCallback(
    (next: { x: number; y: number }, nextScale: number) => {
      const viewportEl = viewportRef.current;
      const contentEl = getContentElement();
      if (!viewportEl || !contentEl) return next;

      const { width: vw, height: vh } = getViewportSize(viewportEl);
      const { width: cw, height: ch } = getElementContentSize(contentEl);

      if (vw <= 0 || vh <= 0 || cw <= 0 || ch <= 0) return next;

      const scaledW = cw * nextScale;
      const scaledH = ch * nextScale;

      const minX = Math.min(0, vw - scaledW);
      const minY = Math.min(0, vh - scaledH);

      return {
        x: clamp(next.x, minX, 0),
        y: clamp(next.y, minY, 0),
      };
    },
    [getContentElement, viewportRef]
  );

  const transferScrollToTranslateIfNeeded = useCallback(
    (nextScale: number) => {
      const contentEl = getContentElement();
      if (!contentEl) return;
      if (hasTransferredScrollRef.current) return;
      if (nextScale <= 1) return;
      if (isElementScrollable(contentEl)) return;

      const scrollTop = contentEl.scrollTop || 0;
      const scrollLeft = contentEl.scrollLeft || 0;
      if (scrollTop === 0 && scrollLeft === 0) {
        hasTransferredScrollRef.current = true;
        return;
      }

      contentEl.scrollTop = 0;
      contentEl.scrollLeft = 0;
      translateRef.current = clampTranslate(
        { x: translateRef.current.x - scrollLeft, y: translateRef.current.y - scrollTop },
        nextScale
      );
      hasTransferredScrollRef.current = true;
      updateStyleRaf();
    },
    [clampTranslate, getContentElement, updateStyleRaf]
  );

  const commitTransform = useCallback(
    (nextScale: number, nextTranslate: { x: number; y: number }) => {
      const s = clamp(nextScale, minScale, maxScale);
      scaleRef.current = s;
      transferScrollToTranslateIfNeeded(s);
      translateRef.current = clampTranslate(nextTranslate, s);
      updateStyleRaf();
    },
    [clampTranslate, maxScale, minScale, transferScrollToTranslateIfNeeded, updateStyleRaf]
  );

  const shouldSuppressClick = useCallback(() => {
    if (isGestureActiveRef.current) return true;
    if (gestureMovedRef.current) return true;
    const dt = Date.now() - lastGestureEndAtRef.current;
    return dt >= 0 && dt < 250;
  }, []);

  const reset = useCallback(() => {
    const contentEl = getContentElement();
    const s = scaleRef.current;
    const t = translateRef.current;

    if (contentEl && hasTransferredScrollRef.current) {
      const maxScrollTop = Math.max(0, (contentEl.scrollHeight || 0) - (contentEl.clientHeight || 0));
      const maxScrollLeft = Math.max(0, (contentEl.scrollWidth || 0) - (contentEl.clientWidth || 0));
      contentEl.scrollTop = clamp(-t.y / Math.max(1, s), 0, maxScrollTop);
      contentEl.scrollLeft = clamp(-t.x / Math.max(1, s), 0, maxScrollLeft);
    }

    scaleRef.current = 1;
    translateRef.current = { x: 0, y: 0 };
    pointersRef.current.clear();
    pinchStartRef.current = null;
    panStartRef.current = null;
    isPanActiveRef.current = false;
    isGestureActiveRef.current = false;
    gestureMovedRef.current = false;
    hasTransferredScrollRef.current = false;
    updateStyleRaf();
  }, [getContentElement, updateStyleRaf]);

  useEffect(() => {
    if (enabled) return;
    reset();
  }, [enabled, reset]);

  useEffect(() => {
    return () => {
      if (rafIdRef.current != null) {
        window.cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, []);

  const bind = useMemo(
    () => ({
      onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
        if (!enabled) return;
        if (e.pointerType !== "touch") return;

        const viewportEl = viewportRef.current;
        if (!viewportEl) return;

        const pt = getRelativePoint(viewportEl, e.clientX, e.clientY);
        pointersRef.current.set(e.pointerId, pt);

        if (pointersRef.current.size === 2) {
          const pts = Array.from(pointersRef.current.values());
          const mid = midpoint(pts[0], pts[1]);
          const s = scaleRef.current;
          const t = translateRef.current;
          const contentMid = { x: (mid.x - t.x) / s, y: (mid.y - t.y) / s };
          pinchStartRef.current = { scale: s, dist: distance(pts[0], pts[1]), mid, contentMid };
          isGestureActiveRef.current = true;
          isPanActiveRef.current = false;
          panStartRef.current = null;
          gestureMovedRef.current = false;
          lastGestureEndAtRef.current = 0;
        } else if (pointersRef.current.size === 1 && scaleRef.current > 1) {
          isGestureActiveRef.current = true;
          isPanActiveRef.current = true;
          gestureMovedRef.current = false;
          lastGestureEndAtRef.current = 0;
          panStartRef.current = {
            x: pt.x,
            y: pt.y,
            tx: translateRef.current.x,
            ty: translateRef.current.y,
          };
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {}
        } else {
          isGestureActiveRef.current = false;
          isPanActiveRef.current = false;
          panStartRef.current = null;
          pinchStartRef.current = null;
          gestureMovedRef.current = false;
          lastGestureEndAtRef.current = 0;
        }
      },
      onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
        if (!enabled) return;
        if (e.pointerType !== "touch") return;
        const viewportEl = viewportRef.current;
        if (!viewportEl) return;

        if (!pointersRef.current.has(e.pointerId)) return;
        const pt = getRelativePoint(viewportEl, e.clientX, e.clientY);
        pointersRef.current.set(e.pointerId, pt);

        const s = scaleRef.current;

        if (pointersRef.current.size >= 2 && pinchStartRef.current) {
          const pts = Array.from(pointersRef.current.values()).slice(0, 2);
          const mid = midpoint(pts[0], pts[1]);
          const distNow = distance(pts[0], pts[1]);
          const start = pinchStartRef.current;

          const nextScaleRaw = (start.scale * distNow) / Math.max(1, start.dist);
          const nextScale = clamp(nextScaleRaw, minScale, maxScale);
          const nextTranslate = {
            x: mid.x - start.contentMid.x * nextScale,
            y: mid.y - start.contentMid.y * nextScale,
          };

          isGestureActiveRef.current = true;
          gestureMovedRef.current = true;
          commitTransform(nextScale, nextTranslate);
          e.preventDefault();
          return;
        }

        if (pointersRef.current.size === 1 && scaleRef.current > 1) {
          const start = panStartRef.current;
          if (!start) return;
          const dx = pt.x - start.x;
          const dy = pt.y - start.y;
          if (Math.abs(dx) > tapMoveThresholdPx || Math.abs(dy) > tapMoveThresholdPx) {
            gestureMovedRef.current = true;
          }

          isGestureActiveRef.current = true;
          isPanActiveRef.current = true;
          commitTransform(s, { x: start.tx + dx, y: start.ty + dy });
          e.preventDefault();
          return;
        }
      },
      onPointerUp: (e: React.PointerEvent<HTMLElement>) => {
        if (e.pointerType !== "touch") return;
        pointersRef.current.delete(e.pointerId);

        if (pointersRef.current.size >= 2) return;

        if (pointersRef.current.size === 1 && scaleRef.current > 1) {
          const remainingPt = Array.from(pointersRef.current.values())[0];
          if (!remainingPt) return;
          isGestureActiveRef.current = true;
          isPanActiveRef.current = true;
          panStartRef.current = {
            x: remainingPt.x,
            y: remainingPt.y,
            tx: translateRef.current.x,
            ty: translateRef.current.y,
          };
          pinchStartRef.current = null;
          return;
        }

        pinchStartRef.current = null;
        panStartRef.current = null;
        isPanActiveRef.current = false;
        isGestureActiveRef.current = false;
        if (gestureMovedRef.current) {
          lastGestureEndAtRef.current = Date.now();
        }
        gestureMovedRef.current = false;
      },
      onPointerCancel: (e: React.PointerEvent<HTMLElement>) => {
        if (e.pointerType !== "touch") return;
        pointersRef.current.clear();
        pinchStartRef.current = null;
        panStartRef.current = null;
        isPanActiveRef.current = false;
        isGestureActiveRef.current = false;
        if (gestureMovedRef.current) {
          lastGestureEndAtRef.current = Date.now();
        }
        gestureMovedRef.current = false;
      },
    }),
    [
      commitTransform,
      enabled,
      maxScale,
      minScale,
      tapMoveThresholdPx,
      viewportRef,
    ]
  );

  const contentStyle = useMemo(() => {
    void styleVersion;
    const s = scaleRef.current;
    const t = translateRef.current;
    const touchAction = s > 1 ? "none" : "pan-y";

    return {
      transformOrigin: "0 0",
      transform: s === 1 && t.x === 0 && t.y === 0 ? "none" : `translate3d(${t.x}px, ${t.y}px, 0) scale(${s})`,
      willChange: s === 1 ? undefined : ("transform" as const),
      touchAction,
    } satisfies React.CSSProperties;
  }, [styleVersion]);

  return {
    bind,
    contentStyle,
    scale: scaleRef.current,
    isZoomed: scaleRef.current > 1,
    isGestureActive: isGestureActiveRef.current,
    shouldSuppressClick,
    reset,
  };
};

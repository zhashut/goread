import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type UseContentPinchZoomOptions = {
  enabled: boolean;
  viewportRef: React.RefObject<HTMLElement>;
  getContentElement: () => HTMLElement | null;
  minScale?: number;
  maxScale?: number;
  tapMoveThresholdPx?: number;
  /**
   * 变换提交后的回调（每次 transform 生效后触发一次）。
   * 缩放平移不会触发原生滚动，因此调用方可借此补充渲染进入可视区域的页面。
   */
  onTransformCommit?: () => void;
};

type PointerPoint = { x: number; y: number };

type LayoutBox = {
  /** 未缩放布局盒相对视口左上角的偏移（已剔除当前 transform 的影响） */
  left: number;
  top: number;
  /** 未缩放布局尺寸 */
  width: number;
  height: number;
};

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** 夹取区间；当 min > max（内容小于视口）时取区间中点，即“居中且不可平移” */
const clampRange = (value: number, min: number, max: number) =>
  min > max ? (min + max) / 2 : clamp(value, min, max);

const distance = (a: PointerPoint, b: PointerPoint) => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
};

const midpoint = (a: PointerPoint, b: PointerPoint): PointerPoint => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
});

const getViewportSize = (viewportEl: HTMLElement) => ({
  width: viewportEl.clientWidth || 0,
  height: viewportEl.clientHeight || 0,
});

const getRelativePoint = (viewportEl: HTMLElement, clientX: number, clientY: number): PointerPoint => {
  const rect = viewportEl.getBoundingClientRect();
  return { x: clientX - rect.left, y: clientY - rect.top };
};

/**
 * 读取元素当前实际绘制的 transform。
 * 直接读取计算样式而不是内部 ref，避免 React 尚未提交样式时测量到旧值。
 */
const readPaintedTransform = (el: HTMLElement) => {
  const value = window.getComputedStyle(el).transform;
  if (!value || value === "none") return { scale: 1, x: 0, y: 0 };
  try {
    const m = new DOMMatrixReadOnly(value);
    const scale = Math.hypot(m.a, m.b) || 1;
    return { scale, x: m.e, y: m.f };
  } catch {
    return { scale: 1, x: 0, y: 0 };
  }
};

/**
 * 计算内容元素“未缩放”的布局盒（相对视口左上角）。
 * 关键：内容元素在纵向模式是 flex 居中的滚动内容、横向模式是 flex 居中的 canvas，
 * 其布局原点并不在视口左上角。平移的可行区间必须基于真实布局盒计算，
 * 否则会出现“内容被拖出视口露出背景”以及“无法上下平移”的问题。
 */
const getLayoutBox = (viewportEl: HTMLElement, contentEl: HTMLElement): LayoutBox | null => {
  const vpRect = viewportEl.getBoundingClientRect();
  const elRect = contentEl.getBoundingClientRect();
  const painted = readPaintedTransform(contentEl);

  const width = elRect.width / painted.scale;
  const height = elRect.height / painted.scale;
  if (!(width > 0) || !(height > 0)) return null;

  return {
    left: elRect.left - vpRect.left - painted.x,
    top: elRect.top - vpRect.top - painted.y,
    width,
    height,
  };
};

/**
 * 找到承载内容元素的实际滚动容器（由内向外最近的、可滚动的祖先）。
 * 纵向模式为滚动列，横向模式为视口自身。
 */
const findScrollContainer = (viewportEl: HTMLElement, contentEl: HTMLElement): HTMLElement => {
  let el: HTMLElement | null = contentEl.parentElement;
  while (el) {
    const hasOverflow =
      el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1;
    if (hasOverflow || el.scrollTop !== 0 || el.scrollLeft !== 0) return el;
    if (el === viewportEl) break;
    el = el.parentElement;
  }
  return viewportEl;
};

export const useContentPinchZoom = ({
  enabled,
  viewportRef,
  getContentElement,
  minScale = 1,
  maxScale = 4,
  tapMoveThresholdPx = 6,
  onTransformCommit,
}: UseContentPinchZoomOptions) => {
  const pointersRef = useRef(new Map<number, PointerPoint>());

  const scaleRef = useRef(1);
  const translateRef = useRef({ x: 0, y: 0 });

  const isGestureActiveRef = useRef(false);
  const isPanActiveRef = useRef(false);
  const gestureMovedRef = useRef(false);
  const lastGestureEndAtRef = useRef(0);

  // 本次缩放会话锁定的内容元素与滚动容器（换模式/换书后可安全还原滚动位置）
  const sessionRef = useRef<{
    contentEl: HTMLElement;
    scroller: HTMLElement;
  } | null>(null);

  const pinchStartRef = useRef<{
    scale: number;
    dist: number;
    mid: PointerPoint;
    /** 捏合中心点对应的内容坐标（未缩放内容坐标系） */
    contentMid: PointerPoint;
    /** 内容元素未缩放布局盒相对视口的偏移（视口坐标系） */
    boxLeft: number;
    boxTop: number;
  } | null>(null);

  const panStartRef = useRef<{
    x: number;
    y: number;
    tx: number;
    ty: number;
  } | null>(null);

  const rafIdRef = useRef<number | null>(null);
  const [styleVersion, setStyleVersion] = useState(0);

  // 回调放入 ref，保证外部无需 memo 化也不会读到旧闭包
  const onTransformCommitRef = useRef(onTransformCommit);
  onTransformCommitRef.current = onTransformCommit;

  const updateStyleRaf = useCallback(() => {
    if (rafIdRef.current != null) return;
    rafIdRef.current = window.requestAnimationFrame(() => {
      rafIdRef.current = null;
      setStyleVersion((v) => v + 1);
    });
  }, []);

  // 样式提交后通知外部（此时 DOM 上的 transform 已更新，测量结果才准确）
  useEffect(() => {
    onTransformCommitRef.current?.();
  }, [styleVersion]);

  /** 缩放期间统一由 transform 表达位置：把原生滚动偏移并入平移，并把滚动归零 */
  const foldScrollIntoTranslate = useCallback(
    (next: PointerPoint) => {
      const viewportEl = viewportRef.current;
      const contentEl = getContentElement();
      if (!viewportEl || !contentEl) return next;

      const cached = sessionRef.current;
      const scroller =
        cached && cached.contentEl === contentEl && cached.scroller.isConnected
          ? cached.scroller
          : findScrollContainer(viewportEl, contentEl);
      const scrollTop = scroller.scrollTop || 0;
      const scrollLeft = scroller.scrollLeft || 0;
      if (scrollTop === 0 && scrollLeft === 0) {
        sessionRef.current = { contentEl, scroller };
        return next;
      }

      scroller.scrollTop = 0;
      scroller.scrollLeft = 0;
      sessionRef.current = { contentEl, scroller };
      return { x: next.x - scrollLeft, y: next.y - scrollTop };
    },
    [getContentElement, viewportRef]
  );

  /** 把当前原生滚动并入平移并立即提交样式（滚动已归零，必须同步补偿，否则会跳变） */
  const foldScrollNow = useCallback(() => {
    const folded = foldScrollIntoTranslate(translateRef.current);
    if (folded.x === translateRef.current.x && folded.y === translateRef.current.y) return;
    translateRef.current = folded;
    updateStyleRaf();
  }, [foldScrollIntoTranslate, updateStyleRaf]);

  /** 缩放回到原始比例时，把平移量还原成原生滚动位置（保证阅读位置不跳变、不残留偏移） */
  const restoreScrollFromTranslate = useCallback(
    (translate: PointerPoint, scale: number) => {
      const session = sessionRef.current;
      if (!session) return;
      const { scroller, contentEl } = session;
      if (!scroller.isConnected || !contentEl.isConnected) return;
      // 内容元素已不再处于缩放状态（例如切换了阅读模式）时无需还原
      const painted = readPaintedTransform(contentEl);
      if (painted.scale === 1 && painted.x === 0 && painted.y === 0 && translate.x === 0 && translate.y === 0) {
        return;
      }

      const s = Math.max(1, scale);
      // 缩放期间滚动容器被 transform 撑大，需按比例换回未缩放的滚动范围
      const maxTop = Math.max(0, (scroller.scrollHeight || 0) / s - (scroller.clientHeight || 0));
      const maxLeft = Math.max(0, (scroller.scrollWidth || 0) / s - (scroller.clientWidth || 0));
      scroller.scrollTop = clamp(-translate.y / s, 0, maxTop);
      scroller.scrollLeft = clamp(-translate.x / s, 0, maxLeft);
    },
    []
  );

  const clampTranslate = useCallback(
    (next: PointerPoint, nextScale: number) => {
      const viewportEl = viewportRef.current;
      const contentEl = getContentElement();
      if (!viewportEl || !contentEl) return next;

      const { width: vw, height: vh } = getViewportSize(viewportEl);
      if (vw <= 0 || vh <= 0) return next;

      const box = getLayoutBox(viewportEl, contentEl);
      if (!box) return next;

      // 约束：内容必须始终覆盖视口，避免拖动后露出阅读器背景（黑屏）
      return {
        x: clampRange(next.x, vw - box.left - box.width * nextScale, -box.left),
        y: clampRange(next.y, vh - box.top - box.height * nextScale, -box.top),
      };
    },
    [getContentElement, viewportRef]
  );

  const commitTransform = useCallback(
    (nextScale: number, nextTranslate: PointerPoint) => {
      const s = clamp(nextScale, minScale, maxScale);

      if (s <= minScale) {
        // 仅在“从放大状态缩回”的那一次把位置交还给原生滚动，避免重复覆盖已还原的滚动位置
        if (scaleRef.current > minScale) {
          restoreScrollFromTranslate(translateRef.current, scaleRef.current);
        }
        scaleRef.current = minScale;
        translateRef.current = { x: 0, y: 0 };
        updateStyleRaf();
        return;
      }

      const folded = foldScrollIntoTranslate(nextTranslate);
      scaleRef.current = s;
      translateRef.current = clampTranslate(folded, s);
      updateStyleRaf();
    },
    [clampTranslate, foldScrollIntoTranslate, maxScale, minScale, restoreScrollFromTranslate, updateStyleRaf]
  );

  /** 内容尺寸变化（例如页面渲染完成）后重新夹取，避免残留越界平移 */
  const reclamp = useCallback(() => {
    if (scaleRef.current <= minScale) return;
    translateRef.current = clampTranslate(translateRef.current, scaleRef.current);
    updateStyleRaf();
  }, [clampTranslate, minScale, updateStyleRaf]);

  const shouldSuppressClick = useCallback(() => {
    if (isGestureActiveRef.current) return true;
    if (gestureMovedRef.current) return true;
    const dt = Date.now() - lastGestureEndAtRef.current;
    return dt >= 0 && dt < 250;
  }, []);

  const reset = useCallback(() => {
    restoreScrollFromTranslate(translateRef.current, scaleRef.current);

    scaleRef.current = 1;
    translateRef.current = { x: 0, y: 0 };
    pointersRef.current.clear();
    pinchStartRef.current = null;
    panStartRef.current = null;
    isPanActiveRef.current = false;
    isGestureActiveRef.current = false;
    gestureMovedRef.current = false;
    sessionRef.current = null;
    updateStyleRaf();
  }, [restoreScrollFromTranslate, updateStyleRaf]);

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
          // 先把原生滚动并入平移，保证捏合锚点在后续计算中保持一致
          foldScrollNow();
          const t = translateRef.current;
          const contentEl = getContentElement();
          const box = contentEl && viewportEl ? getLayoutBox(viewportEl, contentEl) : null;
          const boxLeft = box?.left ?? 0;
          const boxTop = box?.top ?? 0;
          const contentMid = {
            x: (mid.x - boxLeft - t.x) / s,
            y: (mid.y - boxTop - t.y) / s,
          };
          pinchStartRef.current = { scale: s, dist: distance(pts[0], pts[1]), mid, contentMid, boxLeft, boxTop };
          isGestureActiveRef.current = true;
          isPanActiveRef.current = false;
          panStartRef.current = null;
          gestureMovedRef.current = false;
          lastGestureEndAtRef.current = 0;
        } else if (pointersRef.current.size === 1 && scaleRef.current > 1) {
          foldScrollNow();
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
          // 保持捏合中心点下的内容不动（需考虑内容元素的布局偏移）
          const nextTranslate = {
            x: mid.x - start.boxLeft - start.contentMid.x * nextScale,
            y: mid.y - start.boxTop - start.contentMid.y * nextScale,
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
      foldScrollNow,
      getContentElement,
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
    reclamp,
    reset,
  };
};

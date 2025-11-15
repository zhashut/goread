import { useRef, useEffect } from "react";

export type LongPressOptions = {
  delay?: number; // ms, default 1000
};

// 使用 Pointer 事件优先，兼容触摸与鼠标；在桌面端也可通过鼠标长按触发
export const useLongPress = (
  targetRef: React.RefObject<HTMLElement | null>,
  onLongPress: () => void,
  opts: LongPressOptions = {}
) => {
  const delay = typeof opts.delay === "number" ? Math.max(200, opts.delay) : 1000;
  const timerRef = useRef<number | null>(null);
  const movedRef = useRef(false);

  useEffect(() => {
    const el = targetRef.current;
    if (!el) return;

    const clearTimer = () => {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const onPointerDown = (_e: PointerEvent) => {
      movedRef.current = false;
      clearTimer();
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        if (!movedRef.current) onLongPress();
      }, delay);
    };
    const onPointerUp = () => clearTimer();
    const onPointerLeave = () => clearTimer();
    const onPointerCancel = () => clearTimer();
    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerType === "touch") {
        // 简单阈值：移动即取消长按，避免误触
        movedRef.current = true;
      }
    };

    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointerleave", onPointerLeave);
    el.addEventListener("pointercancel", onPointerCancel);
    el.addEventListener("pointermove", onPointerMove);

    return () => {
      clearTimer();
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointerleave", onPointerLeave);
      el.removeEventListener("pointercancel", onPointerCancel);
      el.removeEventListener("pointermove", onPointerMove);
    };
  }, [targetRef, onLongPress, delay]);
};
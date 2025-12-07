import { useRef, useCallback, useState } from "react";
import { useSensors, useSensor, KeyboardSensor, MouseSensor, TouchSensor } from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import {
  SWIPE_EDGE_THRESHOLD,
  SWIPE_MIN_DISTANCE,
  SWIPE_MIN_SLOPE,
  TOUCH_COOLDOWN_MS,
  DRAG_MOUSE_DISTANCE_PX,
  DRAG_TOUCH_DELAY_MS,
  DRAG_TOUCH_TOLERANCE_PX,
  DRAG_STATUS_RELEASE_DELAY_MS,
} from "../constants/interactions";

export const isTouchDevice = () => {
  const ua = navigator.userAgent || "";
  const isMobile = /Android|iPhone|iPad|iPod/i.test(ua);
  const mq = typeof window !== "undefined" && (window.matchMedia?.("(pointer: coarse)")?.matches || false);
  return isMobile || mq;
};

export const useDndSensors = (touch?: boolean, overrides?: { touchDelay?: number; tolerance?: number; mouseDistance?: number }) => {
  const isTouch = typeof touch === "boolean" ? touch : isTouchDevice();
  const touchDelay = overrides?.touchDelay ?? DRAG_TOUCH_DELAY_MS;
  const tolerance = overrides?.tolerance ?? DRAG_TOUCH_TOLERANCE_PX;
  const mouseDistance = overrides?.mouseDistance ?? DRAG_MOUSE_DISTANCE_PX;
  return useSensors(
    useSensor(isTouch ? TouchSensor : MouseSensor, isTouch ? { activationConstraint: { delay: touchDelay, tolerance } } : { activationConstraint: { distance: mouseDistance } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
};

export const useDragGuard = () => {
  const [dragActive, setDragActive] = useState(false);
  const release = useCallback(() => {
    setTimeout(() => setDragActive(false), DRAG_STATUS_RELEASE_DELAY_MS);
  }, []);
  const onDragStart = useCallback(() => setDragActive(true), []);
  const onDragEnd = useCallback(() => release(), [release]);
  const onDragCancel = useCallback(() => release(), [release]);
  const shouldBlockActions = useCallback(() => dragActive, [dragActive]);
  return { dragActive, onDragStart, onDragEnd, onDragCancel, shouldBlockActions };
};

type TabSwipeOptions = {
  onLeft: () => void;
  onRight: () => void;
  isBlocked?: () => boolean;
  getCooldownTs?: () => number;
};

export const useTabSwipe = ({ onLeft, onRight, isBlocked, getCooldownTs }: TabSwipeOptions) => {
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = useCallback((e: React.TouchEvent) => {
    if (isBlocked?.()) return;
    const ts = getCooldownTs?.();
    if (typeof ts === "number" && Date.now() - ts < TOUCH_COOLDOWN_MS) return;
    const t = e.touches[0];
    startRef.current = { x: t.clientX, y: t.clientY };
  }, [isBlocked, getCooldownTs]);
  const onTouchEnd = useCallback((e: React.TouchEvent) => {
    if (!startRef.current || isBlocked?.()) return;
    const startX = startRef.current.x;
    if (startX < SWIPE_EDGE_THRESHOLD || startX > window.innerWidth - SWIPE_EDGE_THRESHOLD) {
      startRef.current = null;
      return;
    }
    const t = e.changedTouches[0];
    const dx = startX - t.clientX;
    const dy = startRef.current.y - t.clientY;
    startRef.current = null;
    if (Math.abs(dx) > SWIPE_MIN_DISTANCE && Math.abs(dx) > Math.abs(dy) * SWIPE_MIN_SLOPE) {
      if (dx > 0) onLeft(); else onRight();
    }
  }, [isBlocked, onLeft, onRight]);
  return { onTouchStart, onTouchEnd };
};

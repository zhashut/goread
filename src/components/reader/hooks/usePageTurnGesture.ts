import { useCallback, useEffect, useRef } from "react";
import { hasActiveSelectionIn } from "../../../utils/selection";
import {
  DRAG_MOUSE_DISTANCE_PX,
  PAGE_TURN_CLICK_SUPPRESS_MS,
  PAGE_TURN_DECIDE_THRESHOLD_PX,
  PAGE_TURN_DISTANCE_RATIO,
  PAGE_TURN_EDGE_IGNORE_PX,
  PAGE_TURN_FLING_VELOCITY,
  PAGE_TURN_SLOPE_FACTOR,
  PAGE_TURN_VELOCITY_WINDOW_MS,
} from "../../../constants/interactions";

/** 翻页方向语义：next=向左滑动（看下一页），prev=向右滑动（看上一页） */
export type PageTurnDirection = "next" | "prev";

/** 单次拖拽手势的跟踪状态（触摸与鼠标拖拽共用同一结构） */
type DragTrack = {
  /** 是否已完成方向判定（true=已判定为横向翻页手势，进入跟手阶段） */
  decided: boolean;
  /** 手势起始 X 坐标（视口坐标） */
  startX: number;
  /** 手势起始 Y 坐标（视口坐标） */
  startY: number;
  /** 采样点列表：松手时按时间窗差分计算瞬时速度 */
  samples: { x: number; t: number }[];
};

/** 手势层配置项 */
type PageTurnGestureOptions = {
  /** 手势宿主元素引用（原生触摸/鼠标监听的挂载点，通常为阅读器主视图） */
  viewportRef: React.RefObject<HTMLElement>;
  /** 是否启用横向翻页手势（纵向滚动模式应传 false，让位原生滚动） */
  enabled: boolean;
  /** 阻塞判定：返回 true 时忽略全部手势（目录/设置浮层打开、进度拖动中、加载中等） */
  isBlocked?: () => boolean;
  /** 文本选区宿主：用于判断是否存在用户选区（选区态手势让位），返回 null 表示无可选文本 */
  getSelectionHost?: () => HTMLElement | null;
  /** 视口宽度来源：settle 位移阈值按视口宽比例计算，缺省用 window.innerWidth */
  getViewportWidth?: () => number;
  /** settle 判定通过时执行的上一页动作（本期复用现有瞬时翻页 API） */
  onTurnPrev: () => void;
  /** settle 判定通过时执行的下一页动作（本期复用现有瞬时翻页 API） */
  onTurnNext: () => void;
  /** 是否启用鼠标拖拽（桌面端）：仅建议在不可选文本的渲染面（如 PDF 画布）开启，避免与文本选择冲突 */
  enableMouseDrag?: boolean;
  /** T31 预留：动画期间防重入锁，锁定时手势忽略 */
  isLocked?: () => boolean;
  /** T31 预留：拖拽开始回调（方向判定完成后触发，参数为当前拖拽语义方向） */
  onDragStart?: (direction: PageTurnDirection) => void;
  /** T31 预留：拖拽跟手回调（实时 deltaX，向左为负），T30 阶段仅记录不消费 */
  onDragMove?: (deltaX: number) => void;
  /** T31 预留：拖拽结束回调（settled=false 表示回弹语义） */
  onDragEnd?: (result: { settled: boolean; direction: PageTurnDirection | null }) => void;
};

/** 手势层对外暴露的能力 */
export type PageTurnGesture = {
  /** 最近一次拖拽手势结束后短时间内为 true：用于抑制随后的 click，防止拖拽被误判为分区点击 */
  shouldSuppressClick: () => boolean;
};

/**
 * 判定触摸/按下目标是否为交互元素：落在链接、按钮、输入框等内容上的手势不应触发翻页
 * @param target 事件目标元素
 * @returns true 表示该目标属于交互元素，手势应忽略
 */
const isInteractiveTarget = (target: EventTarget | null): boolean => {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (
    el.tagName === "A" ||
    el.tagName === "BUTTON" ||
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA"
  ) {
    return true;
  }
  if (el.isContentEditable) return true;
  return !!(el.closest("a") || el.closest("button"));
};

/**
 * 计算采样窗口内的水平瞬时速度
 * @param samples 手势过程中的位置采样点（x 为视口坐标，t 为毫秒时间戳）
 * @returns 速度（px/ms，向左为负）；采样不足或时间窗为空时返回 0
 */
const computeVelocity = (samples: { x: number; t: number }[]): number => {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  // 自后向前找时间窗内的最早采样点：窗口越贴近松手时刻，速度越能反映甩动意图
  let first = samples[0];
  for (let i = samples.length - 1; i >= 0; i--) {
    if (last.t - samples[i].t <= PAGE_TURN_VELOCITY_WINDOW_MS) {
      first = samples[i];
    } else {
      break;
    }
  }
  const dt = last.t - first.t;
  if (dt <= 0) return 0;
  return (last.x - first.x) / dt;
};

/**
 * 统一翻页手势层（横向阅读模式）
 *
 * 职责（对应《翻页功能重设计方案》T30/S1）：
 * 1. 接管完整触摸流（touchstart/move/end/cancel），提供拖拽事件流（delta/速度/方向）；
 * 2. 松手 settle 判定：位移超过视口宽 1/4 或甩动速度超过阈值 → 翻页，否则回弹语义；
 *    本期 settle 通过后调用现有瞬时翻页 API，视觉跟手动画由 T31（slide）承接；
 * 3. 手势消解：多指忽略、文本选择态让位、交互元素忽略、屏幕边缘排除（防系统侧滑冲突）；
 * 4. 拖拽手势结束后的短窗口内抑制 click，防止拖拽松手误触分区点击；
 * 5. 键盘导航：←/PageUp 上一页，→/PageDown/空格 下一页；
 * 6. 鼠标拖拽（可选，桌面端）：仅在不可选文本的渲染面启用。
 *
 * 实现说明：触摸事件必须用原生监听（passive: false）而非 React 合成事件，
 * 因为 React 18 将 touchmove 注册为 passive，合成事件内 preventDefault 无效。
 * @param options 手势层配置项
 * @returns shouldSuppressClick：拖拽后点击抑制判定，供分区点击逻辑消费
 */
export const usePageTurnGesture = (options: PageTurnGestureOptions): PageTurnGesture => {
  // 以 ref 镜像最新配置，避免回调闭包依赖变化导致原生监听反复卸载重挂
  const optionsRef = useRef(options);
  optionsRef.current = options;

  /** 当前进行中的拖拽手势；null 表示无手势 */
  const trackRef = useRef<DragTrack | null>(null);
  /** 点击抑制截止时间戳：拖拽手势结束后短窗口内的 click 会被吞掉 */
  const suppressClickUntilRef = useRef(0);

  /**
   * 点击抑制判定：拖拽手势结束后的短窗口内返回 true
   * @returns true 表示应吞掉本次 click
   */
  const shouldSuppressClick = useCallback(
    () => Date.now() < suppressClickUntilRef.current,
    []
  );

  /**
   * 标记本次手势进入过拖拽态并结束：开启点击抑制窗口
   * @returns void
   */
  const markDragEnded = useCallback(() => {
    suppressClickUntilRef.current = Date.now() + PAGE_TURN_CLICK_SUPPRESS_MS;
  }, []);

  /**
   * 判定手势起点是否应被忽略（阻塞态/防重入锁/交互元素/屏幕边缘/既有文本选区）
   * @param target 事件目标元素
   * @param x 起点横坐标（视口坐标）
   * @returns true 表示该起点不启动翻页手势
   */
  const shouldIgnoreStart = useCallback(
    (target: EventTarget | null, x: number): boolean => {
      const o = optionsRef.current;
      if (o.isBlocked?.()) return true;
      if (o.isLocked?.()) return true;
      if (isInteractiveTarget(target)) return true;
      // 屏幕左右边缘窄条排除：仅让位系统侧滑返回手势（12px），
      // 不再沿用通用 55px 阈值，否则左/右下角拇指落点的翻页滑动会被整体吞掉；
      // 若在窄条外仍被系统手势接管，touchcancel 会走既有回弹收尾路径，不会卡死
      if (x < PAGE_TURN_EDGE_IGNORE_PX || x > window.innerWidth - PAGE_TURN_EDGE_IGNORE_PX) return true;
      // 既有文本选区（用户刚选完字 / 拖拽选区手柄）：手势让位给选区操作
      if (hasActiveSelectionIn(o.getSelectionHost?.() ?? null)) return true;
      return false;
    },
    []
  );

  /**
   * 方向判定：水平位移明显大于纵向位移时判定为横向翻页手势
   * @param dx 水平位移
   * @param dy 纵向位移
   * @returns true 表示判定为横向手势
   */
  const decideHorizontal = (dx: number, dy: number): boolean =>
    Math.abs(dx) >= PAGE_TURN_DECIDE_THRESHOLD_PX &&
    Math.abs(dx) > Math.abs(dy) * PAGE_TURN_SLOPE_FACTOR;

  /**
   * 尝试启动一次拖拽手势跟踪
   * @param x 起点横坐标
   * @param y 起点纵坐标
   * @param target 事件目标元素
   * @returns true 表示手势跟踪已建立
   */
  const startTrack = (x: number, y: number, target: EventTarget | null): boolean => {
    if (shouldIgnoreStart(target, x)) return false;
    trackRef.current = {
      decided: false,
      startX: x,
      startY: y,
      samples: [{ x, t: Date.now() }],
    };
    return true;
  };

  /**
   * 拖拽方向判定与让位检查（decided=false 阶段调用）
   * 返回 false 时分两种情况：死区内保留 track 继续等待；让位（选区/纵向手势）时内部已清理 trackRef
   * @param track 当前手势跟踪状态
   * @param dx 水平位移
   * @param dy 纵向位移
   * @returns true 表示判定成功可继续跟手
   */
  const tryDecide = (track: DragTrack, dx: number, dy: number): boolean => {
    if (
      Math.abs(dx) < PAGE_TURN_DECIDE_THRESHOLD_PX &&
      Math.abs(dy) < PAGE_TURN_DECIDE_THRESHOLD_PX
    ) {
      return false; // 死区内：继续等待，不清理
    }
    const o = optionsRef.current;
    // 长按选字场景：浏览器在本次手势尚未判定方向时可能已进入选字态，放弃手势让位给选区扩展
    if (hasActiveSelectionIn(o.getSelectionHost?.() ?? null)) {
      trackRef.current = null;
      return false;
    }
    if (!decideHorizontal(dx, dy)) {
      trackRef.current = null; // 纵向手势：让位给原生滚动
      return false;
    }
    track.decided = true;
    o.onDragStart?.(dx < 0 ? "next" : "prev");
    return true;
  };

  /**
   * 记录一个跟手采样点并回调拖拽事件（decided=true 阶段调用）
   * @param track 当前手势跟踪状态
   * @param x 当前横坐标
   * @returns void
   */
  const recordSample = (track: DragTrack, x: number): void => {
    track.samples.push({ x, t: Date.now() });
    if (track.samples.length > 32) track.samples.shift();
    optionsRef.current.onDragMove?.(x - track.startX);
  };

  /**
   * 松手 settle 判定：位移超过视口宽 1/4 或甩动速度超阈值 → 翻页；否则回弹语义
   * 本期（T30）翻页动作走现有瞬时翻页 API；回弹语义暂无视觉动作，由 T31 动画层承接
   * @param dx 松手时总水平位移
   * @param track 当前手势跟踪状态
   * @returns void
   */
  const settle = useCallback((dx: number, track: DragTrack): void => {
    const o = optionsRef.current;
    const viewportWidth = o.getViewportWidth?.() || window.innerWidth;
    const velocity = computeVelocity(track.samples);
    const settled =
      Math.abs(dx) > viewportWidth * PAGE_TURN_DISTANCE_RATIO ||
      Math.abs(velocity) > PAGE_TURN_FLING_VELOCITY;
    const direction: PageTurnDirection = dx < 0 ? "next" : "prev";
    if (settled) {
      if (direction === "next") o.onTurnNext();
      else o.onTurnPrev();
    }
    o.onDragEnd?.({ settled, direction: settled ? direction : null });
  }, []);

  /**
   * 结束手势跟踪（touchend / touchcancel / mouseup 共用）
   * @param dx 松手时总水平位移（cancel 场景传 0）
   * @param cancelled 是否为系统中断（touchcancel）
   * @returns void
   */
  const finishTrack = useCallback(
    (dx: number, cancelled: boolean): void => {
      const track = trackRef.current;
      trackRef.current = null;
      // 未进入跟手阶段（普通点击/纵向手势）不做任何处理，click 照常派发给分区点击逻辑
      if (!track || !track.decided) return;
      markDragEnded();
      if (cancelled) {
        optionsRef.current.onDragEnd?.({ settled: false, direction: null });
        return;
      }
      settle(dx, track);
    },
    [markDragEnded, settle]
  );

  // 触摸流 + 鼠标拖拽：原生监听（touchmove 需 passive:false 才能 preventDefault）
  useEffect(() => {
    const viewport = optionsRef.current.viewportRef.current;
    if (!options.enabled || !viewport) return;

    let mouseActive = false;

    /** 触摸开始：单指才建立手势跟踪，多指直接放弃当前手势 */
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        // 已进入跟手阶段时追加手指（如双指缩放前兆）：按回弹语义收尾，避免动画层卡在跟手态
        if (trackRef.current?.decided) {
          trackRef.current = null;
          optionsRef.current.onDragEnd?.({ settled: false, direction: null });
        }
        return;
      }
      const t = e.touches[0];
      startTrack(t.clientX, t.clientY, e.target);
    };

    /** 触摸移动：死区等待 → 方向判定 → 跟手采样（横向手势阻断浏览器默认行为） */
    const onTouchMove = (e: TouchEvent) => {
      const track = trackRef.current;
      if (!track) return;
      if (e.touches.length !== 1) {
        // 跟手阶段追加手指：按回弹语义收尾（同 touchstart 多指分支）
        if (track.decided) {
          trackRef.current = null;
          optionsRef.current.onDragEnd?.({ settled: false, direction: null });
        }
        return;
      }
      const t = e.touches[0];
      const dx = t.clientX - track.startX;
      const dy = t.clientY - track.startY;
      if (!track.decided) {
        // 判定失败：死区内继续等待，或已让位（trackRef 被清理）直接返回
        if (!tryDecide(track, dx, dy)) return;
      }
      // 已判定为横向翻页手势：阻断纵向滚动等浏览器默认行为，交由手势层接管
      e.preventDefault();
      recordSample(track, t.clientX);
    };

    /** 触摸结束：settle 判定翻页或回弹 */
    const onTouchEnd = (e: TouchEvent) => {
      const track = trackRef.current;
      if (!track) return;
      const t = e.changedTouches[0];
      finishTrack(t ? t.clientX - track.startX : 0, false);
    };

    /** 触摸被系统中断：按回弹语义收尾 */
    const onTouchCancel = () => finishTrack(0, true);

    /** 鼠标按下（桌面端）：与触摸流同一套判定，仅左键 */
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      if (!startTrack(e.clientX, e.clientY, e.target)) return;
      mouseActive = true;
    };

    /** 鼠标移动：超过鼠标死区距离后进入方向判定 */
    const onMouseMove = (e: MouseEvent) => {
      const track = trackRef.current;
      if (!mouseActive || !track) return;
      const dx = e.clientX - track.startX;
      const dy = e.clientY - track.startY;
      if (!track.decided) {
        if (Math.abs(dx) < DRAG_MOUSE_DISTANCE_PX && Math.abs(dy) < DRAG_MOUSE_DISTANCE_PX) return;
        if (!decideHorizontal(dx, dy)) {
          mouseActive = false;
          trackRef.current = null;
          return;
        }
        track.decided = true;
        optionsRef.current.onDragStart?.(dx < 0 ? "next" : "prev");
      }
      recordSample(track, e.clientX);
    };

    /** 鼠标抬起：settle 判定 */
    const onMouseUp = (e: MouseEvent) => {
      if (!mouseActive) return;
      mouseActive = false;
      const track = trackRef.current;
      if (!track) return;
      finishTrack(e.clientX - track.startX, false);
    };

    viewport.addEventListener("touchstart", onTouchStart, { passive: true });
    viewport.addEventListener("touchmove", onTouchMove, { passive: false });
    viewport.addEventListener("touchend", onTouchEnd, { passive: true });
    viewport.addEventListener("touchcancel", onTouchCancel, { passive: true });
    if (optionsRef.current.enableMouseDrag) {
      viewport.addEventListener("mousedown", onMouseDown);
      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    }

    return () => {
      viewport.removeEventListener("touchstart", onTouchStart);
      viewport.removeEventListener("touchmove", onTouchMove);
      viewport.removeEventListener("touchend", onTouchEnd);
      viewport.removeEventListener("touchcancel", onTouchCancel);
      viewport.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      trackRef.current = null;
      mouseActive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.enabled, options.enableMouseDrag]);

  // 键盘导航：←/PageUp 上一页，→/PageDown/空格 下一页（仅横向模式启用）
  useEffect(() => {
    if (!options.enabled) return;
    /**
     * 键盘事件处理：过滤修饰键与输入焦点，映射按键到翻页方向
     * @param e 键盘事件
     * @returns void
     */
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "BUTTON" ||
          target.isContentEditable)
      ) {
        return;
      }
      const o = optionsRef.current;
      // 防重入锁不在此处拦截键盘：动画期间的按键交给翻页动画引擎做跳帧合并（T31）
      if (o.isBlocked?.()) return;
      let turn: PageTurnDirection | null = null;
      switch (e.key) {
        case "ArrowLeft":
        case "PageUp":
          turn = "prev";
          break;
        case "ArrowRight":
        case "PageDown":
        case " ":
          turn = "next";
          break;
        default:
          return;
      }
      e.preventDefault();
      if (turn === "next") o.onTurnNext();
      else o.onTurnPrev();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.enabled]);

  return { shouldSuppressClick };
};

/**
 * 平移翻页动画控制器（T31 /《翻页功能重设计方案》S2）
 *
 * 职责：承接统一手势层（usePageTurnGesture）输出的拖拽事件流与松手 settle 判定，
 * 以纯命令式 transform 实现跟手平移、翻页补间与回弹补间；同时为分区点击/键盘翻页
 * 提供固定时长的补间动画路径。
 *
 * 两种载体模型：
 * 1. 多栏模型（EPUB 横向，CSS 多栏 + 原生 scrollLeft）：
 *    - 跟手：宿主容器 translateX(delta)，相邻栏真实内容随容器平移自然滑入视口；
 *    - settle 翻页：transform 从当前位移补间到 ∓一个步长（下一页 -step / 上一页 +step），
 *      补间完成后同一帧内提交翻页（nextPage/prevPage 内部同步跳 scrollLeft）并将
 *      transform 归零——补间终值画面与提交后画面严格重合，视觉无跳变；
 * 2. 单页模型（PDF canvas / TXT 单页 DOM，无相邻页内容）：
 *    - 翻页采用「滑出露底色 → 瞬切内容 → 从对侧滑入」两段式补间近似整体平移。
 *
 * 实现约束：
 * - 仅操作 transform（translate3d）与 willChange，不触发布局重排；
 * - transform 通过命令式写入宿主元素内联样式，宿主的 React JSX style 不含 transform，
 *   重渲染不会覆盖动画中间态；
 * - 动画期间 isLocked 返回 true 供手势层防重入；动画中被再次请求翻页时
 *   「快进」当前动画到终态后启动新动画（快速连翻跳帧合并）。
 */

import { useCallback, useEffect, useRef } from "react";
import {
  PAGE_TURN_SLIDE_CLICK_DURATION_MS,
  PAGE_TURN_SLIDE_IN_DURATION_MS,
  PAGE_TURN_SLIDE_OUT_DURATION_MS,
  PAGE_TURN_SLIDE_REBOUND_DURATION_MS,
  PAGE_TURN_SLIDE_SETTLE_DURATION_MS,
} from "../../../constants/interactions";

/** 翻页方向语义：next=看下一页（内容左移），prev=看上一页（内容右移） */
export type SlideDirection = "next" | "prev";

/** 控制器所处阶段：空闲 / 拖拽跟手中 / 补间动画中 */
type SlidePhase = "idle" | "dragging" | "animating";

/** 单段补间动画描述 */
type SlideSegment = {
  /** 起始 transform 偏移（px） */
  from: number;
  /** 结束 transform 偏移（px） */
  to: number;
  /** 补间时长（ms） */
  duration: number;
  /** 缓动函数：进度 t∈[0,1] → 插值系数 */
  easing: (t: number) => number;
  /** 补间完成后的续接动作（单页模型用于串接滑入段/提交翻页） */
  onDone?: () => void;
};

/** 进行中的动画运行时状态 */
type SlideAnim = {
  segment: SlideSegment;
  /** 动画起始时间戳（performance.now()） */
  startTime: number;
};

/** 动画控制器配置项 */
type PageTurnSlideOptions = {
  /** 是否启用（仅横向阅读模式；纵向滚动模式完全让位） */
  enabled: boolean;
  /** transform 宿主元素：EPUB/TXT 为 DOM 渲染容器，PDF 横向为画布元素 */
  getHostElement: () => HTMLElement | null;
  /** 视口宽度来源：一个翻页步长 = 视口宽 */
  getViewportWidth: () => number;
  /** 是否为单页模型（PDF/TXT：无相邻页内容，翻页走滑出-瞬切-滑入两段式） */
  isSinglePage: () => boolean;
  /** 边界判定：返回 false 时 settle 拖拽回弹、点击/键盘翻页静默忽略 */
  canTurn: (direction: SlideDirection) => boolean;
  /** 翻页提交：补间完成后调用（复用现有 navigation.prevPage/nextPage） */
  commitTurn: (direction: SlideDirection) => void;
};

/** 动画控制器对外暴露的能力 */
export type PageTurnSlide = {
  /** 防重入锁：补间动画期间返回 true，手势层据此忽略新的触摸拖拽 */
  isLocked: () => boolean;
  /** 拖拽开始（手势层方向判定完成后触发）：进入跟手阶段 */
  dragStart: (direction: SlideDirection) => void;
  /** 拖拽跟手：实时应用 deltaX（向左为负），不走补间 */
  dragMove: (deltaX: number) => void;
  /** 拖拽结束：settled=true 走翻页补间，否则回弹补间 */
  dragEnd: (result: { settled: boolean; direction: SlideDirection | null }) => void;
  /** 程序化翻页（分区点击/键盘）：无拖拽时从 0 起播固定时长补间；动画中被调用则跳帧合并 */
  turn: (direction: SlideDirection) => void;
};

/**
 * easeOutCubic 缓动：快出慢停，适合松手后的收尾（跟手结束的惯性延续感）
 * @param t 归一化进度 [0,1]
 * @returns 插值系数 [0,1]
 */
const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

/**
 * easeInOutCubic 缓动：两端减速，适合无手势来源的点击/键盘翻页
 * @param t 归一化进度 [0,1]
 * @returns 插值系数 [0,1]
 */
const easeInOutCubic = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

/**
 * 将时间进度映射为缓动插值后的位置
 * @param seg 补间段描述
 * @param elapsed 已流逝时间（ms）
 * @returns 当前 transform 偏移（px）
 */
const sampleSegment = (seg: SlideSegment, elapsed: number): number => {
  const t = Math.max(0, Math.min(1, elapsed / seg.duration));
  return seg.from + (seg.to - seg.from) * seg.easing(t);
};

/**
 * 平移翻页动画控制器
 *
 * @param options 控制器配置项
 * @returns dragStart/dragMove/dragEnd/turn/isLocked 接口，供 Reader 与手势层接线
 */
export const usePageTurnSlide = (options: PageTurnSlideOptions): PageTurnSlide => {
  // 以 ref 镜像最新配置，动画循环始终读取最新闭包，避免回调依赖变化打断动画
  const optionsRef = useRef(options);
  optionsRef.current = options;

  /** 当前阶段 */
  const phaseRef = useRef<SlidePhase>("idle");
  /** 进行中的补间动画；null 表示无动画 */
  const animRef = useRef<SlideAnim | null>(null);
  /** 动画帧句柄 */
  const rafRef = useRef<number>(0);
  /** 拖拽过程中最后一次位移（松手 settle 补间的起点） */
  const lastDeltaRef = useRef(0);

  /**
   * 把 transform 偏移写入宿主元素；0 时清除内联样式，交还默认布局
   * @param tx 水平偏移（px）
   * @returns void
   */
  const applyTx = useCallback((tx: number): void => {
    const host = optionsRef.current.getHostElement();
    if (!host) return;
    if (tx === 0) {
      host.style.transform = "";
      host.style.willChange = "";
    } else {
      host.style.transform = `translate3d(${tx}px, 0, 0)`;
      host.style.willChange = "transform";
    }
  }, []);

  /**
   * 停止当前补间动画（不推进到终态，画面停在当前位置）
   * @returns void
   */
  const cancelAnim = useCallback((): void => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    animRef.current = null;
  }, []);

  /**
   * 启动一段补间动画；phase 置为 animating
   * @param seg 补间段描述
   * @returns void
   */
  const startSegment = useCallback((seg: SlideSegment): void => {
    cancelAnim();
    animRef.current = { segment: seg, startTime: performance.now() };
    phaseRef.current = "animating";

    /**
     * rAF 逐帧推进：按缓动采样写入 transform，结束后归位并续接下一段
     * @returns void
     */
    const tick = (): void => {
      const anim = animRef.current;
      if (!anim) return;
      const elapsed = performance.now() - anim.startTime;
      if (elapsed < anim.segment.duration) {
        applyTx(sampleSegment(anim.segment, elapsed));
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      // 本段结束：落到终值，清除动画状态后执行续接动作
      // （先清 animRef 再 onDone，保证 onDone 内可无缝串接下一段）
      applyTx(anim.segment.to);
      animRef.current = null;
      rafRef.current = 0;
      anim.segment.onDone?.();
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [applyTx, cancelAnim]);

  /**
   * 回到空闲态：确保 transform 归零、清除动画与拖拽痕迹
   * @returns void
   */
  const settleToIdle = useCallback((): void => {
    cancelAnim();
    lastDeltaRef.current = 0;
    applyTx(0);
    phaseRef.current = "idle";
  }, [applyTx, cancelAnim]);

  /**
   * 快进当前动画链到终态：逐段同步执行 onDone（单页模型为 提交翻页→滑入段），
   * 用于动画期间的再次翻页请求（快速连翻跳帧合并）
   * @returns void
   */
  const finishAnimImmediately = useCallback((): void => {
    // 防御异常链：最多串 4 段，避免意外循环
    for (let i = 0; i < 4 && animRef.current; i++) {
      const seg = animRef.current.segment;
      cancelAnim();
      applyTx(seg.to);
      seg.onDone?.();
    }
    // 快进后若仍有残留动画（异常情况）直接丢弃
    if (animRef.current) cancelAnim();
  }, [applyTx, cancelAnim]);

  /**
   * 计算翻页方向的补间终点偏移（多栏模型）：下一页 -1 步长、上一页 +1 步长
   * @param direction 翻页方向
   * @param step 一个翻页步长（视口宽，px）
   * @returns 补间终点偏移（px）
   */
  const commitTargetTx = (direction: SlideDirection, step: number): number =>
    direction === "next" ? -step : step;

  /**
   * 多栏模型翻页补间：从当前位移补间到 ∓step，完成后同帧提交翻页并归零 transform。
   * 提交（nextPage/prevPage 内部同步改 scrollLeft）与归零在同一帧内完成，
   * 补间终值画面 = 提交后画面，视觉无跳变。
   * @param direction 翻页方向
   * @param fromTx 补间起点（松手位移或 0）
   * @param duration 补间时长（ms）
   * @param easing 缓动函数
   * @returns void
   */
  const playMultiColumnCommit = useCallback(
    (direction: SlideDirection, fromTx: number, duration: number, easing: (t: number) => number): void => {
      const step = optionsRef.current.getViewportWidth();
      const target = commitTargetTx(direction, step);
      startSegment({
        from: fromTx,
        to: target,
        duration,
        easing,
        onDone: () => {
          optionsRef.current.commitTurn(direction);
          applyTx(0);
          phaseRef.current = "idle";
        },
      });
    },
    [applyTx, startSegment]
  );

  /**
   * 单页模型翻页补间（两段式）：滑出露底色 → 瞬切内容 → 从对侧滑入。
   * 滑出段终点为 ∓step（当前页完全移出视口），滑入段起点为反侧 ±step。
   * @param direction 翻页方向
   * @param fromTx 滑出段起点（松手位移或 0）
   * @param outDuration 滑出段时长（ms）
   * @param inDuration 滑入段时长（ms）
   * @param easing 缓动函数
   * @returns void
   */
  const playSinglePageCommit = useCallback(
    (direction: SlideDirection, fromTx: number, outDuration: number, inDuration: number, easing: (t: number) => number): void => {
      const step = optionsRef.current.getViewportWidth();
      startSegment({
        from: fromTx,
        to: commitTargetTx(direction, step),
        duration: outDuration,
        easing,
        onDone: () => {
          // 滑出完成：提交翻页（内容瞬切），并把新页瞬移到对侧准备滑入
          optionsRef.current.commitTurn(direction);
          applyTx(direction === "next" ? step : -step);
          startSegment({
            from: direction === "next" ? step : -step,
            to: 0,
            duration: inDuration,
            easing: easeOutCubic,
            onDone: () => {
              applyTx(0);
              phaseRef.current = "idle";
            },
          });
        },
      });
    },
    [applyTx, startSegment]
  );

  /**
   * 程序化翻页入口（分区点击/键盘）：从 0 起播固定时长补间。
   * 边界处（canTurn=false）静默忽略；动画中被调用则先快进当前动画（跳帧合并）再播新动画。
   * @param direction 翻页方向
   * @returns void
   */
  const turn = useCallback(
    (direction: SlideDirection): void => {
      const o = optionsRef.current;
      if (!o.enabled) return;
      // 拖拽跟手中的程序化翻页请求（如拖拽中按键）忽略：等松手 settle 判定统一处理
      if (phaseRef.current === "dragging") return;
      if (!o.canTurn(direction)) return;
      // 快速连翻跳帧合并：立即完成进行中的动画（含其续接链），再从原位起播新动画
      if (phaseRef.current === "animating") finishAnimImmediately();
      lastDeltaRef.current = 0;
      if (o.isSinglePage()) {
        // 单页模型：总时长 = 滑出段 + 滑入段 ≈ 点击补间总时长
        const outMs = Math.round(PAGE_TURN_SLIDE_CLICK_DURATION_MS * (PAGE_TURN_SLIDE_OUT_DURATION_MS / (PAGE_TURN_SLIDE_OUT_DURATION_MS + PAGE_TURN_SLIDE_IN_DURATION_MS)));
        const inMs = PAGE_TURN_SLIDE_CLICK_DURATION_MS - outMs;
        playSinglePageCommit(direction, 0, outMs, inMs, easeInOutCubic);
      } else {
        playMultiColumnCommit(direction, 0, PAGE_TURN_SLIDE_CLICK_DURATION_MS, easeInOutCubic);
      }
    },
    [finishAnimImmediately, playMultiColumnCommit, playSinglePageCommit]
  );

  /**
   * 拖拽开始：进入跟手阶段（不产生视觉位移，等 dragMove 逐步写入）
   * @param direction 手势判定的拖拽语义方向
   * @returns void
   */
  const dragStart = useCallback(
    (direction: SlideDirection): void => {
      const o = optionsRef.current;
      if (!o.enabled) return;
      // 动画期间手势层已通过 isLocked 拦截，此处防御兜底
      if (phaseRef.current === "animating") return;
      lastDeltaRef.current = 0;
      phaseRef.current = "dragging";
      // direction 仅作语义记录，跟手位移由 dragMove 实时驱动
      void direction;
    },
    []
  );

  /**
   * 拖拽跟手：直接写入 transform（触摸事件频率与刷新率对齐，无需额外节流）
   * @param deltaX 相对手势起点的水平位移（px，向左为负）
   * @returns void
   */
  const dragMove = useCallback(
    (deltaX: number): void => {
      if (!optionsRef.current.enabled) return;
      if (phaseRef.current !== "dragging") return;
      lastDeltaRef.current = deltaX;
      applyTx(deltaX);
    },
    [applyTx]
  );

  /**
   * 拖拽结束：settle 通过走翻页补间（多栏单段/单页两段式），未通过或被系统中断则回弹；
   * 边界处（canTurn=false）一律回弹。
   * @param result 手势层 settle 判定结果：settled=true 表示翻页，false 表示回弹/中断
   * @returns void
   */
  const dragEnd = useCallback(
    (result: { settled: boolean; direction: SlideDirection | null }): void => {
      const o = optionsRef.current;
      if (!o.enabled) return;
      if (phaseRef.current !== "dragging") return;
      const fromTx = lastDeltaRef.current;
      const direction = result.direction;
      if (result.settled && direction && o.canTurn(direction)) {
        phaseRef.current = "animating";
        if (o.isSinglePage()) {
          // 单页模型：滑出段只需补完剩余位移，时长按剩余距离比例收缩
          const step = Math.max(1, o.getViewportWidth());
          const remain = Math.min(1, Math.abs(commitTargetTx(direction, step) - fromTx) / step);
          playSinglePageCommit(
            direction,
            fromTx,
            Math.max(60, Math.round(PAGE_TURN_SLIDE_OUT_DURATION_MS * remain)),
            PAGE_TURN_SLIDE_IN_DURATION_MS,
            easeOutCubic
          );
        } else {
          playMultiColumnCommit(direction, fromTx, PAGE_TURN_SLIDE_SETTLE_DURATION_MS, easeOutCubic);
        }
        return;
      }
      // 回弹：从当前位移缓动回原位（touchcancel/多指中断时 direction 为 null 同样回弹）
      phaseRef.current = "animating";
      startSegment({
        from: fromTx,
        to: 0,
        duration: PAGE_TURN_SLIDE_REBOUND_DURATION_MS,
        easing: easeOutCubic,
        onDone: () => {
          applyTx(0);
          phaseRef.current = "idle";
        },
      });
    },
    [applyTx, playMultiColumnCommit, playSinglePageCommit, startSegment]
  );

  // 卸载或禁用（模式切换/加载中）时复位宿主样式，避免残留位移
  useEffect(() => {
    if (!options.enabled) {
      settleToIdle();
    }
    return () => {
      settleToIdle();
    };
  }, [options.enabled, settleToIdle]);

  /**
   * 防重入锁判定：补间动画期间为 true，手势层据此忽略新的拖拽起点
   * @returns true 表示动画进行中
   */
  const isLocked = useCallback((): boolean => phaseRef.current === "animating", []);

  return { isLocked, dragStart, dragMove, dragEnd, turn };
};

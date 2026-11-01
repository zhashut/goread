/**
 * 覆盖翻页动画控制器（T32 /《翻页功能重设计方案》S3）
 *
 * 职责：承接统一手势层（usePageTurnGesture）输出的拖拽事件流与松手 settle 判定，
 * 以「层叠视口克隆」实现覆盖式翻页：翻下一页时克隆一个偏移一屏的视口容器
 * （z-index 高于内容层 + 左缘阴影）拖拽跟手滑入，settle 补间完成后底层瞬切真实
 * 页码并销毁克隆层；翻上一页对称——当前页快照层滑出，露出其下垫着的上一页克隆层。
 *
 * 两条执行路径：
 * 1. 克隆覆盖路径（EPUB 多栏章内翻页）：
 *    - 深克隆（cloneNode(true)）会随 shadow-including clone 复制出 Shadow DOM
 *      内容（本项目样式全部是 <style> 元素，可完整复制）；
 *    - 克隆容器与源容器同宽同列布局，改写 scrollLeft ± 一个步长即得相邻页快照；
 *    - 构建时做三重运行时校验（shadow 内容存在 / 与源同宽 / 目标滚动可落位），
 *      任一步失败立即销毁已建层并降级到两段式，绝不带错位内容出场（防破相）；
 * 2. 两段式降级路径（PDF/TXT 单页模型、EPUB 跨章边界、克隆校验失败）：
 *    - 与平移控制器的单页模型一致：基础宿主 transform 滑出露底色 → 瞬切内容 →
 *      从对侧滑入；PDF 即设计文档所述「退化为位图页滑动」。
 *
 * 实现约束：
 * - 克隆层挂载在阅读器主视图内的独立覆盖宿主（React 不管理其子节点），
 *   仅操作 transform（translate3d）与 willChange，不触发布局重排；
 * - 动画结束立即销毁克隆层（不常驻），克隆层 pointer-events: none 不拦截交互；
 * - 动画期间 isLocked 返回 true 供手势层防重入；动画中被再次请求翻页时
 *   「快进」当前动画到终态后启动新动画（快速连翻跳帧合并）；
 * - 跨章翻页不使用克隆（相邻章节内容不在 DOM 中），一律走两段式：
 *   先 settle 滑出当前章再切章，满足「动画 settle 后切章、跨章不破相」。
 */

import { useCallback, useEffect, useRef } from "react";
import {
  PAGE_TURN_COVER_CLICK_DURATION_MS,
  PAGE_TURN_COVER_REBOUND_DURATION_MS,
  PAGE_TURN_COVER_SETTLE_DURATION_MS,
  PAGE_TURN_SLIDE_IN_DURATION_MS,
  PAGE_TURN_SLIDE_OUT_DURATION_MS,
} from "../../../constants/interactions";

/** 翻页方向语义：next=看下一页（克隆层自右滑入），prev=看上一页（当前层滑出） */
export type CoverDirection = "next" | "prev";

/** 克隆覆盖上下文：描述一次克隆覆盖翻页所需的快照信息（由宿主按需提供） */
export type CoverCloneContext = {
  /** 克隆源元素（EPUB 多栏滚动容器，Shadow DOM 内容随深克隆一并复制） */
  source: HTMLElement;
  /** 顶层克隆层应显示的滚动位置（next=下一栏；prev=当前栏快照） */
  topScrollLeft: number;
  /** 底层克隆层滚动位置（仅 prev 需要：上一栏），null 表示无底层 */
  underScrollLeft: number | null;
  /** 覆盖层底色（与阅读页底色一致，防止克隆未铺满时透底） */
  background: string;
};

/** 控制器所处阶段：空闲 / 拖拽跟手中 / 补间动画中 */
type CoverPhase = "idle" | "dragging" | "animating";

/** 当前生效路径：clone=克隆层覆盖；plain=两段式平移降级 */
type CoverMode = "clone" | "plain";

/** 单段补间动画描述：apply 指明插值位置的写入载体（顶层克隆层或基础宿主） */
type CoverSegment = {
  /** 起始位置（px） */
  from: number;
  /** 结束位置（px） */
  to: number;
  /** 补间时长（ms） */
  duration: number;
  /** 缓动函数：进度 t∈[0,1] → 插值系数 */
  easing: (t: number) => number;
  /** 将插值位置写入对应视觉载体 */
  apply: (value: number) => void;
  /** 补间完成后的续接动作（提交翻页 / 串接滑入段） */
  onDone?: () => void;
};

/** 进行中的动画运行时状态 */
type CoverAnim = {
  segment: CoverSegment;
  /** 动画起始时间戳（performance.now()） */
  startTime: number;
};

/** 动画控制器配置项 */
type PageTurnCoverOptions = {
  /** 是否启用（仅横向阅读模式；纵向滚动模式完全让位） */
  enabled: boolean;
  /** 基础宿主（两段式降级路径的 transform 载体）：EPUB/TXT 为 DOM 渲染容器，PDF 横向为画布 */
  getHostElement: () => HTMLElement | null;
  /** 视口宽度来源：一个翻页步长 = 视口宽 */
  getViewportWidth: () => number;
  /** 克隆层挂载点（主视图内独立覆盖宿主，position:absolute 铺满视口） */
  getOverlayRoot: () => HTMLElement | null;
  /**
   * 克隆覆盖上下文提供器：返回 null 表示该方向无法克隆覆盖
   * （非 EPUB 多栏、跨章边界、图片未就绪），控制器退化为两段式平移
   */
  getCloneContext: (direction: CoverDirection) => CoverCloneContext | null;
  /** 边界判定：返回 false 时 settle 拖拽回弹、点击/键盘翻页静默忽略 */
  canTurn: (direction: CoverDirection) => boolean;
  /** 翻页提交：补间完成后调用（复用现有 navigation.prevPage/nextPage） */
  commitTurn: (direction: CoverDirection) => void;
};

/** 动画控制器对外暴露的能力 */
export type PageTurnCover = {
  /** 防重入锁：补间动画期间返回 true，手势层据此忽略新的触摸拖拽 */
  isLocked: () => boolean;
  /** 拖拽开始（手势层方向判定完成后触发）：构建克隆层并进入跟手阶段 */
  dragStart: (direction: CoverDirection) => void;
  /** 拖拽跟手：实时应用 deltaX（向左为负），不走补间 */
  dragMove: (deltaX: number) => void;
  /** 拖拽结束：settled=true 走翻页补间，否则回弹补间 */
  dragEnd: (result: { settled: boolean; direction: CoverDirection | null }) => void;
  /** 程序化翻页（分区点击/键盘）：无拖拽时起播固定时长补间；动画中被调用则跳帧合并 */
  turn: (direction: CoverDirection) => void;
};

/** 克隆层左缘阴影：两种方向的移动层视觉前缘一致（next 滑入 / prev 滑出的左缘） */
const COVER_LAYER_SHADOW = "-16px 0 32px rgba(0, 0, 0, 0.28)";

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
 * @returns 当前插值位置（px）
 */
const sampleSegment = (seg: CoverSegment, elapsed: number): number => {
  const t = Math.max(0, Math.min(1, elapsed / seg.duration));
  return seg.from + (seg.to - seg.from) * seg.easing(t);
};

/**
 * 覆盖翻页动画控制器
 *
 * @param options 控制器配置项
 * @returns dragStart/dragMove/dragEnd/turn/isLocked 接口，供 Reader 与手势层接线
 */
export const usePageTurnCover = (options: PageTurnCoverOptions): PageTurnCover => {
  // 以 ref 镜像最新配置，动画循环始终读取最新闭包，避免回调依赖变化打断动画
  const optionsRef = useRef(options);
  optionsRef.current = options;

  /** 当前阶段 */
  const phaseRef = useRef<CoverPhase>("idle");
  /** 进行中的补间动画；null 表示无动画 */
  const animRef = useRef<CoverAnim | null>(null);
  /** 动画帧句柄 */
  const rafRef = useRef<number>(0);
  /** 拖拽过程中最后一次位移（松手 settle 补间的起点） */
  const lastDeltaRef = useRef(0);
  /** 当前手势/动画的翻页方向 */
  const directionRef = useRef<CoverDirection | null>(null);
  /** 当前生效路径（克隆覆盖 / 两段式降级） */
  const modeRef = useRef<CoverMode>("plain");
  /** 当前动画/拖拽使用的顶层克隆层（next=下一页滑入；prev=当前页滑出） */
  const topLayerRef = useRef<HTMLElement | null>(null);
  /** prev 场景垫在顶层之下的上一页克隆层 */
  const underLayerRef = useRef<HTMLElement | null>(null);

  /**
   * 将水平偏移写入顶层克隆层的 transform；0 时清除内联样式
   * @param x 水平偏移（px）
   * @returns void
   */
  const applyTopX = useCallback((x: number): void => {
    const layer = topLayerRef.current;
    if (!layer) return;
    if (x === 0) {
      layer.style.transform = "";
      layer.style.willChange = "";
    } else {
      layer.style.transform = `translate3d(${x}px, 0, 0)`;
      layer.style.willChange = "transform";
    }
  }, []);

  /**
   * 将水平偏移写入基础宿主（两段式降级路径载体）；0 时清除内联样式
   * @param x 水平偏移（px）
   * @returns void
   */
  const applyHostX = useCallback((x: number): void => {
    const host = optionsRef.current.getHostElement();
    if (!host) return;
    if (x === 0) {
      host.style.transform = "";
      host.style.willChange = "";
    } else {
      host.style.transform = `translate3d(${x}px, 0, 0)`;
      host.style.willChange = "transform";
    }
  }, []);

  /**
   * 销毁全部克隆层并清空引用（克隆层仅存在于单次手势/动画期间，不常驻）
   * @returns void
   */
  const destroyLayers = useCallback((): void => {
    topLayerRef.current?.remove();
    underLayerRef.current?.remove();
    topLayerRef.current = null;
    underLayerRef.current = null;
  }, []);

  /**
   * 构建单个克隆覆盖层（前置 PoC 的运行时验证载体）
   *
   * 校验链（任一步失败即移除外壳并返回 null）：
   * 1. 深克隆必须带出 Shadow DOM 内容（shadow-including clone 生效）；
   * 2. 克隆容器与源容器同宽（多栏列布局成立的前提）；
   * 3. 目标滚动位置必须可落位（scrollWidth 足够且 scrollLeft 写入生效）。
   *
   * @param ctx 克隆覆盖上下文
   * @param zIndex 层叠顺序（顶层 2 / 底层 1）
   * @param withShadow 是否带左缘阴影（仅移动的顶层需要）
   * @returns 成功返回覆盖层外壳元素；失败返回 null
   */
  const buildCloneLayer = useCallback(
    (ctx: CoverCloneContext, zIndex: number, withShadow: boolean): HTMLElement | null => {
      const root = optionsRef.current.getOverlayRoot();
      if (!root) return null;
      let wrapper: HTMLElement | null = null;
      try {
        const clone = ctx.source.cloneNode(true) as HTMLElement;
        // 校验 1：Shadow DOM 内容必须随深克隆复制成功
        if (!clone.shadowRoot || clone.shadowRoot.childElementCount === 0) return null;
        wrapper = document.createElement("div");
        wrapper.style.cssText =
          "position:absolute;top:0;left:0;width:100%;height:100%;overflow:hidden;" +
          `z-index:${zIndex};background:${ctx.background};` +
          "pointer-events:none;" +
          (withShadow ? `box-shadow:${COVER_LAYER_SHADOW};` : "");
        // 克隆容器归一化为铺满外壳，滚动行为强制瞬时（避免 smooth 滚动干扰快照定位）
        clone.style.position = "absolute";
        clone.style.top = "0";
        clone.style.left = "0";
        clone.style.width = "100%";
        clone.style.height = "100%";
        clone.style.margin = "0";
        clone.style.scrollBehavior = "auto";
        wrapper.appendChild(clone);
        root.appendChild(wrapper);
        // 强制布局后校验 2：与源容器同宽
        if (Math.abs(clone.clientWidth - ctx.source.clientWidth) > 1) {
          wrapper.remove();
          return null;
        }
        // 校验 3：目标滚动位置可落位（内容足够宽且写入生效）
        if (clone.scrollWidth <= clone.clientWidth) {
          wrapper.remove();
          return null;
        }
        clone.scrollLeft = ctx.topScrollLeft;
        if (Math.abs(clone.scrollLeft - ctx.topScrollLeft) > 2) {
          wrapper.remove();
          return null;
        }
        return wrapper;
      } catch {
        wrapper?.remove();
        return null;
      }
    },
    []
  );

  /**
   * 按方向构建全套克隆层（next 一层滑入层；prev 顶层滑出层 + 底层上一页垫层），
   * 构建成功后写入 topLayerRef/underLayerRef
   * @param direction 翻页方向
   * @returns true 表示克隆层构建成功（可走克隆覆盖路径）
   */
  const buildCloneLayers = useCallback(
    (direction: CoverDirection): boolean => {
      destroyLayers();
      const ctx = optionsRef.current.getCloneContext(direction);
      if (!ctx) return false;
      // 顶层先建（next：下一页滑入层带阴影；prev：当前页滑出层带阴影）
      const top = buildCloneLayer(ctx, 2, true);
      if (!top) {
        destroyLayers();
        return false;
      }
      topLayerRef.current = top;
      // prev 需要垫在滑出层之下的上一页克隆层（静态、无阴影）
      if (direction === "prev") {
        if (ctx.underScrollLeft === null) {
          destroyLayers();
          return false;
        }
        const under = buildCloneLayer(
          { ...ctx, topScrollLeft: ctx.underScrollLeft },
          1,
          false
        );
        if (!under) {
          destroyLayers();
          return false;
        }
        underLayerRef.current = under;
      }
      return true;
    },
    [buildCloneLayer, destroyLayers]
  );

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
  const startSegment = useCallback((seg: CoverSegment): void => {
    cancelAnim();
    animRef.current = { segment: seg, startTime: performance.now() };
    phaseRef.current = "animating";

    /**
     * rAF 逐帧推进：按缓动采样写入载体，结束后落终值并续接下一段
     * @returns void
     */
    const tick = (): void => {
      const anim = animRef.current;
      if (!anim) return;
      const elapsed = performance.now() - anim.startTime;
      if (elapsed < anim.segment.duration) {
        anim.segment.apply(sampleSegment(anim.segment, elapsed));
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      // 本段结束：落到终值，清除动画状态后执行续接动作
      // （先清 animRef 再 onDone，保证 onDone 内可无缝串接下一段）
      anim.segment.apply(anim.segment.to);
      animRef.current = null;
      rafRef.current = 0;
      anim.segment.onDone?.();
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [cancelAnim]);

  /**
   * 回到空闲态：销毁克隆层、复位基础宿主 transform、清除动画与拖拽痕迹
   * @returns void
   */
  const settleToIdle = useCallback((): void => {
    cancelAnim();
    destroyLayers();
    lastDeltaRef.current = 0;
    directionRef.current = null;
    applyHostX(0);
    phaseRef.current = "idle";
  }, [applyHostX, cancelAnim, destroyLayers]);

  /**
   * 快进当前动画链到终态：逐段同步执行 onDone（两段式为 提交翻页→滑入段），
   * 用于动画期间的再次翻页请求（快速连翻跳帧合并）
   * @returns void
   */
  const finishAnimImmediately = useCallback((): void => {
    // 防御异常链：最多串 4 段，避免意外循环
    for (let i = 0; i < 4 && animRef.current; i++) {
      const seg = animRef.current.segment;
      cancelAnim();
      seg.apply(seg.to);
      seg.onDone?.();
    }
    // 快进后若仍有残留动画（异常情况）直接丢弃并清理
    if (animRef.current) {
      cancelAnim();
      destroyLayers();
      applyHostX(0);
      phaseRef.current = "idle";
    }
  }, [applyHostX, cancelAnim, destroyLayers]);

  /**
   * 克隆层路径翻页补间：顶层从当前位置补间到终点
   * （next：滑入至 0 完全覆盖；prev：滑出至 +视口宽完全离场），
   * 补间完成后提交翻页（底层瞬切真实页码）并销毁克隆层——终值画面与提交后画面重合，无跳变
   * @param direction 翻页方向
   * @param fromX 顶层当前位置（px）
   * @param duration 补间时长（ms）
   * @param easing 缓动函数
   * @returns void
   */
  const playCloneCommit = useCallback(
    (direction: CoverDirection, fromX: number, duration: number, easing: (t: number) => number): void => {
      const vw = Math.max(1, optionsRef.current.getViewportWidth());
      startSegment({
        from: fromX,
        to: direction === "next" ? 0 : vw,
        duration,
        easing,
        apply: applyTopX,
        onDone: () => {
          optionsRef.current.commitTurn(direction);
          destroyLayers();
          phaseRef.current = "idle";
        },
      });
    },
    [applyTopX, destroyLayers, startSegment]
  );

  /**
   * 两段式降级路径翻页补间：基础宿主滑出露底色 → 提交翻页（内容瞬切）→ 从对侧滑入。
   * @param direction 翻页方向
   * @param fromTx 滑出段起点（松手位移或 0）
   * @param outDuration 滑出段时长（ms）
   * @param inDuration 滑入段时长（ms）
   * @param easing 缓动函数
   * @returns void
   */
  const playPlainCommit = useCallback(
    (direction: CoverDirection, fromTx: number, outDuration: number, inDuration: number, easing: (t: number) => number): void => {
      const step = Math.max(1, optionsRef.current.getViewportWidth());
      startSegment({
        from: fromTx,
        to: direction === "next" ? -step : step,
        duration: outDuration,
        easing,
        apply: applyHostX,
        onDone: () => {
          // 滑出完成：提交翻页（内容瞬切），并把宿主瞬移到对侧准备滑入
          optionsRef.current.commitTurn(direction);
          applyHostX(direction === "next" ? step : -step);
          startSegment({
            from: direction === "next" ? step : -step,
            to: 0,
            duration: inDuration,
            easing: easeOutCubic,
            apply: applyHostX,
            onDone: () => {
              applyHostX(0);
              phaseRef.current = "idle";
            },
          });
        },
      });
    },
    [applyHostX, startSegment]
  );

  /**
   * 拖拽位移换算为顶层克隆层位置：
   * next：顶层（下一页）自视口右侧外滑入，x = vw + delta，夹取 [0, vw]（0=完全覆盖）；
   * prev：顶层（当前页快照）自 0 滑出，x = delta，夹取 [0, vw]
   * @param direction 翻页方向
   * @param deltaX 拖拽位移（向左为负）
   * @returns 顶层克隆层目标位置（px）
   */
  const deltaToTopX = (direction: CoverDirection, deltaX: number): number => {
    const vw = Math.max(1, optionsRef.current.getViewportWidth());
    const raw = direction === "next" ? vw + deltaX : deltaX;
    return Math.min(vw, Math.max(0, raw));
  };

  /**
   * 拖拽开始：即时构建克隆层（构建失败自动降级两段式）并进入跟手阶段
   * @param direction 手势判定的拖拽语义方向
   * @returns void
   */
  const dragStart = useCallback(
    (direction: CoverDirection): void => {
      const o = optionsRef.current;
      if (!o.enabled) return;
      // 动画期间手势层已通过 isLocked 拦截，此处防御兜底
      if (phaseRef.current === "animating") return;
      lastDeltaRef.current = 0;
      directionRef.current = direction;
      phaseRef.current = "dragging";
      modeRef.current = buildCloneLayers(direction) ? "clone" : "plain";
      if (modeRef.current === "clone") {
        const vw = Math.max(1, o.getViewportWidth());
        // next：顶层（下一页）先停在视口右侧外；prev：顶层（当前页快照）停在 0 盖住底层
        applyTopX(direction === "next" ? vw : 0);
      }
    },
    [applyTopX, buildCloneLayers]
  );

  /**
   * 拖拽跟手：克隆路径驱动顶层克隆层位移，两段式路径直接平移基础宿主
   * @param deltaX 相对手势起点的水平位移（px，向左为负）
   * @returns void
   */
  const dragMove = useCallback(
    (deltaX: number): void => {
      if (!optionsRef.current.enabled) return;
      if (phaseRef.current !== "dragging") return;
      lastDeltaRef.current = deltaX;
      if (modeRef.current === "clone" && directionRef.current) {
        applyTopX(deltaToTopX(directionRef.current, deltaX));
      } else {
        applyHostX(deltaX);
      }
    },
    [applyHostX, applyTopX]
  );

  /**
   * 拖拽结束：settle 通过走翻页补间（克隆层滑入/滑出 或 两段式），未通过或被系统中断则回弹；
   * 边界处（canTurn=false）一律回弹。手势中途反向（松手方向与起手方向相反）时
   * 克隆层内容与新方向不符，销毁克隆层改走两段式，防内容错位。
   * @param result 手势层 settle 判定结果：settled=true 表示翻页，false 表示回弹/中断
   * @returns void
   */
  const dragEnd = useCallback(
    (result: { settled: boolean; direction: CoverDirection | null }): void => {
      const o = optionsRef.current;
      if (!o.enabled) return;
      if (phaseRef.current !== "dragging") return;
      const from = lastDeltaRef.current;
      const direction = result.direction;
      if (result.settled && direction && o.canTurn(direction)) {
        phaseRef.current = "animating";
        const canClone =
          modeRef.current === "clone" && direction === directionRef.current && !!topLayerRef.current;
        if (canClone && directionRef.current) {
          // 松手方向与克隆层方向一致：顶层补间到终点后提交翻页
          const d = directionRef.current;
          const vw = Math.max(1, o.getViewportWidth());
          const fromX = deltaToTopX(d, from);
          const target = d === "next" ? 0 : vw;
          const remain = Math.min(1, Math.abs(target - fromX) / vw);
          playCloneCommit(
            d,
            fromX,
            Math.max(60, Math.round(PAGE_TURN_COVER_SETTLE_DURATION_MS * remain)),
            easeOutCubic
          );
        } else {
          // 两段式：滑出段只需补完剩余位移，时长按剩余距离比例收缩
          if (modeRef.current === "clone") destroyLayers();
          modeRef.current = "plain";
          const step = Math.max(1, o.getViewportWidth());
          const target = direction === "next" ? -step : step;
          const remain = Math.min(1, Math.abs(target - from) / step);
          playPlainCommit(
            direction,
            from,
            Math.max(60, Math.round(PAGE_TURN_SLIDE_OUT_DURATION_MS * remain)),
            PAGE_TURN_SLIDE_IN_DURATION_MS,
            easeOutCubic
          );
        }
        return;
      }
      // 回弹：克隆层退回原位后销毁；两段式宿主位移归零
      phaseRef.current = "animating";
      if (modeRef.current === "clone" && directionRef.current && topLayerRef.current) {
        const d = directionRef.current;
        const vw = Math.max(1, o.getViewportWidth());
        const fromX = deltaToTopX(d, from);
        const backTo = d === "next" ? vw : 0;
        const remain = Math.min(1, Math.abs(backTo - fromX) / vw);
        startSegment({
          from: fromX,
          to: backTo,
          duration: Math.max(60, Math.round(PAGE_TURN_COVER_REBOUND_DURATION_MS * remain)),
          easing: easeOutCubic,
          apply: applyTopX,
          onDone: () => {
            destroyLayers();
            phaseRef.current = "idle";
          },
        });
      } else {
        startSegment({
          from,
          to: 0,
          duration: PAGE_TURN_COVER_REBOUND_DURATION_MS,
          easing: easeOutCubic,
          apply: applyHostX,
          onDone: () => {
            applyHostX(0);
            phaseRef.current = "idle";
          },
        });
      }
    },
    [applyHostX, applyTopX, destroyLayers, playCloneCommit, playPlainCommit, startSegment]
  );

  /**
   * 程序化翻页入口（分区点击/键盘）：优先克隆覆盖路径，不可克隆（跨章/单页/校验失败）
   * 时走两段式；边界处（canTurn=false）静默忽略；动画中被调用则先快进当前动画（跳帧合并）。
   * @param direction 翻页方向
   * @returns void
   */
  const turn = useCallback(
    (direction: CoverDirection): void => {
      const o = optionsRef.current;
      if (!o.enabled) return;
      // 拖拽跟手中的程序化翻页请求（如拖拽中按键）忽略：等松手 settle 判定统一处理
      if (phaseRef.current === "dragging") return;
      if (!o.canTurn(direction)) return;
      // 快速连翻跳帧合并：立即完成进行中的动画（含其续接链），再从原位起播新动画
      if (phaseRef.current === "animating") finishAnimImmediately();
      lastDeltaRef.current = 0;
      directionRef.current = direction;
      phaseRef.current = "animating";
      if (buildCloneLayers(direction)) {
        modeRef.current = "clone";
        const vw = Math.max(1, o.getViewportWidth());
        // next：顶层自视口右侧外滑入；prev：顶层（当前页快照）自 0 滑出（底层已垫好上一页）
        const fromX = direction === "next" ? vw : 0;
        applyTopX(fromX);
        playCloneCommit(direction, fromX, PAGE_TURN_COVER_CLICK_DURATION_MS, easeInOutCubic);
      } else {
        modeRef.current = "plain";
        // 单页模型：总时长 = 滑出段 + 滑入段 ≈ 点击补间总时长
        const outMs = Math.round(
          PAGE_TURN_COVER_CLICK_DURATION_MS *
            (PAGE_TURN_SLIDE_OUT_DURATION_MS / (PAGE_TURN_SLIDE_OUT_DURATION_MS + PAGE_TURN_SLIDE_IN_DURATION_MS))
        );
        const inMs = PAGE_TURN_COVER_CLICK_DURATION_MS - outMs;
        playPlainCommit(direction, 0, outMs, inMs, easeInOutCubic);
      }
    },
    [applyTopX, buildCloneLayers, finishAnimImmediately, playCloneCommit, playPlainCommit]
  );

  // 卸载或禁用（模式切换/加载中）时销毁克隆层并复位宿主样式，避免残留位移
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

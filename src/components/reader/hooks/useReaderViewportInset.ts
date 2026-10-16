import type { CSSProperties } from "react";
import { getSafeAreaInsets } from "../../../utils/layout";

/** 允许在 style 中书写 CSS 自定义属性（--x）的样式类型 */
export type CssVarStyle = CSSProperties & Record<`--${string}`, string>;

/** 阅读页顶部让位信息 */
export interface ReaderViewportInset {
  /** 让位高度（CSS 值）：不需要让位时为 "0px" */
  topInset: string;
  /** 内容视口样式：以 CSS 变量形式交给 .reader-viewport 消费，由 CSS 负责盒模型 */
  viewportStyle: CssVarStyle;
  /** 顶部浮层的 top 值：在让位高度基础上再向下偏移 basePx */
  topOffset: (basePx: number) => string;
}

/**
 * 阅读页顶部让位高度（唯一数据源）
 *
 * 让位高度即系统状态栏高度：Android 由原生注入 CSS 变量，iOS 使用 env()，
 * 取值全部委托给 getSafeAreaInsets，组件不再自行拼接 calc 表达式。
 *
 * 使用约定（两种让位语义不同，不要混用）：
 * - 内容视口（.reader-viewport 的 padding-top）：只在「系统状态栏可见」时让位，
 *   否则控制栏显示/隐藏会让正文上下跳动；
 * - 顶部浮层（页码气泡、撤回跳转）：控制栏本身会盖住顶部区域，此时必须让位。
 *
 * @param reserveTopInset 是否需要为顶部区域让位
 */
export const useReaderViewportInset = (reserveTopInset: boolean): ReaderViewportInset => {
  // getSafeAreaInsets 返回的是 CSS 变量表达式（Android 由原生注入、iOS 走 env()），
  // 由浏览器在布局时解析，因此这里直接透传、不做缓存或换算
  const topInset = reserveTopInset ? getSafeAreaInsets().top : "0px";

  return {
    topInset,
    viewportStyle: { "--reader-top-inset": topInset } as CssVarStyle,
    topOffset: (basePx: number) => `calc(${topInset} + ${basePx}px)`,
  };
};

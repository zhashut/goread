import { useCallback } from "react";
import { hasActiveSelectionIn } from "../../../utils/selection";

interface ReaderClickOptions {
  readingMode: "horizontal" | "vertical" | string;
  clickTurnPage: boolean;
  onPrevPage: () => void;
  onNextPage: () => void;
  autoScroll: boolean;
  setAutoScroll: (active: boolean) => void;
  toggleUi: () => void;
  /** 拖拽手势刚结束的抑制窗口：true 时吞掉本次 click，防止拖拽松手被误判为分区点击 */
  shouldSuppressClick?: () => boolean;
  /** 文本选区宿主：选区存在时本次点击语义为取消选择，不触发翻页/菜单 */
  getSelectionHost?: () => HTMLElement | null;
}

/**
 * 处理阅读器主视图点击事件的 Hook
 * 三分区点击翻页（T30 统一交互规范）：左 1/3 上一页、右 1/3 下一页、中间呼出菜单；
 * 并做手势消解（拖拽后点击抑制、选中文本态点击不翻页）与交互元素忽略
 */
export const useReaderClick = ({
  readingMode,
  clickTurnPage,
  onPrevPage,
  onNextPage,
  autoScroll,
  setAutoScroll,
  toggleUi,
  shouldSuppressClick,
  getSelectionHost,
}: ReaderClickOptions) => {
  const handleMainViewClick = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      // 拖拽手势刚结束：吞掉随后的 click，防止拖拽松手误触分区翻页
      if (shouldSuppressClick?.()) return;
      // 忽略交互性元素点击，避免拦截链接跳转或文本选择
      const target = e.target as HTMLElement;
      if (
        target.tagName === "A" ||
        target.tagName === "BUTTON" ||
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable ||
        target.closest("a") ||
        target.closest("button")
      ) {
        return;
      }
      // 选中文本态：本次点击语义为取消选择（浏览器默认清空选区），不触发翻页/呼出菜单
      if (hasActiveSelectionIn(getSelectionHost?.() ?? null)) return;

      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;

      // 所有格式统一走 App 控件的点击翻页逻辑（屏幕宽度三等分）
      if (readingMode === "horizontal") {
        if (x < rect.width / 3) {
          if (clickTurnPage) onPrevPage();
        } else if (x > (rect.width * 2) / 3) {
          if (clickTurnPage) onNextPage();
        } else {
          // 中间点击：自动滚动时仅停止，不弹出扩展器；非自动滚动时切换UI显隐
          if (autoScroll) {
            setAutoScroll(false);
          } else {
            toggleUi();
          }
        }
      } else {
        // 纵向模式：自动滚动时仅停止，不弹出扩展器；非自动滚动时切换UI显隐
        if (autoScroll) {
          setAutoScroll(false);
        } else {
          toggleUi();
        }
      }
    },
    [
      readingMode,
      clickTurnPage,
      onPrevPage,
      onNextPage,
      autoScroll,
      setAutoScroll,
      toggleUi,
      shouldSuppressClick,
      getSelectionHost,
    ]
  );

  return { handleMainViewClick };
};

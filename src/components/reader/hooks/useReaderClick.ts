import { useCallback } from "react";

interface ReaderClickOptions {
  readingMode: "horizontal" | "vertical" | string;
  clickTurnPage: boolean;
  onPrevPage: () => void;
  onNextPage: () => void;
  autoScroll: boolean;
  setAutoScroll: (active: boolean) => void;
  toggleUi: () => void;
}

/**
 * 这是一个处理阅读器主视图点击事件的 Hook
 * 包含翻页区域判断和交互元素忽略逻辑
 */
export const useReaderClick = ({
  readingMode,
  clickTurnPage,
  onPrevPage,
  onNextPage,
  autoScroll,
  setAutoScroll,
  toggleUi,
}: ReaderClickOptions) => {
  const handleMainViewClick = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
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

      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;

      // 所有格式统一走 App 控件的点击翻页逻辑
      if (readingMode === "horizontal") {
        if (x < rect.width * 0.3) {
          if (clickTurnPage) onPrevPage();
        } else if (x > rect.width * 0.7) {
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
    ]
  );

  return { handleMainViewClick };
};

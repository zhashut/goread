import { useEffect } from "react";
import { RESIZE_DEBOUNCE_MS } from "../../../constants/config";
import { log } from "../../../services";
import { usePageRenderer } from "./usePageRenderer";

type ResizeHandlerProps = {
    data: {
        readingMode: "horizontal" | "vertical";
        currentPage: number;
    };
    actions: {
        forceClearCache: () => void;
        renderPage: ReturnType<typeof usePageRenderer>["renderPage"];
        setVerticalLazyReady: (ready: boolean) => void;
        renderedPagesRef: React.MutableRefObject<Set<number>>;
    };
};

/**
 * 窗口调整处理 Hook
 * 负责：
 * 1. 监听 resize 事件
 * 2. 清理所有缓存（因为窗口大小改变导致位图尺寸失效）
 * 3. 触发重绘（横向立即重绘，纵向重置懒加载）
 */
export const useResizeHandler = ({ data, actions }: ResizeHandlerProps) => {
    const { readingMode, currentPage } = data;
    const {
        forceClearCache,
        renderPage,
        setVerticalLazyReady,
        renderedPagesRef,
    } = actions;

    useEffect(() => {
        let resizeTimer: number | null = null;
        const handleResize = () => {
            if (resizeTimer) window.clearTimeout(resizeTimer);
            resizeTimer = window.setTimeout(() => {
                log("[handleResize] 窗口大小改变，触发重绘以恢复清晰度");

                // 1. 清理所有缓存（确保下次渲染使用适配当前窗口尺寸的新分辨率图片）
                forceClearCache();

                // 2. 根据模式触发重绘
                if (readingMode === "horizontal") {
                    // 横向模式：强制重绘当前页
                    renderPage(currentPage, true);
                } else {
                    // 纵向模式：清理渲染标记，并触发 IntersectionObserver 重新检测渲染
                    renderedPagesRef.current.clear();
                    // 通过重置 verticalLazyReady 状态来重启 Observer
                    setVerticalLazyReady(false);
                    // 延迟重启，确保 DOM 布局更新
                    setTimeout(() => setVerticalLazyReady(true), 50);
                }
            }, RESIZE_DEBOUNCE_MS);
        };

        window.addEventListener("resize", handleResize);
        return () => {
            window.removeEventListener("resize", handleResize);
            if (resizeTimer) window.clearTimeout(resizeTimer);
        };
    }, [
        readingMode,
        currentPage,
        forceClearCache,
        renderPage,
        setVerticalLazyReady,
        renderedPagesRef,
    ]);
};

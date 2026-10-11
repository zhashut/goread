import { useEffect } from "react";
import type { ReaderTheme } from "../../../services";
import { statusBarService } from "../../../services/statusBarService";
import type { StatusBarIconStyle } from "../../../services/statusBarService";
import { READER_PAGE_BACKGROUND, isDarkPageBackground } from "../../../constants/readerTheme";

interface UseReaderStatusBarParams {
    /** 是否显示系统状态栏（阅读设置） */
    showStatusBar: boolean;
    /** 当前生效的阅读主题（含书籍级主题覆盖） */
    theme: ReaderTheme;
    /** 是否有深色浮层（工具栏/目录/模式/更多）盖住状态栏区域 */
    darkChromeVisible: boolean;
}

/**
 * 阅读页状态栏控制
 * 职责：
 * 1. 按阅读设置显示/隐藏系统状态栏；
 * 2. 让状态栏图标颜色与状态栏下方的实际背景一致：
 *    - 深色浮层盖住状态栏时（工具栏、目录、模式、更多）使用浅色图标；
 *    - 纯阅读内容页时由页面底色决定（浅色/护眼底 → 深色图标，深色底 → 浅色图标）；
 * 3. 离开阅读页时恢复「状态栏可见 + 跟随系统」的默认外观，避免影响其它页面。
 */
export const useReaderStatusBar = ({
    showStatusBar,
    theme,
    darkChromeVisible,
}: UseReaderStatusBarParams) => {
    // 状态栏区域的图标明暗：被深色浮层盖住时固定浅色，否则跟随页面底色
    const iconStyle: StatusBarIconStyle = darkChromeVisible
        ? "light"
        : isDarkPageBackground(theme)
            ? "light"
            : "dark";

    // 可见性与图标外观：applySettings 内部会先切换可见性再设置图标
    useEffect(() => {
        statusBarService.applySettings(showStatusBar, iconStyle);
    }, [showStatusBar, iconStyle]);

    // 仅在离开阅读页（卸载）时恢复默认，避免浮层切换时反复重置外观导致闪烁
    useEffect(() => {
        return () => {
            statusBarService.applySettings(true, "system");
        };
    }, []);

    return {
        // 深色浮层已经盖住状态栏区域时不需要再画色条（画了也会被盖住）
        showStatusBarStrip: showStatusBar && !darkChromeVisible,
        // 色条颜色 = 当前阅读主题的页面底色，与内容页保持同色
        pageBackgroundColor: READER_PAGE_BACKGROUND[theme],
    };
};

import { useEffect } from "react";
import { statusBarService } from "../../../services/statusBarService";
import type { StatusBarIconStyle } from "../../../services/statusBarService";
import { isDarkColor } from "../../../constants/readerTheme";

interface UseReaderStatusBarParams {
    /** 是否显示系统状态栏（阅读设置） */
    showStatusBar: boolean;
    /**
     * 让位带（状态栏所在区域）的实际底色
     * 目前等于阅读页页面底色；这里传"颜色"而不是"主题名"，是为了让图标明暗始终由
     * 实际底色决定（格式、浮层、主题映射变化都不会让图标与底色撞色）
     */
    bandBackgroundColor: string;
    /** 是否有深色浮层（工具栏/目录/模式/更多）盖住状态栏区域 */
    darkChromeVisible: boolean;
}

/**
 * 阅读页状态栏控制
 * 职责：
 * 1. 按阅读设置显示/隐藏系统状态栏；
 * 2. 让状态栏图标颜色与状态栏下方的实际底色一致：
 *    - 深色浮层盖住状态栏时（工具栏、目录、模式、更多）使用浅色图标；
 *    - 纯阅读内容页时由让位带实际底色决定（深色底 → 浅色图标，浅色底 → 深色图标）；
 * 3. 离开阅读页时恢复「状态栏可见 + 跟随系统」的默认外观，避免影响其它页面。
 *
 * 注：让位带颜色由调用方（阅读页）根据「紧邻下方的区域」决定，本 Hook 只消费它
 */
export const useReaderStatusBar = ({
    showStatusBar,
    bandBackgroundColor,
    darkChromeVisible,
}: UseReaderStatusBarParams) => {
    // 状态栏区域的图标明暗：被深色浮层盖住时固定浅色，否则跟随让位带底色
    const iconStyle: StatusBarIconStyle = darkChromeVisible
        ? "light"
        : isDarkColor(bandBackgroundColor)
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
    };
};

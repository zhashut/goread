import { useState } from "react";
import { useAppNav } from "../../../router/useAppNav";
import { BookshelfTab } from "../../../types";

/**
 * 管理书架页面核心状态的 Hook
 * 包含：当前标签页、加载状态、搜索关键词等
 */
export const useBookshelfState = () => {
    const nav = useAppNav();

    // 当前标签页由路由驱动（recent / all / nas:<连接id>，其余非法值归一化为 recent）
    const rawTab = nav.currentTab;
    const activeTab = (rawTab === "all" || rawTab.startsWith("nas:") ? rawTab : "recent") as BookshelfTab;

    const [loading, setLoading] = useState(true);
    const [query] = useState("");  // 搜索关键词（预留）

    return {
        nav,
        activeTab,
        loading,
        setLoading,
        query,
    };
};

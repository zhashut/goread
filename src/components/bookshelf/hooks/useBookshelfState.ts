import { useState } from "react";
import { useAppNav } from "../../../router/useAppNav";

/**
 * 管理书架页面核心状态的 Hook
 * 包含：当前标签页、加载状态、菜单状态、搜索关键词等
 */
export const useBookshelfState = () => {
    const nav = useAppNav();

    // 当前标签页由路由驱动
    const activeTab = (nav.currentTab === "all" ? "all" : "recent") as "recent" | "all";

    const [loading, setLoading] = useState(true);
    const [menuOpen, setMenuOpen] = useState(false);
    const [query] = useState("");  // 搜索关键词（预留）

    return {
        nav,
        activeTab,
        loading,
        setLoading,
        menuOpen,
        setMenuOpen,
        query,
    };
};

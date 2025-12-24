import { useState, useEffect, useRef } from "react";
import { useAppNav } from "../../../router/useAppNav";

/**
 * 管理分组详情覆盖层的 Hook
 * 负责覆盖层的打开/关闭状态及与 URL 的同步
 */
export const useGroupOverlay = (activeTab: "recent" | "all") => {
    const nav = useAppNav();

    const [groupOverlayOpen, setGroupOverlayOpen] = useState(false);
    const [overlayGroupId, setOverlayGroupId] = useState<number | null>(null);
    const lastGroupCloseTimeRef = useRef(0);

    // 与 URL 同步分组覆盖层状态
    useEffect(() => {
        // 检查是否有跨页面传递的 Tab 切换请求（例如从导入流程返回时清理了栈）
        const targetTab = sessionStorage.getItem('bookshelf_active_tab');
        if (targetTab && (targetTab === 'recent' || targetTab === 'all')) {
            sessionStorage.removeItem('bookshelf_active_tab');
            if (activeTab !== targetTab) {
                nav.toBookshelf(targetTab as 'recent' | 'all', { replace: true, resetStack: false });
            }
        }

        if (activeTab === "all" && nav.activeGroupId) {
            const idNum = nav.activeGroupId;
            setOverlayGroupId((prevId) => {
                const shouldOpen = !groupOverlayOpen || prevId !== idNum;
                if (shouldOpen) setGroupOverlayOpen(true);
                return idNum;
            });
        } else {
            if (groupOverlayOpen) {
                lastGroupCloseTimeRef.current = Date.now();
            }
            setGroupOverlayOpen(false);
            setOverlayGroupId(null);

        }
    }, [activeTab, nav.activeGroupId]);

    return {
        groupOverlayOpen,
        setGroupOverlayOpen,
        overlayGroupId,
        setOverlayGroupId,
        lastGroupCloseTimeRef,
    };
};

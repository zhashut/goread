import { MutableRefObject } from "react";
import { BookshelfTab } from "../../../types";
import { useDndSensors, useDragGuard, useTabSwipe, isTouchDevice } from "../../../utils/gesture";
import { useAppNav } from "../../../router/useAppNav";

/**
 * 管理拖拽相关手势的 Hook
 * 分组/书籍顺序已改为固定名称 A→Z 排序，不再支持拖拽重排；
 * 保留 DnD 传感器、拖拽守卫与页签滑动切换逻辑
 */
export const useDragSort = (params: {
    activeTab: BookshelfTab;
    selectionMode: boolean;
    groupOverlayOpen: boolean;
    importOpen: boolean;
    /** NAS 连接页签的连接 id 列表（滑动切换页签时用于构建动态序列） */
    nasTabIds?: string[];
    lastGroupCloseTimeRef: MutableRefObject<number>;
}) => {
    const {
        activeTab,
        selectionMode,
        groupOverlayOpen,
        importOpen,
        nasTabIds = [],
        lastGroupCloseTimeRef,
    } = params;

    const nav = useAppNav();

    const { dragActive, onDragStart, onDragEnd, onDragCancel } = useDragGuard();

    // 动态页签序列：最近 → 本地(all) → 各 NAS 连接页签（nas:<id>）
    const tabSequence: BookshelfTab[] = ["recent", "all", ...nasTabIds.map((id): BookshelfTab => `nas:${id}`)];
    const { onTouchStart: swipeTouchStart, onTouchEnd: swipeTouchEnd } = useTabSwipe({
        // 左滑切到右侧下一个页签
        onLeft: () => {
            const idx = tabSequence.indexOf(activeTab);
            const next = idx >= 0 ? tabSequence[idx + 1] : undefined;
            if (next) {
                nav.toBookshelf(next, { replace: true });
            }
        },
        // 右滑切到左侧上一个页签
        onRight: () => {
            const idx = tabSequence.indexOf(activeTab);
            const prev = idx > 0 ? tabSequence[idx - 1] : undefined;
            if (prev) {
                nav.toBookshelf(prev, { replace: true });
            }
        },
        isBlocked: () => dragActive || selectionMode || groupOverlayOpen || importOpen,
        getCooldownTs: () => lastGroupCloseTimeRef.current,
    });

    const sensors = useDndSensors(isTouchDevice());

    return {
        dragActive,
        sensors,
        onDragStart,
        onDragEnd,
        onDragCancel,
        swipeTouchStart,
        swipeTouchEnd,
    };
};

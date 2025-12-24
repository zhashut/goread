import { useState, useEffect, useCallback } from "react";
import { useAppNav } from "../../../router/useAppNav";
import { IBook, IGroup } from "../../../types";

/**
 * 管理选择模式的 Hook
 * 负责书籍/分组的多选逻辑、全选、退出选择模式
 */
export const useSelectionMode = (params: {
    activeTab: "recent" | "all";
    activeGroupId: number | null;
    filteredBooks: IBook[];
    filteredGroups: IGroup[];
}) => {
    const { activeTab, activeGroupId, filteredBooks, filteredGroups } = params;
    const nav = useAppNav();

    // 选择模式状态：由路由 state 驱动
    // 如果当前在分组详情中（activeGroupId 存在），则主列表不应处于选择模式（避免冲突）
    const selectionMode = !!nav.location.state?.selectionMode && !activeGroupId;

    const [selectedBookIds, setSelectedBookIds] = useState<Set<number>>(new Set());
    const [selectedGroupIds, setSelectedGroupIds] = useState<Set<number>>(new Set());

    const selectedCount =
        activeTab === "recent" ? selectedBookIds.size : selectedGroupIds.size;

    const [confirmOpen, setConfirmOpen] = useState(false);

    // 监听 selectionMode 变化以清理状态
    useEffect(() => {
        if (!selectionMode) {
            setSelectedBookIds(new Set());
            setSelectedGroupIds(new Set());
            setConfirmOpen(false);
        }
    }, [selectionMode]);

    // 长按进入选择模式（书籍）
    const onBookLongPress = useCallback((id: number) => {
        if (!selectionMode) {
            nav.toBookshelf(activeTab, { state: { selectionMode: true }, replace: false, resetStack: false });
        }
        setSelectedBookIds((prev) => new Set(prev).add(id));
    }, [selectionMode, activeTab, nav]);

    // 长按进入选择模式（分组）
    const onGroupLongPress = useCallback((id: number) => {
        if (!selectionMode) {
            nav.toBookshelf(activeTab, { state: { selectionMode: true }, replace: false, resetStack: false });
        }
        setSelectedGroupIds((prev) => new Set(prev).add(id));
    }, [selectionMode, activeTab, nav]);

    const exitSelection = useCallback(() => {
        if (selectionMode) {
            nav.goBack();
        }
    }, [selectionMode, nav]);

    const selectAllCurrent = useCallback(() => {
        if (activeTab === "recent") {
            const allIds = new Set((filteredBooks || []).map((b) => b.id));
            const isAllSelected =
                selectedBookIds.size === allIds.size && allIds.size > 0;
            setSelectedBookIds(isAllSelected ? new Set() : allIds);
        } else {
            const allIds = new Set((filteredGroups || []).map((g) => g.id));
            const isAllSelected =
                selectedGroupIds.size === allIds.size && allIds.size > 0;
            setSelectedGroupIds(isAllSelected ? new Set() : allIds);
        }
    }, [activeTab, filteredBooks, filteredGroups, selectedBookIds.size, selectedGroupIds.size]);

    const toggleBookSelection = useCallback((bookId: number) => {
        setSelectedBookIds((prev) => {
            const next = new Set(prev);
            if (next.has(bookId)) next.delete(bookId);
            else next.add(bookId);
            return next;
        });
    }, []);

    const toggleGroupSelection = useCallback((groupId: number) => {
        setSelectedGroupIds((prev) => {
            const next = new Set(prev);
            if (next.has(groupId)) next.delete(groupId);
            else next.add(groupId);
            return next;
        });
    }, []);

    return {
        selectionMode,
        selectedBookIds,
        setSelectedBookIds,
        selectedGroupIds,
        setSelectedGroupIds,
        selectedCount,
        confirmOpen,
        setConfirmOpen,
        onBookLongPress,
        onGroupLongPress,
        exitSelection,
        selectAllCurrent,
        toggleBookSelection,
        toggleGroupSelection,
    };
};

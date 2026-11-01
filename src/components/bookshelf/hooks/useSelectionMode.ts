import { useState, useEffect, useCallback } from "react";
import { useAppNav } from "../../../router/useAppNav";
import { IBook, IGroup, BookshelfTab } from "../../../types";

/**
 * 管理选择模式的 Hook
 * 负责书籍/分组的多选逻辑、全选、退出选择模式
 */
export const useSelectionMode = (params: {
    activeTab: BookshelfTab;
    activeGroupId: number | null;
    filteredBooks: IBook[];
    filteredGroups: IGroup[];
    /** 「全部」选项卡书架根目录的未分组书籍（参与全选计数） */
    filteredUngroupedBooks?: IBook[];
}) => {
    const { activeTab, activeGroupId, filteredBooks, filteredGroups, filteredUngroupedBooks } = params;
    const nav = useAppNav();

    // 选择模式状态：由路由 state 驱动
    // 如果当前在分组详情中（activeGroupId 存在），则主列表不应处于选择模式（避免冲突）
    const selectionMode = !!nav.location.state?.selectionMode && !activeGroupId;

    const [selectedBookIds, setSelectedBookIds] = useState<Set<number>>(new Set());
    const [selectedGroupIds, setSelectedGroupIds] = useState<Set<number>>(new Set());

    // 「全部」选项卡同时呈现分组与根目录书籍，计数为两者之和；其余页签仅统计书籍
    const selectedCount =
        activeTab === "all"
            ? selectedGroupIds.size + selectedBookIds.size
            : selectedBookIds.size;

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
            // 「全部」选项卡：分组与根目录未分组书籍一并全选
            const allGroupIds = new Set((filteredGroups || []).map((g) => g.id));
            const allBookIds = new Set((filteredUngroupedBooks || []).map((b) => b.id));
            const allCount = allGroupIds.size + allBookIds.size;
            const selCount = selectedGroupIds.size + selectedBookIds.size;
            const isAllSelected = selCount === allCount && allCount > 0;
            if (isAllSelected) {
                setSelectedGroupIds(new Set());
                setSelectedBookIds(new Set());
            } else {
                setSelectedGroupIds(allGroupIds);
                setSelectedBookIds(allBookIds);
            }
        }
    }, [activeTab, filteredBooks, filteredGroups, filteredUngroupedBooks, selectedBookIds.size, selectedGroupIds.size]);

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

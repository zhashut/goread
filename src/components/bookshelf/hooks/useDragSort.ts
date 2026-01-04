import { useCallback, Dispatch, SetStateAction, MutableRefObject } from "react";
import { DragEndEvent } from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import { IBook, IGroup } from "../../../types";
import { bookService, groupService } from "../../../services";
import { useDndSensors, useDragGuard, useTabSwipe, isTouchDevice } from "../../../utils/gesture";
import { useAppNav } from "../../../router/useAppNav";

/**
 * 管理拖拽排序的 Hook
 * 负责书籍和分组的拖拽排序、顺序持久化、手势处理
 */
export const useDragSort = (params: {
    activeTab: "recent" | "all";
    books: IBook[];
    setBooks: Dispatch<SetStateAction<IBook[]>>;
    groups: IGroup[];
    setGroups: Dispatch<SetStateAction<IGroup[]>>;
    selectionMode: boolean;
    groupOverlayOpen: boolean;
    menuOpen: boolean;
    importOpen: boolean;
    lastGroupCloseTimeRef: MutableRefObject<number>;
}) => {
    const {
        activeTab,
        books,
        setBooks,
        groups,
        setGroups,
        selectionMode,
        groupOverlayOpen,
        menuOpen,
        importOpen,
        lastGroupCloseTimeRef,
    } = params;

    const nav = useAppNav();

    const { dragActive, onDragStart, onDragEnd: onDragEndGuard, onDragCancel } = useDragGuard();

    const { onTouchStart: swipeTouchStart, onTouchEnd: swipeTouchEnd } = useTabSwipe({
        onLeft: () => {
            if (activeTab === "recent") {
                nav.toBookshelf("all", { replace: true });
            }
        },
        onRight: () => {
            if (activeTab === "all") {
                nav.toBookshelf("recent", { replace: true });
            }
        },
        isBlocked: () => dragActive || selectionMode || groupOverlayOpen || menuOpen || importOpen,
        getCooldownTs: () => lastGroupCloseTimeRef.current,
    });

    const sensors = useDndSensors(isTouchDevice());

    const handleDragEnd = useCallback(async (event: DragEndEvent) => {
        const { active, over } = event;
        if (!over || active.id === over.id) return;

        if (activeTab === "recent") {
            const oldIndex = books.findIndex((b) => b.id === active.id);
            const newIndex = books.findIndex((b) => b.id === over.id);
            const newItems = arrayMove(books, oldIndex, newIndex);

            // 立即更新UI
            setBooks(newItems);

            // 调用后端API持久化排序
            try {
                await bookService.reorderRecentBooks(newItems.map((b) => b.id));
            } catch (e) {
                console.error("Failed to reorder recent books", e);
            }
        } else {
            const oldIndex = groups.findIndex((g) => g.id === active.id);
            const newIndex = groups.findIndex((g) => g.id === over.id);
            const newItems = arrayMove(groups, oldIndex, newIndex);

            // 立即更新UI
            setGroups(newItems);

            // 调用后端API持久化排序
            try {
                await groupService.reorderGroups(newItems.map((g) => g.id));
            } catch (e) {
                console.error("Failed to reorder groups", e);
            }
        }
    }, [activeTab, books, groups, setBooks, setGroups]);

    return {
        dragActive,
        sensors,
        onDragStart,
        onDragEnd: (e: DragEndEvent) => {
            onDragEndGuard();
            handleDragEnd(e);
        },
        onDragCancel,
        swipeTouchStart,
        swipeTouchEnd,
    };
};

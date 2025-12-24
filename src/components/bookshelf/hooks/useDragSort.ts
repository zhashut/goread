import { useCallback, Dispatch, SetStateAction, MutableRefObject } from "react";
import { DragEndEvent } from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import { IBook, IGroup } from "../../../types";
import { bookService } from "../../../services";
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

            setBooks(newItems);
            localStorage.setItem(
                "recent_books_order",
                JSON.stringify(newItems.map((b) => b.id))
            );

            // 同步更新数据库 last_read_time，确保 Limit 限制后顺序依然正确
            try {
                const updates: [number, number][] = [];
                // 确定起始时间约束
                // 如果是第一项，使用当前时间（秒）
                // 如果不是第一项，使用前一项的时间 - 1
                let constraintTime = Math.floor(Date.now() / 1000);

                if (newIndex > 0) {
                    const prevBook = newItems[newIndex - 1];
                    constraintTime = (prevBook.last_read_time || 0) - 1;
                } else {
                    // 如果是第一项，确保比第二项大（如果有第二项）
                    if (newItems.length > 1) {
                        const secondBook = newItems[1];
                        const secondTime = secondBook.last_read_time || 0;
                        if (constraintTime <= secondTime) {
                            constraintTime = secondTime + 1;
                        }
                    }
                }

                // 从被移动的项开始，向后检查并更新时间
                // 必须保证严格降序：time[i] < time[i-1]
                let currentMax = constraintTime;

                for (let i = newIndex; i < newItems.length; i++) {
                    const book = newItems[i];
                    const bookTime = book.last_read_time || 0;

                    // 如果当前书的时间违反约束（比允许的最大值大），或者它是被移动的书（必须更新以反映新位置）
                    if (bookTime > currentMax || i === newIndex) {
                        updates.push([book.id, currentMax]);
                        // 更新本地状态中的时间，以便后续计算正确（虽然不直接影响 React 渲染，因为已经 setBooks）
                        book.last_read_time = currentMax;
                        currentMax--;
                    } else {
                        // 如果当前书的时间满足约束（<= currentMax），则不需要更新它
                        // 但下一本书的约束变为当前书的时间 - 1
                        currentMax = bookTime - 1;
                    }
                }

                if (updates.length > 0) {
                    await bookService.updateBooksLastReadTime(updates);
                    // 更新本地状态中的时间，防止刷新后跳变
                    setBooks(prev => prev.map(b => {
                        const up = updates.find(u => u[0] === b.id);
                        if (up) return { ...b, last_read_time: up[1] };
                        return b;
                    }));
                }
            } catch (e) {
                console.error("Failed to sync drag order to DB", e);
            }

        } else {
            setGroups((items) => {
                const oldIndex = items.findIndex((g) => g.id === active.id);
                const newIndex = items.findIndex((g) => g.id === over.id);
                const newItems = arrayMove(items, oldIndex, newIndex);
                localStorage.setItem(
                    "groups_order",
                    JSON.stringify(newItems.map((g) => g.id))
                );
                return newItems;
            });
        }
    }, [activeTab, books, setBooks, setGroups]);

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

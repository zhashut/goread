import React, { useEffect, useState, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  rectSortingStrategy,
} from "@dnd-kit/sortable";
import { IBook } from "../types";
import { CARD_MIN_WIDTH, GRID_GAP_GROUP_DETAIL } from "../constants/ui";
import { groupService, bookService } from "../services";
import { SortableBookItem } from "./SortableBookItem";
import ConfirmDeleteDrawer from "./ConfirmDeleteDrawer";

// 使用 dnd-kit 实现拖拽排序

export const GroupDetail: React.FC<{
  groupIdProp?: number;
  onClose?: () => void;
}> = ({ groupIdProp, onClose }) => {
  const navigate = useNavigate();
  const { groupId } = useParams();
  const id = typeof groupIdProp === "number" ? groupIdProp : Number(groupId);
  const [books, setBooks] = useState<IBook[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedBookIds, setSelectedBookIds] = useState<Set<number>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const booksRef = useRef<IBook[]>([]);
  const selectedRef = useRef<Set<number>>(new Set());

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  useEffect(() => {
    const run = async () => {
      try {
        setLoading(true);
        const list = await groupService.getBooksByGroup(id);
        setBooks(list || []);
      } catch (e) {
        setBooks([]);
      } finally {
        setLoading(false);
      }
    };
    run();
  }, [id]);

  useEffect(() => {
    booksRef.current = books;
  }, [books]);

  useEffect(() => {
    selectedRef.current = new Set(selectedBookIds);
  }, [selectedBookIds]);

  // Refs for back button handling - use useRef to avoid stale closure
  const popStateRef = useRef({
    confirmOpen,
    selectionMode,
  });

  // Keep ref in sync with state
  useEffect(() => {
    popStateRef.current = {
      confirmOpen,
      selectionMode,
    };
  }, [confirmOpen, selectionMode]);

  // Handle back button / swipe gesture - only when used as standalone route (no onClose prop)
  useEffect(() => {
    // Skip if used as overlay (has onClose prop) - Bookshelf handles popstate in that case
    if (onClose) return;
    
    const handlePopState = (e: PopStateEvent) => {
      e.preventDefault();
      window.history.pushState(null, "", window.location.href);

      const currentState = popStateRef.current;

      // Close overlays/selection mode in priority order
      if (currentState.confirmOpen) {
        setConfirmOpen(false);
        return;
      }
      if (currentState.selectionMode) {
        setSelectionMode(false);
        setSelectedBookIds(new Set());
        return;
      }

      // No overlay open, navigate back to bookshelf
      navigate("/?tab=all", { replace: true });
    };

    window.history.pushState(null, "", window.location.href);
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [navigate, onClose]);

  const reloadBooksAndGroups = async () => {
    const list = await groupService.getBooksByGroup(id);
    setBooks(list || []);
    // 通知首页分组数据已变更（用于刷新封面与计数）
    try {
      window.dispatchEvent(new CustomEvent("goread:groups:changed"));
      window.dispatchEvent(new CustomEvent("goread:books:changed"));
    } catch {}
    const allGroups = await groupService.getAllGroups();
    const g = (allGroups || []).find((x) => x.id === id) || null;
    if (!g || (list || []).length === 0) {
      onClose?.();
    }
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      setBooks((items) => {
        const oldIndex = items.findIndex((b) => b.id === active.id);
        const newIndex = items.findIndex((b) => b.id === over.id);
        const newItems = arrayMove(items, oldIndex, newIndex);
        
        // 异步保存顺序
        groupService.reorderGroupBooks(id, newItems.map((b) => b.id))
          .then(() => {
            // 通知外部更新分组封面（因为前4本书可能变了）
            window.dispatchEvent(new CustomEvent("goread:groups:changed"));
          })
          .catch(console.warn);
        
        return newItems;
      });
    }
  };

  const exitSelection = () => {
    setSelectionMode(false);
    setSelectedBookIds(new Set());
    setConfirmOpen(false);
  };

  const onBookLongPress = (id: number) => {
    setSelectionMode(true);
    setSelectedBookIds((prev) => new Set(prev).add(id));
  };

  const toggleSelectBook = (id: number) => {
    setSelectedBookIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    const currentBooks = booksRef.current || [];
    const allIds = new Set(currentBooks.map((b) => b.id));
    const isAllSelected = selectedRef.current.size === allIds.size && allIds.size > 0;
    setSelectedBookIds(isAllSelected ? new Set() : allIds);
    if (!selectionMode && allIds.size > 0) setSelectionMode(true);
  };

  const confirmDelete = async () => {
    try {
      const ids = Array.from(selectedBookIds);
      for (const bid of ids) {
        await bookService.deleteBook(bid);
      }
      await reloadBooksAndGroups();
      exitSelection();
    } catch {
      alert("删除失败，请重试");
    }
  };

  useEffect(() => {
    try {
      const evt = new CustomEvent("goread:group-detail:selection", {
        detail: { active: selectionMode, count: selectedBookIds.size },
      });
      window.dispatchEvent(evt);
    } catch {}
  }, [selectionMode, selectedBookIds]);

  useEffect(() => {
    const onExit = () => exitSelection();
    const onOpenConfirm = () => setConfirmOpen(true);
    const onSelectAll = () => selectAll();
    window.addEventListener("goread:group-detail:exit-selection", onExit as any);
    window.addEventListener("goread:group-detail:open-confirm", onOpenConfirm as any);
    window.addEventListener("goread:group-detail:select-all", onSelectAll as any);
    return () => {
      window.removeEventListener(
        "goread:group-detail:exit-selection",
        onExit as any
      );
      window.removeEventListener(
        "goread:group-detail:open-confirm",
        onOpenConfirm as any
      );
      window.removeEventListener(
        "goread:group-detail:select-all",
        onSelectAll as any
      );
    };
  }, []);

  const handleDeleteInGroup = async (book: IBook) => {
    try {
      let ok: boolean = false;
      try {
        const { confirm } = await import("@tauri-apps/plugin-dialog");
        ok = await confirm("确认删除该书籍及其书签？", { title: "goread" });
      } catch {
        ok = window.confirm("确认删除该书籍及其书签？");
      }
      if (!ok) return;
      await bookService.deleteBook(book.id);
      await reloadBooksAndGroups();
    } catch (err) {
      console.error("删除失败", err);
      alert("删除书籍失败，请重试");
    }
  };

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        backgroundColor: "#f7f7f7",
        borderRadius: 0,
        boxShadow: "0 12px 40px rgba(0,0,0,0.18)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {loading ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flex: 1,
            color: "#666",
          }}
        >
          加载中…
        </div>
      ) : books.length === 0 ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flex: 1,
            color: "#999",
          }}
        >
          该分组暂无书籍
        </div>
      ) : (
          <div
            className="no-scrollbar"
            style={{
              flex: 1,
              overflowY: "auto",
              padding: "16px 8px 16px 16px",
            }}
          >
            <div
              style={{
                display: "grid",
                // 响应式列宽
              gridTemplateColumns: `repeat(auto-fill, minmax(${CARD_MIN_WIDTH}px, 1fr))`,
              gap: GRID_GAP_GROUP_DETAIL + "px",
              alignContent: "start",
              gridAutoRows: "min-content",
            }}
          >
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={books.map((b) => b.id)}
              strategy={rectSortingStrategy}
            >
              {books.map((b) => (
                <SortableBookItem
                  width="100%"
                  key={b.id}
                  id={b.id}
                  book={b}
                  onClick={() => {
                    try {
                      const orderStr = localStorage.getItem("recent_books_order");
                      let order: number[] = [];
                      if (orderStr) {
                        try {
                          const parsed = JSON.parse(orderStr);
                          if (Array.isArray(parsed)) order = parsed;
                        } catch {}
                      }
                      order = order.filter((oid) => oid !== b.id);
                      order.unshift(b.id);
                      localStorage.setItem("recent_books_order", JSON.stringify(order));
                    } catch (e) {
                      console.error("Failed to update recent order", e);
                    }
                    navigate(`/reader/${b.id}`, { state: { fromGroupId: id } });
                  }}
                  onLongPress={() => onBookLongPress(b.id)}
                  selectable={selectionMode}
                  selected={selectedBookIds.has(b.id)}
                  onToggleSelect={() => toggleSelectBook(b.id)}
                  onDelete={() => handleDeleteInGroup(b)}
                />
              ))}
            </SortableContext>
          </DndContext>
          </div>
        </div>
      )}
      <ConfirmDeleteDrawer
        open={confirmOpen}
        context="group-detail"
        count={selectedBookIds.size}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => confirmDelete()}
      />
    </div>
  );
};

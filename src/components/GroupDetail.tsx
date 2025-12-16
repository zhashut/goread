import React, { useEffect, useState, useRef, useLayoutEffect } from "react";
import { useParams, useNavigate, useNavigationType } from "react-router-dom";
import { useAppNav } from "../router/useAppNav";
import { DndContext, closestCenter, DragEndEvent } from "@dnd-kit/core";
import { arrayMove, SortableContext, rectSortingStrategy } from "@dnd-kit/sortable";
import { IBook } from "../types";
import { CARD_MIN_WIDTH, GRID_GAP_GROUP_DETAIL } from "../constants/ui";
import { groupService, bookService } from "../services";
import { SortableBookItem } from "./SortableBookItem";
import ConfirmDeleteDrawer from "./ConfirmDeleteDrawer";
import ChooseExistingGroupDrawer from "./ChooseExistingGroupDrawer";
import { loadGroupsWithPreviews } from "../utils/groupImport";
import { useDndSensors, useDragGuard, isTouchDevice } from "../utils/gesture";

// 使用 dnd-kit 实现拖拽排序

export const GroupDetail: React.FC<{
  groupIdProp?: number;
  onClose?: () => void;
}> = ({ groupIdProp, onClose }) => {
  const { groupId } = useParams();
  const navigate = useNavigate();
  const navType = useNavigationType();
  const nav = useAppNav();
  const id = typeof groupIdProp === "number" ? groupIdProp : Number(groupId);
  const [books, setBooks] = useState<IBook[]>([]);
  const [loading, setLoading] = useState(true);

  // 滚动位置恢复相关
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const hasRestored = useRef(false);
  const shouldRestore = useRef(false);
  const KEY = `group.scroll.${id}`;

  // 决策阶段：根据导航类型决定是恢复还是清除
  useLayoutEffect(() => {
    // POP 通常意味着“返回”或“刷新”，此时应尝试恢复
    if (navType === "POP") {
      shouldRestore.current = true;
    } else {
      // PUSH / REPLACE 意味着新进入（或进入选择模式），清除旧记录以重置
      // 注意：进入选择模式(PUSH)时也会清除，但这不影响当前DOM位置，且goToReader会重新保存
      sessionStorage.removeItem(KEY);
      shouldRestore.current = false;
    }
  }, [KEY, navType]);

  // 执行阶段：在挂载/数据加载后恢复滚动
  useLayoutEffect(() => {
    // 如果不该恢复、数据为空或已恢复过，不再执行
    if (!shouldRestore.current || books.length === 0 || hasRestored.current) return;

    const saved = Number(sessionStorage.getItem(KEY) || 0);
    const el = scrollRef.current;
    if (!el) return;

    // 确保不越界
    const max = Math.max(0, el.scrollHeight - el.clientHeight);
    el.scrollTop = Math.max(0, Math.min(saved, max));

    hasRestored.current = true;
  }, [KEY, books.length]);

  // 进入阅读页前显式保存
  const goToReader = (b: IBook) => {
    const el = scrollRef.current;
    if (el) sessionStorage.setItem(KEY, String(el.scrollTop));
    nav.toReader(b.id, { fromGroupId: id });
  };
  
  // 选择模式状态：由路由 state 驱动
  const selectionMode = !!nav.location.state?.selectionMode;

  const [selectedBookIds, setSelectedBookIds] = useState<Set<number>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  
  // 移动分组相关状态
  const [moveDrawerOpen, setMoveDrawerOpen] = useState(false);
  const [allGroups, setAllGroups] = useState<any[]>([]);
  const [groupPreviews, setGroupPreviews] = useState<Record<number, string[]>>({});

  const booksRef = useRef<IBook[]>([]);
  const selectedRef = useRef<Set<number>>(new Set());

  const sensors = useDndSensors(isTouchDevice());
  const { dragActive, onDragStart, onDragEnd: onDragEndGuard, onDragCancel } = useDragGuard();

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
    if (!selectionMode) return;
    // 使用路由回退退出选择模式；与系统返回键/手势保持一致
    nav.goBack();
  };

  // 监听 selectionMode 变化以清理状态
  useEffect(() => {
    if (!selectionMode) {
      setSelectedBookIds(new Set());
      setConfirmOpen(false);
    }
  }, [selectionMode]);

  const onBookLongPress = (id: number) => {
    if (!selectionMode) {
      // 进入选择模式：使用完整路径 + 当前查询参数，确保生成历史栈条目
      navigate(`${nav.location.pathname}${nav.location.search}`,
        { state: { selectionMode: true }, replace: false }
      );
    }
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
    if (!selectionMode && allIds.size > 0) {
      // 进入选择模式：使用完整路径 + 当前查询参数，确保生成历史栈条目
      navigate(`${nav.location.pathname}${nav.location.search}`,
        { state: { selectionMode: true }, replace: false }
      );
    }
  };

  const confirmDelete = async (deleteLocal?: boolean) => {
    try {
      const ids = Array.from(selectedBookIds);
      for (const bid of ids) {
        await bookService.deleteBook(bid, !!deleteLocal);
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
    const onOpenMove = () => openMoveDrawer();
    window.addEventListener("goread:group-detail:exit-selection", onExit as any);
    window.addEventListener("goread:group-detail:open-confirm", onOpenConfirm as any);
    window.addEventListener("goread:group-detail:select-all", onSelectAll as any);
    window.addEventListener("goread:group-detail:open-move", onOpenMove as any);
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
      window.removeEventListener(
        "goread:group-detail:open-move",
        onOpenMove as any
      );
    };
  }, []);

  const openMoveDrawer = async () => {
    try {
      // 加载分组数据（排除当前分组）
      const { groups: loadedGroups, previews } = await loadGroupsWithPreviews();
      // 过滤掉当前分组
      const validGroups = loadedGroups.filter(g => g.id !== id);
      
      setAllGroups(validGroups);
      setGroupPreviews(previews);
      setMoveDrawerOpen(true);
    } catch (e) {
      console.error("加载分组失败", e);
      alert("无法加载分组列表");
    }
  };

  const handleMoveBooks = async (targetGroupId: number) => {
    try {
      const ids = Array.from(selectedBookIds);
      // 1. 移动书籍
      for (const bid of ids) {
        await groupService.moveBookToGroup(bid, targetGroupId);
      }

      // 2. 排序：将移动的书籍放在目标分组最前
      // 获取目标分组当前书籍
      const targetBooks = await groupService.getBooksByGroup(targetGroupId);
      const targetBookIds = targetBooks.map((b) => b.id);
      
      // 保持源分组中的相对顺序
      const currentBooks = booksRef.current || [];
      const movedIdsOrdered = currentBooks
        .filter((b) => selectedBookIds.has(b.id))
        .map((b) => b.id);
        
      // 过滤出目标分组中原有的书籍（不包含这次移动的）
      const restIds = targetBookIds.filter((bid) => !selectedBookIds.has(bid));
      
      const newOrder = [...movedIdsOrdered, ...restIds];
      
      await groupService.reorderGroupBooks(targetGroupId, newOrder);

      // 3. 刷新与退出
      await reloadBooksAndGroups();
      exitSelection();
      setMoveDrawerOpen(false);
      
    } catch (e) {
      console.error("移动书籍失败", e);
      alert("移动失败，请重试");
    }
  };

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
            ref={scrollRef}
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
            onDragStart={onDragStart}
            onDragEnd={(e) => {
              onDragEndGuard();
              handleDragEnd(e);
            }}
            onDragCancel={onDragCancel}
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
                    if (selectionMode) {
                      toggleSelectBook(b.id);
                      return;
                    }
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
                      console.error("更新最近阅读顺序失败", e);
                    }
                    goToReader(b);
                  }}
                  onLongPress={() => onBookLongPress(b.id)}
                  selectable={selectionMode}
                  selected={selectedBookIds.has(b.id)}
                  onToggleSelect={() => toggleSelectBook(b.id)}
                  onDelete={() => {
                    if (dragActive) return;
                    handleDeleteInGroup(b);
                  }}
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
        onConfirm={(deleteLocal) => confirmDelete(deleteLocal)}
      />
      <ChooseExistingGroupDrawer
        open={moveDrawerOpen}
        groups={allGroups}
        groupPreviews={groupPreviews}
        onClose={() => setMoveDrawerOpen(false)}
        onSelectGroup={handleMoveBooks}
        title="移动到分组"
      />
    </div>
  );
};

import React, { useEffect, useState, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { IBook } from "../types";
import { CARD_WIDTH_COMPACT, GRID_GAP_GROUP_DETAIL } from "../constants/ui";
import { groupService, bookService } from "../services";
import { BookCard } from "./BookCard";
import ConfirmDeleteDrawer from "./ConfirmDeleteDrawer";

// 使用通用 BookCard 组件替换内联实现

export const GroupDetail: React.FC<{
  groupIdProp?: number;
  onClose?: () => void;
}> = ({ groupIdProp, onClose }) => {
  const navigate = useNavigate();
  const { groupId } = useParams();
  const id = typeof groupIdProp === "number" ? groupIdProp : Number(groupId);
  const [books, setBooks] = useState<IBook[]>([]);
  const [loading, setLoading] = useState(true);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedBookIds, setSelectedBookIds] = useState<Set<number>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const booksRef = useRef<IBook[]>([]);
  const selectedRef = useRef<Set<number>>(new Set());

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
          style={{
            width: "100%",
            padding: "12px 16px 16px",
            display: "grid",
            // 固定列宽，避免第一列过宽导致卡片居中偏移
            gridTemplateColumns: "repeat(auto-fill, " + CARD_WIDTH_COMPACT + "px)",
            gap: GRID_GAP_GROUP_DETAIL + "px",
            // 卡片在栅格单元内靠左对齐
            justifyItems: "start",
            justifyContent: "start",
            alignContent: "start",
          }}
        >
          {books.map((b, idx) => (
            <BookCard
              key={b.id}
              book={b}
              onClick={() =>
                navigate(`/reader/${b.id}`, { state: { fromGroupId: id } })
              }
              onLongPress={() => onBookLongPress(b.id)}
              selectable={selectionMode}
              selected={selectedBookIds.has(b.id)}
              onToggleSelect={() => toggleSelectBook(b.id)}
              draggable
              onDragStart={(e) => {
                setDragIndex(idx);
                e.dataTransfer.setData("text/plain", String(idx));
                e.stopPropagation();
              }}
              onDragOver={(e) => {
                e.preventDefault();
              }}
              onDrop={async (e) => {
                e.preventDefault();
                e.stopPropagation();
                const from =
                  dragIndex ?? Number(e.dataTransfer.getData("text/plain"));
                const to = idx;
                if (isNaN(from) || from === to) return;
                const next = books.slice();
                const [moved] = next.splice(from, 1);
                next.splice(to, 0, moved);
                setBooks(next);
                try {
                  const orderedIds = next.map((x) => x.id);
                  await groupService.reorderGroupBooks(id, orderedIds);
                } catch (err) {
                  console.warn("Reorder failed", err);
                } finally {
                  setDragIndex(null);
                }
              }}
              onDelete={() => handleDeleteInGroup(b)}
            />
          ))}
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

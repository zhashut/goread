import React, { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { IBook, IGroup } from "../types";
import { CARD_WIDTH_COMPACT, COVER_ASPECT_RATIO_COMPACT, BOOK_TITLE_FONT_SIZE, GRID_GAP_GROUP_DETAIL } from "../constants/ui";
import { groupService, bookService } from "../services";
import { BookCard } from "./BookCard";

// 使用通用 BookCard 组件替换内联实现

export const GroupDetail: React.FC<{
  groupIdProp?: number;
  onClose?: () => void;
}> = ({ groupIdProp, onClose }) => {
  const navigate = useNavigate();
  const { groupId } = useParams();
  const id = typeof groupIdProp === "number" ? groupIdProp : Number(groupId);
  const [group, setGroup] = useState<IGroup | null>(null);
  const [books, setBooks] = useState<IBook[]>([]);
  const [loading, setLoading] = useState(true);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  useEffect(() => {
    const run = async () => {
      try {
        setLoading(true);
        const allGroups = await groupService.getAllGroups();
        const g = (allGroups || []).find((x) => x.id === id) || null;
        setGroup(g);
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

  const reloadBooksAndGroups = async () => {
    const allGroups = await groupService.getAllGroups();
    const g = (allGroups || []).find((x) => x.id === id) || null;
    setGroup(g);
    const list = await groupService.getBooksByGroup(id);
    setBooks(list || []);
    // 通知首页分组数据已变更（用于刷新封面与计数）
    try {
      window.dispatchEvent(new CustomEvent("goread:groups:changed"));
      window.dispatchEvent(new CustomEvent("goread:books:changed"));
    } catch {}
    if (!g || (list || []).length === 0) {
      onClose?.();
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
          style={{
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
    </div>
  );
};

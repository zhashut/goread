import React, {
  useState,
  useEffect,
  useMemo,
  useRef,
  useLayoutEffect,
} from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { IBook, IGroup } from "../types";
import {
  GRID_GAP_BOOK_CARDS,
  GRID_GAP_GROUP_ROW,
  GRID_GAP_GROUP_COLUMN,
  GROUP_NAME_FONT_SIZE,
  GROUP_META_FONT_SIZE,
  GROUP_NAME_FONT_WEIGHT,
  CARD_INFO_MARGIN_TOP,
  GROUP_NAME_MARGIN_TOP,
  GROUP_META_MARGIN_TOP,
} from "../constants/ui";
import { bookService, groupService, getReaderSettings } from "../services";
import { GroupDetail } from "./GroupDetail";
import { BookCard } from "./BookCard";
import GroupCoverGrid from "./GroupCoverGrid";
import ImportProgressDrawer from "./ImportProgressDrawer";
import ConfirmDeleteDrawer from "./ConfirmDeleteDrawer";

// 使用通用 BookCard 组件

export const Bookshelf: React.FC = () => {
  const location = useLocation();
  const [books, setBooks] = useState<IBook[]>([]);
  const [groups, setGroups] = useState<IGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"recent" | "all">(() => {
    const search =
      typeof window !== "undefined" ? window.location.search : location.search;
    const params = new URLSearchParams(search || "");
    return params.get("tab") === "all" ? "all" : "recent";
  });

  // Sync tab with URL when it changes; also optionally open group overlay via query param
  useEffect(() => {
    const params = new URLSearchParams(location.search || "");
    const next = params.get("tab") === "all" ? "all" : "recent";
    setActiveTab((prev) => (prev === next ? prev : next));
    const groupParam = params.get("group");
    if (next === "all" && groupParam) {
      const idNum = Number(groupParam);
      if (!isNaN(idNum)) {
        // Only open if not already open or id changed
        setOverlayGroupId((prevId) => {
          const shouldOpen = !groupOverlayOpen || prevId !== idNum;
          if (shouldOpen) setGroupOverlayOpen(true);
          return idNum;
        });
      }
    }
  }, [location.search]);
  const [query] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ left: number; top: number }>({
    left: 0,
    top: 0,
  });
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuBtnRef = useRef<HTMLButtonElement | null>(null);
  // tabs underline animation
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const recentLabelRef = useRef<HTMLDivElement | null>(null);
  const allLabelRef = useRef<HTMLDivElement | null>(null);
  const [underlinePos, setUnderlinePos] = useState<{
    left: number;
    width: number;
  }>({ left: 0, width: 0 });
  const [animateUnderline, setAnimateUnderline] = useState(false);
  const [underlineReady, setUnderlineReady] = useState(false);
  const navigate = useNavigate();
  const [groupOverlayOpen, setGroupOverlayOpen] = useState(false);
  const [overlayGroupId, setOverlayGroupId] = useState<number | null>(null);

  // 选择模式状态
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedBookIds, setSelectedBookIds] = useState<Set<number>>(
    new Set()
  );
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<number>>(
    new Set()
  );
  const selectedCount =
    activeTab === "recent" ? selectedBookIds.size : selectedGroupIds.size;
  const [confirmOpen, setConfirmOpen] = useState(false);

  // 导入进度抽屉状态
  const [importOpen, setImportOpen] = useState(false);
  const [importTotal, setImportTotal] = useState(0);
  const [importCurrent, setImportCurrent] = useState(0);
  const [importTitle, setImportTitle] = useState("");

  useEffect(() => {
    loadBooks();
    loadGroups();
  }, []);

  // 监听分组详情页的删除事件，及时刷新“最近”
  useEffect(() => {
    const onChanged = () => {
      loadBooks();
    };
    window.addEventListener("goread:books:changed", onChanged as any);
    return () =>
      window.removeEventListener("goread:books:changed", onChanged as any);
  }, []);

  // 监听分组变化事件，刷新分组列表与封面
  useEffect(() => {
    const onGroupsChanged = () => {
      loadGroups();
    };
    window.addEventListener("goread:groups:changed", onGroupsChanged as any);
    return () =>
      window.removeEventListener(
        "goread:groups:changed",
        onGroupsChanged as any
      );
  }, []);

  // 监听导入事件：开始 / 进度 / 完成 / 取消
  useEffect(() => {
    const onStart = (e: any) => {
      const detail = e?.detail || {};
      setImportTotal(detail.total || 0);
      setImportCurrent(0);
      setImportTitle(detail.title || "");
      setImportOpen(true);
      // 不再记录打开时间，移除最短展示时长逻辑
      // 保持在“全部”标签
      setActiveTab("all");
    };
    const onProgress = (e: any) => {
      const detail = e?.detail || {};
      setImportCurrent(detail.current || 0);
      if (detail.title) setImportTitle(detail.title);
    };
    const onDone = (_e: any) => {
      // 立即关闭进度抽屉，无人工延时
      setImportOpen(false);
      setImportTitle("");
      setImportTotal(0);
      setImportCurrent(0);
      loadGroups();
      loadBooks();
    };
    window.addEventListener("goread:import:start", onStart as any);
    window.addEventListener("goread:import:progress", onProgress as any);
    window.addEventListener("goread:import:done", onDone as any);
    return () => {
      window.removeEventListener("goread:import:start", onStart as any);
      window.removeEventListener("goread:import:progress", onProgress as any);
      window.removeEventListener("goread:import:done", onDone as any);
    };
  }, []);

  const loadBooks = async () => {
    try {
      setLoading(true);
      await bookService.initDatabase();
      const settings = getReaderSettings();
      const recentCount = Math.max(1, settings.recentDisplayCount || 9);
      let list: IBook[] = [];
      try {
        const recent = await bookService.getRecentBooks(recentCount);
        // 仅显示真正阅读过的书籍；如果没有则“最近”为空
        list = Array.isArray(recent) ? recent : [];
      } catch {
        const allBooks = await bookService.getAllBooks();
        list = (allBooks || []).sort(
          (a, b) => (b.last_read_time || 0) - (a.last_read_time || 0)
        );
      }
      setBooks(list);
    } catch (error) {
      console.error("Failed to load books:", error);
      setBooks([]);
    } finally {
      setLoading(false);
    }
  };

  const loadGroups = async () => {
    try {
      const allGroups = await groupService.getAllGroups();
      setGroups(allGroups || []);
    } catch (error) {
      console.error("Failed to load groups:", error);
      setGroups([]);
    }
  };

  const handleBookClick = (book: IBook) => {
    if (selectionMode) {
      setSelectedBookIds((prev) => {
        const next = new Set(prev);
        if (next.has(book.id)) next.delete(book.id);
        else next.add(book.id);
        return next;
      });
      return;
    }
    navigate(`/reader/${book.id}`, { state: { fromTab: activeTab } });
  };

  const handleDeleteBook = async (book: IBook) => {
    if (selectionMode) {
      // 在选择模式下使用顶部删除入口
      setSelectedBookIds((prev) => new Set([...prev, book.id]));
      setConfirmOpen(true);
      return;
    }
    try {
      if (activeTab === "recent") {
        let ok: boolean = false;
        try {
          const { confirm } = await import("@tauri-apps/plugin-dialog");
          ok = await confirm(`仅从“最近”中移除该书籍？不会删除书籍`, {
            title: "goread",
          });
        } catch {
          ok = window.confirm("仅从“最近”中移除该书籍？不会删除书籍");
        }
        if (!ok) return;
        await bookService.clearRecent(book.id);
        await loadBooks();
      } else {
        let ok: boolean = false;
        try {
          const { confirm } = await import("@tauri-apps/plugin-dialog");
          ok = await confirm(`确认删除该书籍及其书签?`, { title: "goread" });
        } catch {
          ok = window.confirm("确认删除该书籍及其书签?");
        }
        if (!ok) return;
        await bookService.deleteBook(book.id);
        await Promise.all([loadBooks(), loadGroups()]);
      }
    } catch (error: any) {
      console.error("删除书籍失败:", error);
      const msg =
        typeof error?.message === "string" ? error.message : String(error);
      alert(`删除书籍失败，请重试\n\n原因：${msg}`);
    }
  };

  // 长按进入选择模式（书籍）
  const onBookLongPress = (id: number) => {
    if (!selectionMode) setSelectionMode(true);
    setSelectedBookIds((prev) => new Set(prev).add(id));
  };

  // 长按进入选择模式（分组）
  const onGroupLongPress = (id: number) => {
    if (!selectionMode) setSelectionMode(true);
    setSelectedGroupIds((prev) => new Set(prev).add(id));
  };

  const exitSelection = () => {
    setSelectionMode(false);
    setSelectedBookIds(new Set());
    setSelectedGroupIds(new Set());
    setConfirmOpen(false);
  };

  const selectAllCurrent = () => {
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
  };

  const confirmDelete = async () => {
    try {
      if (activeTab === "recent") {
        const ids = Array.from(selectedBookIds);
        for (const id of ids) {
          await bookService.clearRecent(id);
        }
        await loadBooks();
      } else {
        const ids = Array.from(selectedGroupIds);
        for (const gid of ids) {
          await groupService.deleteGroup(gid);
        }
        await loadGroups();
      }
      exitSelection();
    } catch (err) {
      console.error("批量删除失败", err);
      alert("删除失败，请重试");
    }
  };
  // 分组封面：基于“全部”分组中的书籍封面（最多4张）
  const [groupCovers, setGroupCovers] = useState<Record<number, string[]>>({});
  useEffect(() => {
    const run = async () => {
      try {
        const entries = await Promise.all(
          (groups || []).map(async (g) => {
            try {
              const list = await groupService.getBooksByGroup(g.id);
              const covers = (list || [])
                .filter((b) => !!b.cover_image)
                .slice(0, 4)
                .map((b) => b.cover_image as string);
              return [g.id, covers] as [number, string[]];
            } catch {
              return [g.id, []] as [number, string[]];
            }
          })
        );
        const map: Record<number, string[]> = {};
        entries.forEach(([id, covers]) => {
          map[id] = covers;
        });
        setGroupCovers(map);
      } catch (e) {
        setGroupCovers({});
      }
    };
    if (groups && groups.length > 0) run();
    else setGroupCovers({});
  }, [groups]);

  const filteredBooks = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return books;
    return books.filter((b) => (b.title || "").toLowerCase().includes(q));
  }, [books, query]);

  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter((g) => (g.name || "").toLowerCase().includes(q));
  }, [groups, query]);

  // 点击外部关闭更多菜单
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      const inMenu = !!(
        menuRef.current &&
        target &&
        menuRef.current.contains(target)
      );
      const inBtn = !!(
        menuBtnRef.current &&
        target &&
        menuBtnRef.current.contains(target)
      );
      if (!inMenu && !inBtn) setMenuOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onEsc);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onEsc);
    };
  }, [menuOpen]);

  // 计算“更多”菜单的定位：基于视口坐标居中于按钮；在靠近右侧时自动左移并保留安全边距
  useLayoutEffect(() => {
    if (!menuOpen) return;
    const btn = menuBtnRef.current;
    const menu = menuRef.current;
    if (!btn || !menu) return;
    const btnRect = btn.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const edge = 14; // 右侧安全边距（视口）
    const menuWidth = menu.offsetWidth || 0;
    let center = btnRect.left + btnRect.width / 2; // 视口坐标
    const maxCenter = vw - edge - menuWidth / 2;
    const minCenter = edge + menuWidth / 2;
    center = Math.max(minCenter, Math.min(maxCenter, center));
    const top = btnRect.bottom + 6; // 视口坐标
    setMenuPos({ left: center, top });
  }, [menuOpen]);

  // update underline position smoothly when active tab or layout changes
  useLayoutEffect(() => {
    const update = () => {
      const target =
        activeTab === "recent" ? recentLabelRef.current : allLabelRef.current;
      if (!target || !tabsRef.current) return;
      const tabsRect = tabsRef.current.getBoundingClientRect();
      const rect = target.getBoundingClientRect();
      setUnderlinePos({ left: rect.left - tabsRect.left, width: rect.width });
      setUnderlineReady(true);
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [activeTab, loading]);

  // ensure underline is positioned on first paint using current activeTab
  useLayoutEffect(() => {
    const update = () => {
      const target =
        activeTab === "recent" ? recentLabelRef.current : allLabelRef.current;
      if (!target || !tabsRef.current) return;
      const tabsRect = tabsRef.current.getBoundingClientRect();
      const rect = target.getBoundingClientRect();
      setUnderlinePos({ left: rect.left - tabsRect.left, width: rect.width });
      setUnderlineReady(true);
    };
    update();
    requestAnimationFrame(update);
  }, []);

  if (loading) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
          fontSize: "16px",
          color: "#666",
        }}
      >
        加载中...
      </div>
    );
  }

  return (
    <div
      style={{
        padding: "16px 8px 16px 16px",
        height: "100vh",
        backgroundColor: "#fafafa",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {selectionMode ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            padding: 0,
            marginBottom: "12px",
          }}
        >
          <button
            aria-label="返回"
            onClick={exitSelection}
            style={{
              background: "none",
              border: "none",
              boxShadow: "none",
              borderRadius: 0,
              cursor: "pointer",
              padding: 0,
              marginLeft: "-6px",
            }}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <path
                d="M14 18l-6-6 6-6"
                stroke="#333"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <span
            style={{
              fontSize: 16,
              color: "#333",
              marginLeft: 8,
              fontWeight: 600,
              // 与左侧返回图标(24px)保持垂直居中视觉对齐
              display: "inline-flex",
              alignItems: "center",
              height: "24px",
              lineHeight: "24px",
              // 视觉微调：字体度量相对图形略低，向上平移1px
              transform: "translateY(-2px)",
            }}
          >
            已选中({selectedCount})
          </span>
          <div style={{ flex: 1 }} />
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <button
              aria-label="删除"
              title="删除"
              style={{
                background: "none",
                border: "none",
                boxShadow: "none",
                borderRadius: 0,
                cursor: selectedCount === 0 ? "not-allowed" : "pointer",
                opacity: selectedCount === 0 ? 0.4 : 1,
                padding: 0,
              }}
              disabled={selectedCount === 0}
              onClick={() => {
                if (selectedCount === 0) return;
                setConfirmOpen(true);
              }}
            >
              <svg width="21" height="21" viewBox="0 0 24 24" fill="none">
                <path
                  d="M6 7h12"
                  stroke={selectedCount === 0 ? "#bbb" : "#333"}
                  strokeWidth="2"
                  strokeLinecap="round"
                />
                <path
                  d="M9 7V5h6v2"
                  stroke={selectedCount === 0 ? "#bbb" : "#333"}
                  strokeWidth="2"
                  strokeLinecap="round"
                />
                <rect
                  x="6"
                  y="7"
                  width="12"
                  height="14"
                  rx="2"
                  stroke={selectedCount === 0 ? "#bbb" : "#333"}
                  strokeWidth="2"
                />
              </svg>
            </button>
            <button
              aria-label="全选"
              title={
                activeTab === "recent"
                  ? selectedBookIds.size === (filteredBooks?.length || 0) &&
                    (filteredBooks?.length || 0) > 0
                    ? "取消全选"
                    : "全选"
                  : selectedGroupIds.size === (filteredGroups?.length || 0) &&
                    (filteredGroups?.length || 0) > 0
                  ? "取消全选"
                  : "全选"
              }
              style={{
                background: "none",
                border: "none",
                boxShadow: "none",
                borderRadius: 0,
                cursor: "pointer",
                padding: 0,
              }}
              onClick={selectAllCurrent}
            >
              <svg width="21" height="21" viewBox="0 0 24 24" fill="none">
                {(() => {
                  const allCount =
                    activeTab === "recent"
                      ? filteredBooks?.length || 0
                      : filteredGroups?.length || 0;
                  const selCount =
                    activeTab === "recent"
                      ? selectedBookIds.size
                      : selectedGroupIds.size;
                  const isAll = allCount > 0 && selCount === allCount;
                  const stroke = isAll ? "#d23c3c" : "#333";
                  return (
                    <g>
                      <rect
                        x="3"
                        y="3"
                        width="7"
                        height="7"
                        stroke={stroke}
                        strokeWidth="2"
                      />
                      <rect
                        x="14"
                        y="3"
                        width="7"
                        height="7"
                        stroke={stroke}
                        strokeWidth="2"
                      />
                      <rect
                        x="3"
                        y="14"
                        width="7"
                        height="7"
                        stroke={stroke}
                        strokeWidth="2"
                      />
                      <rect
                        x="14"
                        y="14"
                        width="7"
                        height="7"
                        stroke={stroke}
                        strokeWidth="2"
                      />
                    </g>
                  );
                })()}
              </svg>
            </button>
          </div>
        </div>
      ) : (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: "12px",
          }}
        >
          <div
            ref={tabsRef}
            style={{
              display: "flex",
              alignItems: "flex-end",
              gap: "18px",
              position: "relative",
              paddingBottom: "8px",
            }}
          >
            <button
              onClick={() => {
                setActiveTab("recent");
                setAnimateUnderline(true);
              }}
              style={{
                background: "transparent",
                border: "none",
                padding: 0,
                cursor: "pointer",
                boxShadow: "none",
                borderRadius: 0,
              }}
              title="最近"
            >
              <div
                ref={recentLabelRef}
                style={{
                  fontSize: "18px",
                  color: activeTab === "recent" ? "#000" : "#bbb",
                  transition: "color 200ms ease",
                }}
              >
                最近
              </div>
            </button>
            <button
              onClick={() => {
                setActiveTab("all");
                setAnimateUnderline(true);
              }}
              style={{
                background: "transparent",
                border: "none",
                padding: 0,
                cursor: "pointer",
                boxShadow: "none",
                borderRadius: 0,
              }}
              title="全部"
            >
              <div
                ref={allLabelRef}
                style={{
                  fontSize: "18px",
                  color: activeTab === "all" ? "#000" : "#bbb",
                  transition: "color 200ms ease",
                }}
              >
                全部
              </div>
            </button>
            <div
              style={{
                position: "absolute",
                bottom: 0,
                left: underlinePos.left,
                width: underlinePos.width,
                height: "3px",
                backgroundColor: "#d15158",
                transition: animateUnderline
                  ? "left 250ms ease, width 250ms ease"
                  : "none",
                opacity: underlineReady ? 1 : 0,
              }}
            />
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "20px",
              position: "relative",
            }}
          >
            <button
              title="搜索"
              aria-label="搜索"
              onClick={() => navigate(`/search?tab=${activeTab}`)}
              style={{
                background: "transparent",
                border: "none",
                padding: 0,
                margin: 0,
                cursor: "pointer",
                color: "#333",
                WebkitAppearance: "none",
                appearance: "none",
                outline: "none",
                boxShadow: "none",
                borderRadius: 0,
                display: "inline-flex",
                alignItems: "center",
              }}
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <circle cx="11" cy="11" r="7" stroke="#333" strokeWidth="2" />
                <line
                  x1="20"
                  y1="20"
                  x2="16.5"
                  y2="16.5"
                  stroke="#333"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </button>
            <button
              ref={menuBtnRef}
              title="更多"
              aria-label="更多"
              onClick={() => setMenuOpen((m) => !m)}
              style={{
                background: "transparent",
                border: "none",
                padding: 0,
                margin: 0,
                cursor: "pointer",
                color: "#333",
                WebkitAppearance: "none",
                appearance: "none",
                outline: "none",
                boxShadow: "none",
                borderRadius: 0,
                display: "inline-flex",
                alignItems: "center",
              }}
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="#333"
                xmlns="http://www.w3.org/2000/svg"
              >
                <circle cx="12" cy="5" r="2" />
                <circle cx="12" cy="12" r="2" />
                <circle cx="12" cy="19" r="2" />
              </svg>
            </button>
            {menuOpen && (
              <div
                ref={menuRef}
                style={{
                  position: "fixed",
                  left: menuPos.left,
                  top: menuPos.top,
                  transform: "translateX(-50%)",
                  background: "#fff",
                  border: "none",
                  boxShadow: "0 6px 16px rgba(0,0,0,0.12)",
                  borderRadius: "10px",
                  padding: "8px 14px",
                  width: "auto",
                  minWidth: "100px",
                  whiteSpace: "nowrap",
                  zIndex: 20,
                }}
              >
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    navigate("/import");
                  }}
                  style={{
                    width: "100%",
                    background: "transparent",
                    border: "none",
                    boxShadow: "none",
                    borderRadius: 0,
                    padding: "8px 6px",
                    cursor: "pointer",
                    color: "#333",
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    textAlign: "left",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = "#f7f7f7";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = "transparent";
                  }}
                >
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                    aria-hidden
                  >
                    <path
                      d="M12 3v8"
                      stroke="#333"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                    <path
                      d="M9.5 8.5L12 11l2.5-2.5"
                      stroke="#333"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    <rect
                      x="4"
                      y="13"
                      width="16"
                      height="7"
                      rx="2"
                      stroke="#333"
                      strokeWidth="2"
                    />
                  </svg>
                  <span>导入</span>
                </button>
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    navigate("/settings");
                  }}
                  style={{
                    width: "100%",
                    background: "transparent",
                    border: "none",
                    boxShadow: "none",
                    borderRadius: 0,
                    padding: "8px 6px",
                    cursor: "pointer",
                    color: "#333",
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    textAlign: "left",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = "#f7f7f7";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = "transparent";
                  }}
                >
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                    aria-hidden
                  >
                    <circle
                      cx="12"
                      cy="12"
                      r="9"
                      stroke="#333"
                      strokeWidth="2"
                    />
                    <circle
                      cx="12"
                      cy="12"
                      r="3"
                      stroke="#333"
                      strokeWidth="2"
                    />
                    <path
                      d="M12 4.5v2.3"
                      stroke="#333"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                    <path
                      d="M12 17.2v2.3"
                      stroke="#333"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                    <path
                      d="M4.5 12h2.3"
                      stroke="#333"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                    <path
                      d="M17.2 12h2.3"
                      stroke="#333"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                    <path
                      d="M6.8 6.8l1.6 1.6"
                      stroke="#333"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                    <path
                      d="M15.6 15.6l1.6 1.6"
                      stroke="#333"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                    <path
                      d="M6.8 17.2l1.6-1.6"
                      stroke="#333"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                    <path
                      d="M15.6 8.4l1.6-1.6"
                      stroke="#333"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                  </svg>
                  <span>设置</span>
                </button>
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    alert("GoRead - 轻量 PDF 阅读器");
                  }}
                  style={{
                    width: "100%",
                    background: "transparent",
                    border: "none",
                    boxShadow: "none",
                    borderRadius: 0,
                    padding: "8px 6px",
                    cursor: "pointer",
                    color: "#333",
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    textAlign: "left",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = "#f7f7f7";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = "transparent";
                  }}
                >
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                    aria-hidden
                  >
                    <circle
                      cx="12"
                      cy="12"
                      r="9"
                      stroke="#333"
                      strokeWidth="2"
                    />
                    <path
                      d="M12 9v6"
                      stroke="#333"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                    <circle cx="12" cy="6.5" r="1.5" fill="#333" />
                  </svg>
                  <span>关于</span>
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="no-scrollbar" style={{ flex: 1, overflowY: "auto" }}>
        {/* 选择模式顶部栏已合并到上方最近/全部标签区域 */}
        {activeTab === "recent" ? (
          filteredBooks.length === 0 ? (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                height: "400px",
                color: "#999",
              }}
            >
              <div style={{ fontSize: "18px", marginBottom: "10px" }}>
                暂无书籍
              </div>
              <div style={{ fontSize: "14px" }}>
                通过右上角“更多”中的“导入”添加书籍
              </div>
            </div>
          ) : (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: GRID_GAP_BOOK_CARDS + "px",
              }}
            >
              {filteredBooks.map((book) => (
                <BookCard
                  key={book.id}
                  book={book}
                  onClick={() => handleBookClick(book)}
                  onLongPress={() => onBookLongPress(book.id)}
                  selectable={selectionMode}
                  selected={selectedBookIds.has(book.id)}
                  onToggleSelect={() => {
                    setSelectedBookIds((prev) => {
                      const next = new Set(prev);
                      if (next.has(book.id)) next.delete(book.id);
                      else next.add(book.id);
                      return next;
                    });
                  }}
                  onDelete={() => handleDeleteBook(book)}
                />
              ))}
            </div>
          )
        ) : filteredGroups.length === 0 ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              height: "400px",
              color: "#999",
            }}
          >
            <div style={{ fontSize: "18px", marginBottom: "10px" }}>
              暂无分组
            </div>
            <div style={{ fontSize: "14px" }}>
              通过右上角“更多”中的“导入”添加书籍
            </div>
          </div>
        ) : (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: `${GRID_GAP_GROUP_ROW}px ${GRID_GAP_GROUP_COLUMN}px`,
            }}
          >
            {filteredGroups.map((g) => (
              <div
                key={g.id}
                style={{
                  width: "140px",
                  margin: 0,
                  cursor: "pointer",
                  position: "relative",
                }}
                onClick={() => {
                  if (selectionMode) {
                    setSelectedGroupIds((prev) => {
                      const next = new Set(prev);
                      if (next.has(g.id)) next.delete(g.id);
                      else next.add(g.id);
                      return next;
                    });
                  } else {
                    setOverlayGroupId(g.id);
                    setGroupOverlayOpen(true);
                  }
                }}
                onPointerDown={(e) => {
                  if (selectionMode) return;
                  const target = e.currentTarget;
                  const timer = window.setTimeout(() => {
                    onGroupLongPress(g.id);
                  }, 500);
                  const clear = () => window.clearTimeout(timer);
                  const up = () => {
                    clear();
                    target.removeEventListener("pointerup", up as any);
                    target.removeEventListener("pointerleave", leave as any);
                    target.removeEventListener("pointercancel", cancel as any);
                  };
                  const leave = () => up();
                  const cancel = () => up();
                  target.addEventListener("pointerup", up as any, {
                    once: true,
                  });
                  target.addEventListener("pointerleave", leave as any, {
                    once: true,
                  });
                  target.addEventListener("pointercancel", cancel as any, {
                    once: true,
                  });
                }}
              >
                <div style={{ position: "relative" }}>
                  <GroupCoverGrid
                    covers={groupCovers[g.id] || []}
                    tileRatio="3 / 4"
                  />
                  {selectionMode && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedGroupIds((prev) => {
                          const next = new Set(prev);
                          if (next.has(g.id)) next.delete(g.id);
                          else next.add(g.id);
                          return next;
                        });
                      }}
                      title={selectedGroupIds.has(g.id) ? "取消选择" : "选择"}
                      style={{
                        position: "absolute",
                        top: "0.5px",
                        right: "0.5px",
                        width: "24px",
                        height: "24px",
                        background: "none",
                        border: "none",
                        boxShadow: "none",
                        borderRadius: 0,
                        WebkitAppearance: "none",
                        appearance: "none",
                        outline: "none",
                        WebkitTapHighlightColor: "transparent",
                        padding: 0,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        cursor: "pointer",
                      }}
                    >
                      {selectedGroupIds.has(g.id) ? (
                        <svg
                          width="24"
                          height="24"
                          viewBox="0 0 24 24"
                          fill="none"
                        >
                          <circle cx="12" cy="12" r="9" fill="#d23c3c" />
                          <path
                            d="M9 12l2 2 4-4"
                            stroke="#fff"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      ) : (
                        <svg
                          width="24"
                          height="24"
                          viewBox="0 0 24 24"
                          fill="none"
                        >
                          <circle
                            cx="12"
                            cy="12"
                            r="9"
                            fill="#fff"
                            stroke="#d23c3c"
                            strokeWidth="2"
                          />
                        </svg>
                      )}
                    </button>
                  )}
                </div>
                <div style={{ marginTop: CARD_INFO_MARGIN_TOP + "px" }}>
                  <div
                    style={{
                      fontSize: GROUP_NAME_FONT_SIZE + "px",
                      fontWeight: GROUP_NAME_FONT_WEIGHT,
                      color: "#333",
                      lineHeight: 1.5,
                      overflow: "hidden",
                      textAlign: "left",
                      display: "-webkit-box",
                      WebkitLineClamp: 1,
                      WebkitBoxOrient: "vertical" as any,
                      marginTop: GROUP_NAME_MARGIN_TOP + "px",
                    }}
                  >
                    {g.name}
                  </div>
                  <div
                    style={{
                      marginTop: GROUP_META_MARGIN_TOP + "px",
                      fontSize: GROUP_META_FONT_SIZE + "px",
                      color: "#888",
                      textAlign: "left",
                    }}
                  >
                    共 {g.book_count} 本
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {groupOverlayOpen && overlayGroupId !== null && (
        <div
          onClick={() => {
            setGroupOverlayOpen(false);
            setActiveTab("all");
          }}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(225,225,225,0.6)",
            backdropFilter: "blur(12px)",
            WebkitBackdropFilter: "blur(12px)",
            zIndex: 100,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div
            style={{
              width: "100%",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "12px",
            }}
          >
            {/* 标题在容器外居中 */}
            <div
              style={{
                fontSize: "16px",
                fontWeight: 500,
                color: "#333",
                textAlign: "center",
              }}
            >
              {groups.find((g) => g.id === overlayGroupId)?.name || "分组"}
            </div>
            {/* 抽屉主体：宽度占满，高度85%，居中位置 */}
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                width: "100%",
                height: "85vh",
                maxHeight: "85vh",
                overflow: "hidden",
                background: "#f7f7f7",
              }}
            >
              <div style={{ width: "100%", height: "100%" }}>
                <GroupDetail
                  groupIdProp={overlayGroupId}
                  onClose={() => {
                    setGroupOverlayOpen(false);
                    setActiveTab("all");
                    // 关闭抽屉时刷新分组与最近
                    loadGroups();
                    loadBooks();
                  }}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 导入进度抽屉：覆盖在页面底部并加深背景 */}
      <ImportProgressDrawer
        open={importOpen}
        title={importTitle}
        current={importCurrent}
        total={importTotal}
        onStop={() => {
          // 通知正在导入的流程取消
          const evt = new CustomEvent("goread:import:cancel");
          window.dispatchEvent(evt);
          setImportOpen(false);
        }}
      />
      <ConfirmDeleteDrawer
        open={confirmOpen}
        context={activeTab === "recent" ? "recent" : "all-groups"}
        count={selectedCount}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={confirmDelete}
      />
    </div>
  );
};

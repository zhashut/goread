import React, {
  useState,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { useTranslation } from "react-i18next";

import { useAppNav } from "../router/useAppNav";
import { IBook, IGroup } from "../types";
import { ensurePermissionForDeleteLocal, ensurePermissionForImport } from "../utils/storagePermission";
import { IconDelete } from "./Icons";
  import {
  GRID_GAP_BOOK_CARDS,
  GROUP_NAME_FONT_SIZE,
  GROUP_META_FONT_SIZE,
  GROUP_NAME_FONT_WEIGHT,
  CARD_INFO_MARGIN_TOP,
  GROUP_NAME_MARGIN_TOP,
  GROUP_META_MARGIN_TOP,
  CARD_MIN_WIDTH,
  SELECTION_ICON_SIZE,
  SELECTION_ICON_OFFSET_TOP,
  SELECTION_ICON_OFFSET_RIGHT,
  GROUP_COVER_PADDING,
  TOP_BAR_ICON_SIZE,
} from "../constants/ui";
import { BookshelfTopBar } from "./BookshelfTopBar";
import { Toast } from "./Toast";
import { bookService, groupService, getReaderSettings } from "../services";
import { GroupDetailOverlay } from "./GroupDetailOverlay";
import { BookCard } from "./BookCard";
import GroupCoverGrid from "./GroupCoverGrid";
import {
  MARKDOWN_COVER_PLACEHOLDER,
  HTML_COVER_PLACEHOLDER,
} from "../constants/ui";
import { getBookFormat } from "../constants/fileTypes";
import ImportProgressDrawer from "./ImportProgressDrawer";
import ConfirmDeleteDrawer from "./ConfirmDeleteDrawer";
import { DndContext, closestCenter, DragEndEvent } from "@dnd-kit/core";
import { arrayMove, SortableContext, rectSortingStrategy } from "@dnd-kit/sortable";
import { SortableItem } from "./SortableItem";
import { SortableBookItem } from "./SortableBookItem";
import { getSafeAreaInsets } from "../utils/layout";
import { useDndSensors, useDragGuard, useTabSwipe, isTouchDevice } from "../utils/gesture";
import { DRAG_TOUCH_TOLERANCE_PX, SELECTION_LONGPRESS_DELAY_MS } from "../constants/interactions";

const applySortOrder = <T extends { id: number }>(items: T[], orderKey: string): T[] => {
  try {
    const orderStr = localStorage.getItem(orderKey);
    if (!orderStr) return items;
    const order = JSON.parse(orderStr) as number[];
    if (!Array.isArray(order)) return items;
    const itemMap = new Map(items.map((i) => [i.id, i]));
    const sorted: T[] = [];
    order.forEach((id) => {
      const item = itemMap.get(id);
      if (item) {
        sorted.push(item);
        itemMap.delete(id);
      }
    });
    const remaining: T[] = [];
    itemMap.forEach((item) => remaining.push(item));
    return [...remaining, ...sorted];
  } catch {
    return items;
  }
};

// 使用通用 BookCard 组件

export const Bookshelf: React.FC = () => {
  const { t } = useTranslation('bookshelf');
  const { t: tCommon } = useTranslation('common');
  const nav = useAppNav();
  const activeTab = (nav.currentTab === "all" ? "all" : "recent") as "recent" | "all";

  const [books, setBooks] = useState<IBook[]>([]);
  const [groups, setGroups] = useState<IGroup[]>([]);
  const [loading, setLoading] = useState(true);

  const [query] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  
  const [groupOverlayOpen, setGroupOverlayOpen] = useState(false);
  const [overlayGroupId, setOverlayGroupId] = useState<number | null>(null);
  
  const [toastMsg, setToastMsg] = useState("");

  // 与 URL 同步分组覆盖层状态
  useEffect(() => {
    // 检查是否有跨页面传递的 Tab 切换请求（例如从导入流程返回时清理了栈）
    const targetTab = sessionStorage.getItem('bookshelf_active_tab');
    if (targetTab && (targetTab === 'recent' || targetTab === 'all')) {
      sessionStorage.removeItem('bookshelf_active_tab');
      if (activeTab !== targetTab) {
        nav.toBookshelf(targetTab as 'recent' | 'all', { replace: true, resetStack: false });
      }
    }

    if (activeTab === "all" && nav.activeGroupId) {
      const idNum = nav.activeGroupId;
      setOverlayGroupId((prevId) => {
        const shouldOpen = !groupOverlayOpen || prevId !== idNum;
        if (shouldOpen) setGroupOverlayOpen(true);
        return idNum;
      });
    } else {
      if (groupOverlayOpen) {
        lastGroupCloseTimeRef.current = Date.now();
      }
      setGroupOverlayOpen(false);
      setOverlayGroupId(null);
      
    }
  }, [activeTab, nav.activeGroupId]);

  // 选择模式状态：由路由 state 驱动
  // 如果当前在分组详情中（activeGroupId 存在），则主列表不应处于选择模式（避免冲突）
  const selectionMode = !!nav.location.state?.selectionMode && !nav.activeGroupId;

  // 监听 selectionMode 变化以清理状态
  useEffect(() => {
    if (!selectionMode) {
      setSelectedBookIds(new Set());
      setSelectedGroupIds(new Set());
      setConfirmOpen(false);
    }
  }, [selectionMode]);
  const [selectedBookIds, setSelectedBookIds] = useState<Set<number>>(
    new Set()
  );
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<number>>(
    new Set()
  );
  const selectedCount =
    activeTab === "recent" ? selectedBookIds.size : selectedGroupIds.size;
  const [confirmOpen, setConfirmOpen] = useState(false);

  const { dragActive, onDragStart, onDragEnd: onDragEndGuard, onDragCancel } = useDragGuard();
  const lastGroupCloseTimeRef = useRef(0);

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

  const handleDragEnd = async (event: DragEndEvent) => {
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
  };

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
      nav.toBookshelf("all");
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
      let list: IBook[] = [];
      // 明确检查 undefined，允许 0 (不限)
      const recentCount = settings.recentDisplayCount !== undefined ? settings.recentDisplayCount : 9;
      if (recentCount === 0) {
        const allBooks = await bookService.getAllBooks();
        list = (allBooks || [])
          .filter((b) => (b.last_read_time || 0) > 0)
          .sort((a, b) => (b.last_read_time || 0) - (a.last_read_time || 0));
      } else {
        const limit = Math.max(1, recentCount);
        try {
          const recent = await bookService.getRecentBooks(limit);
          list = Array.isArray(recent) ? recent : [];

          // 自动修复 recent_books_order：将不在 order 中的书按时间插入到正确位置
          try {
            const orderKey = "recent_books_order";
            const orderStr = localStorage.getItem(orderKey);
            let order: number[] = [];
            if (orderStr) {
              try {
                order = JSON.parse(orderStr);
              } catch {}
            }

            const bookMap = new Map(list.map((b) => [b.id, b]));
            const orderSet = new Set(order);
            // 找出 list 中不在 order 中的书，保持 list 中的顺序（时间倒序）
            const missingBooks = list.filter((b) => !orderSet.has(b.id));

            if (missingBooks.length > 0) {
              const newOrder = [...order];
              for (const book of missingBooks) {
                let inserted = false;
                for (let i = 0; i < newOrder.length; i++) {
                  const orderBookId = newOrder[i];
                  const orderBook = bookMap.get(orderBookId);
                  // 如果 orderBook 不在 list 中，说明它比 list 中的所有书都旧（假设 list 是 top N）
                  // 或者 book (在 list 中) 比 orderBook 新
                  if (
                    !orderBook ||
                    (book.last_read_time || 0) > (orderBook.last_read_time || 0)
                  ) {
                    newOrder.splice(i, 0, book.id);
                    inserted = true;
                    break;
                  }
                }
                if (!inserted) {
                  newOrder.push(book.id);
                }
              }
              order = newOrder;
              localStorage.setItem(orderKey, JSON.stringify(order));
            }
          } catch (e) {
            console.warn("Auto-fix recent order failed", e);
          }
        } catch {
          const allBooks = await bookService.getAllBooks();
          list = (allBooks || [])
            .filter((b) => (b.last_read_time || 0) > 0)
            .sort((a, b) => (b.last_read_time || 0) - (a.last_read_time || 0))
            .slice(0, limit);
        }
      }
      setBooks(applySortOrder(list, "recent_books_order"));
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
      setGroups(applySortOrder(allGroups || [], "groups_order"));
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
    // 更新排序：将本书移至顶部
    try {
      const orderStr = localStorage.getItem("recent_books_order");
      let order: number[] = [];
      if (orderStr) {
        try {
          const parsed = JSON.parse(orderStr);
          if (Array.isArray(parsed)) order = parsed;
        } catch {}
      }
      // 如果存在则移除
      order = order.filter((id) => id !== book.id);
      // 添加到最前
      order.unshift(book.id);
      localStorage.setItem("recent_books_order", JSON.stringify(order));
    } catch (e) {
      console.error("Failed to update recent order", e);
    }
    nav.toReader(book.id, { fromTab: activeTab });
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
      alert(t('deleteBookFailedWithReason', { reason: msg }));
    }
  };

  // 长按进入选择模式（书籍）
  const onBookLongPress = (id: number) => {
    if (!selectionMode) {
      nav.toBookshelf(activeTab, { state: { selectionMode: true }, replace: false, resetStack: false });
    }
    setSelectedBookIds((prev) => new Set(prev).add(id));
  };

  // 长按进入选择模式（分组）
  const onGroupLongPress = (id: number) => {
    if (!selectionMode) {
      nav.toBookshelf(activeTab, { state: { selectionMode: true }, replace: false, resetStack: false });
    }
    setSelectedGroupIds((prev) => new Set(prev).add(id));
  };

  const exitSelection = () => {
    if (selectionMode) {
      nav.goBack();
    }
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

  const confirmDelete = async (deleteLocal?: boolean) => {
    try {
      // 如果要删除本地文件，先检查权限
      let actualDeleteLocal = deleteLocal;
      if (deleteLocal && activeTab !== "recent") {
        const { allowed, downgrade } = await ensurePermissionForDeleteLocal();
        if (!allowed) {
          return; // 用户取消操作
        }
        if (downgrade) {
          actualDeleteLocal = false; // 降级为不删除本地文件
        }
      }
      
      if (activeTab === "recent") {
        const ids = Array.from(selectedBookIds);
        for (const id of ids) {
          await bookService.clearRecent(id);
        }
        await loadBooks();
      } else {
        const ids = Array.from(selectedGroupIds);
        for (const gid of ids) {
          await groupService.deleteGroup(gid, !!actualDeleteLocal);
        }
        await Promise.all([loadGroups(), loadBooks()]);
      }
      exitSelection();
    } catch (err) {
      console.error("批量删除失败", err);
      alert(t('deleteFailed'));
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
              const covers: string[] = [];
              for (const b of list || []) {
                if (covers.length >= 4) break;
                if (b.cover_image) {
                  covers.push(b.cover_image);
                }
              }
              if (covers.length < 4) {
                for (const b of list || []) {
                  if (covers.length >= 4) break;
                  if (!b.cover_image) {
                    const fmt = getBookFormat(b.file_path);
                    if (fmt === "markdown") {
                      covers.push(MARKDOWN_COVER_PLACEHOLDER);
                    } else if (fmt === "html") {
                      covers.push(HTML_COVER_PLACEHOLDER);
                    }
                  }
                }
              }
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
        {tCommon('loading')}
      </div>
    );
  }

  return (
    <div
      style={{
        padding: `calc(${getSafeAreaInsets().top} + 16px) 8px 16px 16px`,
        height: "100vh",
        backgroundColor: "#fafafa",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <BookshelfTopBar
        mode={selectionMode ? "selection" : "default"}
        activeTab={activeTab}
        onTabChange={(tab) => nav.toBookshelf(tab, { replace: true })}
        onSearch={() => nav.toSearch()}
        onMenuAction={async (action) => {
          if (action === "import") {
            const ok = await ensurePermissionForImport();
            if (ok) {
              nav.toImport({ fromTab: activeTab, initialTab: "scan" });
            } else {
              // 权限被拒绝，停留在书架页并提示
              setToastMsg(t('importNeedPermission'));
            }
          }
          else if (action === "settings") nav.toSettings({ fromTab: activeTab });
          else if (action === "statistics") nav.toStatistics({ fromTab: activeTab });
          else if (action === "about") nav.toAbout();
        }}
        onMenuOpenChange={setMenuOpen}
        selectedCount={selectedCount}
        onExitSelection={exitSelection}
        selectionActions={
          <>
            <button
              aria-label="删除"
              title="删除"
              style={{
                background: "none",
                border: "none",
                boxShadow: "none",
                borderRadius: 0,
                cursor: selectedCount === 0 || dragActive ? "not-allowed" : "pointer",
                opacity: selectedCount === 0 || dragActive ? 0.4 : 1,
                padding: 0,
              }}
              disabled={selectedCount === 0 || dragActive}
              onClick={() => {
                if (selectedCount === 0 || dragActive) return;
                setConfirmOpen(true);
              }}
            >
              <IconDelete width={TOP_BAR_ICON_SIZE} height={TOP_BAR_ICON_SIZE} fill="#333" />
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
                cursor: dragActive ? "not-allowed" : "pointer",
                opacity: dragActive ? 0.4 : 1,
                padding: 0,
              }}
              disabled={dragActive}
              onClick={() => {
                if (dragActive) return;
                selectAllCurrent();
              }}
            >
              <svg
                width={TOP_BAR_ICON_SIZE}
                height={TOP_BAR_ICON_SIZE}
                viewBox="0 0 24 24"
                fill="none"
              >
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
                    <>
                      <rect
                        x="3"
                        y="3"
                        width="7"
                        height="7"
                        stroke={stroke}
                        strokeWidth="2"
                        rx="1"
                      />
                      <rect
                        x="14"
                        y="3"
                        width="7"
                        height="7"
                        stroke={stroke}
                        strokeWidth="2"
                        rx="1"
                      />
                      <rect
                        x="3"
                        y="14"
                        width="7"
                        height="7"
                        stroke={stroke}
                        strokeWidth="2"
                        rx="1"
                      />
                      <rect
                        x="14"
                        y="14"
                        width="7"
                        height="7"
                        stroke={stroke}
                        strokeWidth="2"
                        rx="1"
                      />
                    </>
                  );
                })()}
              </svg>
            </button>
          </>
        }
      />

      <div
        className="no-scrollbar"
        style={{
          flex: 1,
          overflowY: "auto",
          overflowX: "hidden",
          paddingBottom: `calc(75px + ${getSafeAreaInsets().bottom})`,
        }}
        onTouchStart={swipeTouchStart}
        onTouchEnd={swipeTouchEnd}
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
                {t('noBooks')}
              </div>
              <div style={{ fontSize: "14px" }}>
                {t('importTip')}
              </div>
            </div>
          ) : (
          !query ? (
            <SortableContext
              items={filteredBooks.map((b) => b.id)}
              strategy={rectSortingStrategy}
            >
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: `repeat(auto-fill, minmax(${CARD_MIN_WIDTH}px, 1fr))`,
                  gap: GRID_GAP_BOOK_CARDS + "px",
                  alignContent: "start",
                  gridAutoRows: "min-content",
                }}
              >
                {filteredBooks.map((book) => (
                  <SortableBookItem
                    width="100%"
                    key={book.id}
                    id={book.id}
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
                    onDelete={() => {
                      if (dragActive) return;
                      handleDeleteBook(book);
                    }}
                  />
                ))}
              </div>
            </SortableContext>
          ) : (
            <div
              style={{
                display: "grid",
                  gridTemplateColumns: `repeat(auto-fill, minmax(${CARD_MIN_WIDTH}px, 1fr))`,
                  gap: GRID_GAP_BOOK_CARDS + "px",
                  alignContent: "start",
                  gridAutoRows: "min-content",
                }}
              >
              {filteredBooks.map((book) => (
                <BookCard
                  width="100%"
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
                  onDelete={() => {
                    if (dragActive) return;
                    handleDeleteBook(book);
                  }}
                />
              ))}
            </div>
          )
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
              {t('noGroups')}
            </div>
            <div style={{ fontSize: "14px" }}>
              {t('importTip')}
            </div>
          </div>
        ) : (
          !query ? (
            <SortableContext
              items={filteredGroups.map((g) => g.id)}
              strategy={rectSortingStrategy}
            >
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: `repeat(auto-fill, minmax(${CARD_MIN_WIDTH}px, 1fr))`,
                  gap: GRID_GAP_BOOK_CARDS + "px",
                  alignContent: "start",
                  gridAutoRows: "min-content",
                }}
              >
                {filteredGroups.map((g) => (
                  <SortableItem
                    key={g.id}
                    id={g.id}
                    disabled={selectionMode}
                    style={{
                      width: "100%",
                      margin: 0,
                      cursor: "pointer",
                      position: "relative",
                    }}
                    className=""
                  >
                    <div
                      onClick={() => {
                        if (dragActive) return;
                        if (selectionMode) {
                          setSelectedGroupIds((prev) => {
                            const next = new Set(prev);
                            if (next.has(g.id)) next.delete(g.id);
                            else next.add(g.id);
                            return next;
                          });
                        } else {
                          nav.openGroup(g.id);
                        }
                      }}
                      onPointerDown={(e) => {
                        if (selectionMode) return;
                        const target = e.currentTarget;
                        const sx = e.clientX;
                        const sy = e.clientY;
                        const timer = window.setTimeout(() => {
                          onGroupLongPress(g.id);
                        }, SELECTION_LONGPRESS_DELAY_MS);
                        const clear = () => window.clearTimeout(timer);
                        const up = () => {
                          clear();
                          target.removeEventListener("pointerup", up as any);
                          target.removeEventListener(
                            "pointerleave",
                            leave as any
                          );
                          target.removeEventListener(
                            "pointercancel",
                            cancel as any
                          );
                          target.removeEventListener("pointermove", move as any);
                        };
                        const leave = () => up();
                        const cancel = () => up();
                        const move = (ev: PointerEvent) => {
                          if (
                            Math.abs(ev.clientX - sx) > DRAG_TOUCH_TOLERANCE_PX ||
                            Math.abs(ev.clientY - sy) > DRAG_TOUCH_TOLERANCE_PX
                          ) {
                            up();
                          }
                        };
                        target.addEventListener("pointerup", up as any, { once: true });
                        target.addEventListener("pointerleave", leave as any, { once: true });
                        target.addEventListener("pointercancel", cancel as any, { once: true });
                        target.addEventListener("pointermove", move as any);
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
                              if (dragActive) return;
                              setSelectedGroupIds((prev) => {
                                const next = new Set(prev);
                                if (next.has(g.id)) next.delete(g.id);
                                else next.add(g.id);
                                return next;
                              });
                            }}
                            title={
                              selectedGroupIds.has(g.id) ? "取消选择" : "选择"
                            }
                            style={{
                              position: "absolute",
                              top:
                                GROUP_COVER_PADDING +
                                SELECTION_ICON_OFFSET_TOP +
                                "px",
                              right:
                                GROUP_COVER_PADDING +
                                SELECTION_ICON_OFFSET_RIGHT +
                                "px",
                              width: SELECTION_ICON_SIZE + "px",
                              height: SELECTION_ICON_SIZE + "px",
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
                              cursor: dragActive ? "not-allowed" : "pointer",
                              opacity: dragActive ? 0.6 : 1,
                            }}
                            disabled={dragActive}
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
                  </SortableItem>
                ))}
              </div>
            </SortableContext>
          ) : (
            <div
              style={{
                display: "grid",
                  gridTemplateColumns: `repeat(auto-fill, minmax(${CARD_MIN_WIDTH}px, 1fr))`,
                  gap: GRID_GAP_BOOK_CARDS + "px",
                  alignContent: "start",
                  gridAutoRows: "min-content",
                }}
              >
              {filteredGroups.map((g) => (
                <div
                  key={g.id}
                  style={{
                    width: "100%",
                    margin: 0,
                    cursor: "pointer",
                    position: "relative",
                  }}
                  onClick={() => {
                    if (dragActive) return;
                    if (selectionMode) {
                      setSelectedGroupIds((prev) => {
                        const next = new Set(prev);
                        if (next.has(g.id)) next.delete(g.id);
                        else next.add(g.id);
                        return next;
                      });
                    } else {
                      nav.openGroup(g.id);
                    }
                  }}
                  onPointerDown={(e) => {
                    if (selectionMode) return;
                    const target = e.currentTarget;
                    const sx = e.clientX;
                    const sy = e.clientY;
                    const timer = window.setTimeout(() => {
                      onGroupLongPress(g.id);
                    }, SELECTION_LONGPRESS_DELAY_MS);
                    const clear = () => window.clearTimeout(timer);
                    const up = () => {
                      clear();
                      target.removeEventListener("pointerup", up as any);
                      target.removeEventListener("pointerleave", leave as any);
                      target.removeEventListener("pointercancel", cancel as any);
                      target.removeEventListener("pointermove", move as any);
                    };
                    const leave = () => up();
                    const cancel = () => up();
                    const move = (ev: PointerEvent) => {
                      if (
                        Math.abs(ev.clientX - sx) > DRAG_TOUCH_TOLERANCE_PX ||
                        Math.abs(ev.clientY - sy) > DRAG_TOUCH_TOLERANCE_PX
                      ) {
                        up();
                      }
                    };
                    target.addEventListener("pointerup", up as any, { once: true });
                    target.addEventListener("pointerleave", leave as any, { once: true });
                    target.addEventListener("pointercancel", cancel as any, { once: true });
                    target.addEventListener("pointermove", move as any);
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
                          if (dragActive) return;
                          setSelectedGroupIds((prev) => {
                            const next = new Set(prev);
                            if (next.has(g.id)) next.delete(g.id);
                            else next.add(g.id);
                            return next;
                          });
                        }}
                        title={
                          selectedGroupIds.has(g.id) ? "取消选择" : "选择"
                        }
                        style={{
                          position: "absolute",
                          top:
                            GROUP_COVER_PADDING +
                            SELECTION_ICON_OFFSET_TOP +
                            "px",
                          right:
                            GROUP_COVER_PADDING +
                            SELECTION_ICON_OFFSET_RIGHT +
                            "px",
                          width: SELECTION_ICON_SIZE + "px",
                          height: SELECTION_ICON_SIZE + "px",
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
                          cursor: dragActive ? "not-allowed" : "pointer",
                          opacity: dragActive ? 0.6 : 1,
                        }}
                        disabled={dragActive}
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
          )
        )}
        </DndContext>
      </div>

      {groupOverlayOpen && overlayGroupId !== null && (
        <GroupDetailOverlay
          groupId={overlayGroupId}
          groups={groups}
          onClose={() => {
            nav.closeGroup();
            // 关闭抽屉时刷新分组与最近
            loadGroups();
            loadBooks();
          }}
          onGroupUpdate={(groupId, newName) => {
            setGroups(prev => prev.map(g => g.id === groupId ? { ...g, name: newName } : g));
          }}
        />
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
      <Toast message={toastMsg} onClose={() => setToastMsg("")} />
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

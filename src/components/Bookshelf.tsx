import React, {
  useState,
  useEffect,
  useMemo,
  useRef,
  useLayoutEffect,
} from "react";

import { useAppNav } from "../router/useAppNav";
import { IBook, IGroup } from "../types";
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
  TOP_BAR_TAB_FONT_SIZE,
  TOP_BAR_ICON_SIZE,
} from "../constants/ui";
import { BookshelfHeader } from "./BookshelfHeader";
import { Toast } from "./Toast";
import { bookService, groupService, getReaderSettings } from "../services";
import { GroupDetail } from "./GroupDetail";
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
  const nav = useAppNav();
  const activeTab = (nav.currentTab === "all" ? "all" : "recent") as "recent" | "all";

  const [books, setBooks] = useState<IBook[]>([]);
  const [groups, setGroups] = useState<IGroup[]>([]);
  const [loading, setLoading] = useState(true);

  const [query] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ left: number; top: number }>({
    left: 0,
    top: 0,
  });
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuBtnRef = useRef<HTMLButtonElement | null>(null);
  // 标签页下划线动画
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const recentLabelRef = useRef<HTMLDivElement | null>(null);
  const allLabelRef = useRef<HTMLDivElement | null>(null);
  const [underlinePos, setUnderlinePos] = useState<{
    left: number;
    width: number;
  }>({ left: 0, width: 0 });
  const [animateUnderline, setAnimateUnderline] = useState(false);
  const [underlineReady, setUnderlineReady] = useState(false);
  
  const [groupOverlayOpen, setGroupOverlayOpen] = useState(false);
  const [overlayGroupId, setOverlayGroupId] = useState<number | null>(null);
  
  // 分组重命名状态
  const [isEditingGroupName, setIsEditingGroupName] = useState(false);
  const [editingGroupName, setEditingGroupName] = useState("");
  const [toastMsg, setToastMsg] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);

  const handleSaveGroupName = async () => {
    const name = editingGroupName.trim();
    if (!name) {
      // 如果名称为空，视为取消修改，恢复原名并退出编辑态
      const currentGroup = groups.find(g => g.id === overlayGroupId);
      if (currentGroup) {
        setEditingGroupName(currentGroup.name);
      }
      justFinishedEditingRef.current = true;
      setTimeout(() => { justFinishedEditingRef.current = false; }, 300);
      setIsEditingGroupName(false);
      return;
    }
    
    const currentGroup = groups.find(g => g.id === overlayGroupId);
    if (currentGroup && name === currentGroup.name) {
      justFinishedEditingRef.current = true;
      setTimeout(() => { justFinishedEditingRef.current = false; }, 300);
      setIsEditingGroupName(false);
      return;
    }

    // 前端查重（排除当前分组）
    const isDuplicate = groups.some(g => g.name === name && g.id !== overlayGroupId);
    if (isDuplicate) {
      setToastMsg("分组名称已存在");
      setTimeout(() => editInputRef.current?.focus(), 0);
      return;
    }

    try {
      if (overlayGroupId) {
        await groupService.updateGroup(overlayGroupId, name);
        // 更新本地状态
        setGroups(prev => prev.map(g => g.id === overlayGroupId ? { ...g, name } : g));
        justFinishedEditingRef.current = true;
        setTimeout(() => { justFinishedEditingRef.current = false; }, 300);
        setIsEditingGroupName(false);
      }
    } catch (e: any) {
      console.error("Update group name failed", e);
      setToastMsg(typeof e === 'string' ? e : (e.message || "修改失败"));
      setTimeout(() => editInputRef.current?.focus(), 0);
    }
  };

  // 与 URL 同步分组覆盖层状态
  useEffect(() => {
    // 检查是否有跨页面传递的 Tab 切换请求（例如从导入流程返回时清理了栈）
    const targetTab = sessionStorage.getItem('bookshelf_active_tab');
    if (targetTab && (targetTab === 'recent' || targetTab === 'all')) {
      sessionStorage.removeItem('bookshelf_active_tab');
      // 只有当前不在目标 Tab 时才切换
      if (activeTab !== targetTab) {
        nav.toBookshelf(targetTab as 'recent' | 'all', { replace: true });
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

  const [groupDetailSelectionActive, setGroupDetailSelectionActive] = useState(false);
  const [groupDetailSelectedCount, setGroupDetailSelectedCount] = useState(0);

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
  const justFinishedEditingRef = useRef(false);
  const lastGroupCloseTimeRef = useRef(0);

  const { onTouchStart: swipeTouchStart, onTouchEnd: swipeTouchEnd } = useTabSwipe({
    onLeft: () => {
      if (activeTab === "recent") {
        nav.toBookshelf("all", { replace: true });
        setAnimateUnderline(true);
      }
    },
    onRight: () => {
      if (activeTab === "all") {
        nav.toBookshelf("recent", { replace: true });
        setAnimateUnderline(true);
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

  useEffect(() => {
    const onSel = (e: Event) => {
      const detail: any = (e as any).detail || {};
      setGroupDetailSelectionActive(!!detail.active);
      setGroupDetailSelectedCount(Number(detail.count) || 0);
    };
    window.addEventListener("goread:group-detail:selection", onSel as any);
    return () => window.removeEventListener("goread:group-detail:selection", onSel as any);
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
      alert(`删除书籍失败，请重试\n\n原因：${msg}`);
    }
  };

  // 长按进入选择模式（书籍）
  const onBookLongPress = (id: number) => {
    if (!selectionMode) {
      nav.toBookshelf(activeTab, { state: { selectionMode: true }, replace: false });
    }
    setSelectedBookIds((prev) => new Set(prev).add(id));
  };

  // 长按进入选择模式（分组）
  const onGroupLongPress = (id: number) => {
    if (!selectionMode) {
      nav.toBookshelf(activeTab, { state: { selectionMode: true }, replace: false });
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
      if (activeTab === "recent") {
        const ids = Array.from(selectedBookIds);
        for (const id of ids) {
          await bookService.clearRecent(id);
        }
        await loadBooks();
      } else {
        const ids = Array.from(selectedGroupIds);
        for (const gid of ids) {
          await groupService.deleteGroup(gid, !!deleteLocal);
        }
        await Promise.all([loadGroups(), loadBooks()]);
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

  // 切换 active tab 或布局时平滑更新下划线位置
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

  // 确保下划线在首次绘制时定位到当前 activeTab
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
        padding: `calc(${getSafeAreaInsets().top} + 16px) 8px 16px 16px`,
        height: "100vh",
        backgroundColor: "#fafafa",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {selectionMode ? (
        <BookshelfHeader
          leftAlign="center"
          left={
            <>
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
                <svg
                  width={TOP_BAR_ICON_SIZE}
                  height={TOP_BAR_ICON_SIZE}
                  viewBox="0 0 24 24"
                  fill="none"
                >
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
                  fontSize: TOP_BAR_TAB_FONT_SIZE,
                  color: "#333",
                  marginLeft: 8,
                  fontWeight: 600,
                  // 与左侧返回图标保持垂直居中视觉对齐
                  display: "inline-flex",
                  alignItems: "center",
                  height: TOP_BAR_ICON_SIZE + "px",
                  lineHeight: TOP_BAR_ICON_SIZE + "px",
                  // 视觉微调：字体度量相对图形略低，向上平移1px
                  transform: "translateY(-2px)",
                }}
              >
                已选中({selectedCount})
              </span>
            </>
          }
          right={
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
                <svg
                  width={TOP_BAR_ICON_SIZE}
                  height={TOP_BAR_ICON_SIZE}
                  viewBox="0 0 24 24"
                  fill="none"
                >
                  <path
                    d="M6 7h12"
                    stroke={selectedCount === 0 || dragActive ? "#bbb" : "#333"}
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                  <path
                    d="M9 7V5h6v2"
                    stroke={selectedCount === 0 || dragActive ? "#bbb" : "#333"}
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                  <rect
                    x="6"
                    y="7"
                    width="12"
                    height="14"
                    rx="2"
                    stroke={selectedCount === 0 || dragActive ? "#bbb" : "#333"}
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
            </>
          }
        />
      ) : (
        <BookshelfHeader
          leftContainerRef={tabsRef}
          left={
            <>
              <button
                onClick={() => {
                  nav.toBookshelf("recent", { replace: true });
                  setAnimateUnderline(true);
                }}
                style={{
                  background: "transparent",
                  border: "none",
                  padding: 0,
                  cursor: "pointer",
                  boxShadow: "none",
                  borderRadius: 0,
                  marginRight: "15px",
                }}
                title="最近"
              >
                <div
                  ref={recentLabelRef}
                  style={{
                    fontSize: TOP_BAR_TAB_FONT_SIZE + "px",
                    color: activeTab === "recent" ? "#000" : "#bbb",
                    transition: "color 200ms ease",
                  }}
                >
                  最近
                </div>
              </button>
              <button
                onClick={() => {
                  nav.toBookshelf("all", { replace: true });
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
                    fontSize: TOP_BAR_TAB_FONT_SIZE + "px",
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
            </>
          }
          right={
            <>
              <button
                title="搜索"
                aria-label="搜索"
                onClick={() => nav.toSearch()}
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
                  width={TOP_BAR_ICON_SIZE}
                  height={TOP_BAR_ICON_SIZE}
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
                  width={TOP_BAR_ICON_SIZE}
                  height={TOP_BAR_ICON_SIZE}
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
                      nav.toImport({ fromTab: activeTab });
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
                      style={{ marginRight: "8px" }}
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
                      nav.toSettings({ fromTab: activeTab });
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
                      style={{ marginRight: "8px" }}
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
                    </svg>
                    <span>设置</span>
                  </button>
                  {/* 统计按钮 */}
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      nav.toStatistics({ fromTab: activeTab });
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
                      style={{ marginRight: "8px" }}
                    >
                      {/* 柱状图图标 */}
                      <rect x="3" y="12" width="4" height="8" rx="1" stroke="#333" strokeWidth="1.5" fill="none" />
                      <rect x="10" y="8" width="4" height="12" rx="1" stroke="#333" strokeWidth="1.5" fill="none" />
                      <rect x="17" y="4" width="4" height="16" rx="1" stroke="#333" strokeWidth="1.5" fill="none" />
                    </svg>
                    <span>统计</span>
                  </button>
                  {/* 关于按钮 */}
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      nav.toAbout();
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
                      style={{ marginRight: "8px" }}
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
            </>
          }
        />
      )}

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
                暂无书籍
              </div>
              <div style={{ fontSize: "14px" }}>
                通过右上角“更多”中的“导入”添加书籍
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
              暂无分组
            </div>
            <div style={{ fontSize: "14px" }}>
              通过右上角“更多”中的“导入”添加书籍
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
        <div
          onClick={() => {
            if (isEditingGroupName || justFinishedEditingRef.current) {
              // 如果正在编辑或刚结束编辑，点击外部仅触发 blur 提交/退出编辑态，不关闭详情页
              return;
            }
            if (groupDetailSelectionActive) {
              const evt = new Event("goread:group-detail:exit-selection");
              window.dispatchEvent(evt);
              return;
            }
            nav.toBookshelf("all", { replace: true });
            setGroupDetailSelectionActive(false);
            setGroupDetailSelectedCount(0);
          }}
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(225,225,225,0.6)",
            backdropFilter: "blur(12px)",
            WebkitBackdropFilter: "blur(12px)",
            zIndex: 100,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {groupDetailSelectionActive && (
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                position: "fixed",
                top: 0,
                left: 0,
                right: 0,
                background: "#fff",
                display: "flex",
                alignItems: "center",
                padding: `calc(${getSafeAreaInsets().top} + 12px) 16px 12px 16px`,
                zIndex: 101,
              }}
            >
              <button
                onClick={() => {
                  // 直接使用路由回退退出选择模式，避免事件传递不稳定
                  nav.goBack();
                }}
                style={{
                  background: "transparent",
                  border: "none",
                  boxShadow: "none",
                  borderRadius: 0,
                  outline: "none",
                  WebkitAppearance: "none",
                  MozAppearance: "none",
                  appearance: "none",
                  WebkitTapHighlightColor: "transparent",
                  padding: 0,
                  cursor: "pointer",
                  marginLeft: "-6px",
                }}
                title="返回"
              >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                  <path d="M14 18l-6-6 6-6" stroke="#333" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <span style={{ fontSize: 16, color: "#333", marginLeft: 8, fontWeight: 600, display: "inline-flex", alignItems: "center", height: "24px", lineHeight: "24px", transform: "translateY(-2px)" }}>
                已选中({groupDetailSelectedCount})
              </span>
              <div style={{ flex: 1 }} />
              <div style={{ display: "flex", alignItems: "center" }}>
                <button
                  aria-label="删除"
                  title="删除"
                  style={{
                    background: "none",
                    border: "none",
                    boxShadow: "none",
                     borderRadius: 0,
                    cursor: groupDetailSelectedCount === 0 || dragActive ? "not-allowed" : "pointer",
                    opacity: groupDetailSelectedCount === 0 || dragActive ? 0.4 : 1,
                    padding: 0,
                    marginRight: 16,
                  }}
                  disabled={groupDetailSelectedCount === 0 || dragActive}
                  onClick={() => {
                    if (groupDetailSelectedCount === 0 || dragActive) return;
                    const evt = new Event("goread:group-detail:open-confirm");
                    window.dispatchEvent(evt);
                  }}
                >
                  <svg width="21" height="21" viewBox="0 0 24 24" fill="none">
                    <path d="M6 7h12" stroke={groupDetailSelectedCount === 0 || dragActive ? "#bbb" : "#333"} strokeWidth="2" strokeLinecap="round" />
                    <path d="M9 7V5h6v2" stroke={groupDetailSelectedCount === 0 || dragActive ? "#bbb" : "#333"} strokeWidth="2" strokeLinecap="round" />
                    <rect x="6" y="7" width="12" height="14" rx="2" stroke={groupDetailSelectedCount === 0 || dragActive ? "#bbb" : "#333"} strokeWidth="2" />
                  </svg>
                </button>
                <button
                  aria-label="全选"
                  title="全选"
                  style={{
                    background: "none",
                    border: "none",
                    boxShadow: "none",
                    borderRadius: 0,
                    cursor: "pointer",
                    padding: 0,
                  }}
                  onClick={() => {
                    const evt = new Event("goread:group-detail:select-all");
                    window.dispatchEvent(evt);
                  }}
                >
                  <svg width="21" height="21" viewBox="0 0 24 24" fill="none">
                    {(() => {
                      const allCount = (groups.find((g) => g.id === overlayGroupId)?.book_count || 0);
                      const isAll = allCount > 0 && groupDetailSelectedCount === allCount;
                      const stroke = isAll ? "#d23c3c" : "#333";
                      return (
                        <g>
                          <rect x="3" y="3" width="7" height="7" stroke={stroke} strokeWidth="2" />
                          <rect x="14" y="3" width="7" height="7" stroke={stroke} strokeWidth="2" />
                          <rect x="3" y="14" width="7" height="7" stroke={stroke} strokeWidth="2" />
                          <rect x="14" y="14" width="7" height="7" stroke={stroke} strokeWidth="2" />
                        </g>
                      );
                    })()}
                  </svg>
                </button>
              </div>
            </div>
          )}
          <div
            style={{
              width: "100%",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
            }}
          >
            {/* 标题在容器外居中 */}
            {/* 标题区域：支持点击编辑 */}
            {isEditingGroupName ? (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  marginBottom: "12px",
                }}
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  ref={editInputRef}
                  value={editingGroupName}
                  onChange={(e) => setEditingGroupName(e.target.value)}
                  onBlur={handleSaveGroupName}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.currentTarget.blur();
                    }
                  }}
                  style={{
                    fontSize: "16px",
                    fontWeight: 500,
                    color: "#333",
                    textAlign: "center",
                    border: "none",
                    background: "transparent",
                    outline: "none",
                    boxShadow: "none",
                    width: `${Math.max(2, editingGroupName.length * 1.3)}em`,
                    padding: "0",
                    fontFamily: "inherit",
                    caretColor: "#d23c3c",
                  }}
                  autoFocus
                />
                {editingGroupName && (
                  <button
                    onMouseDown={(e) => {
                      // 使用 onMouseDown 阻止默认行为，防止输入框失去焦点触发 blur
                      e.preventDefault();
                      setEditingGroupName("");
                      // 保持焦点
                      setTimeout(() => editInputRef.current?.focus(), 0);
                    }}
                    style={{
                      background: "transparent",
                      border: "none",
                      padding: "4px",
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      boxShadow: "none",
                      marginLeft: "4px",
                    }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                      <circle cx="12" cy="12" r="10" fill="#888" />
                      <path d="M8 8l8 8M16 8l-8 8" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                  </button>
                )}
              </div>
            ) : (
              <div
                onClick={(e) => {
                  e.stopPropagation();
                  if (groupDetailSelectionActive) return; // 选择模式下禁用编辑
                  const g = groups.find((g) => g.id === overlayGroupId);
                  if (g) {
                    setEditingGroupName(g.name);
                    setIsEditingGroupName(true);
                  }
                }}
                style={{
                  fontSize: "16px",
                  fontWeight: 500,
                  color: "#333",
                  textAlign: "center",
                  marginBottom: "12px",
                  cursor: "text",
                  borderBottom: "1px solid transparent",
                  display: "inline-block",
                  padding: "0 4px",
                  maxWidth: "80%",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis"
                }}
              >
                {groups.find((g) => g.id === overlayGroupId)?.name || "分组"}
              </div>
            )}
            {/* 抽屉主体：宽度占满，高度85%，居中位置 */}
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                width: "100%",
                height: "75vh",
                maxHeight: "75vh",
                overflow: "hidden",
                background: "#f7f7f7",
              }}
            >
              <div style={{ width: "100%", height: "100%" }}>
                <GroupDetail
                  groupIdProp={overlayGroupId}
                  onClose={() => {
                    nav.toBookshelf("all", { replace: true });
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

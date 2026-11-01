import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { groupService } from "../services";
import {
  GROUP_NAME_FONT_SIZE,
  GROUP_META_FONT_SIZE,
  GROUP_NAME_FONT_WEIGHT,
  CARD_INFO_MARGIN_TOP,
  GROUP_NAME_MARGIN_TOP,
  GROUP_META_MARGIN_TOP,
  SELECTION_ICON_SIZE,
  SELECTION_ICON_OFFSET_TOP,
  SELECTION_ICON_OFFSET_RIGHT,
  GROUP_COVER_PADDING,
  TOP_BAR_ICON_SIZE,
  GROUP_GRID_COLUMNS,
  GROUP_GRID_GAP,
} from "../constants/ui";
import { Toast } from "./Toast";
import { Loading } from "./Loading";
import { BookCard } from "./BookCard";
import { DndContext, closestCenter } from "@dnd-kit/core";
import { SortableContext, rectSortingStrategy } from "@dnd-kit/sortable";
import { getSafeAreaInsets } from "../utils/layout";
import { DRAG_TOUCH_TOLERANCE_PX, SELECTION_LONGPRESS_DELAY_MS } from "../constants/interactions";

// Bookshelf components
import { TopBar as BookshelfTopBar } from "./bookshelf/TopBar";
import type { BookshelfViewMode } from "./bookshelf/TopBar";
import { NasFileList } from "./bookshelf/NasFileList";
import { GroupDetailOverlay } from "./bookshelf/GroupDetailOverlay";
import FolderCover from "./bookshelf/FolderCover";
import ConfirmDeleteDrawer from "./bookshelf/ConfirmDeleteDrawer";
import CreateGroupDialog from "./bookshelf/CreateGroupDialog";
import { SortableBookItem } from "./bookshelf/SortableBookItem";
import { SelectionActionBar } from "./bookshelf/SelectionActionBar";
import MoveToGroupDrawer from "./bookshelf/MoveToGroupDrawer";
import { GroupListRow, BookListRow } from "./bookshelf/BookshelfListRows";

// Bookshelf hooks
import {
  useToast,
  useBookshelfState,
  useBooksData,
  useGroupsData,
  useGroupOverlay,
  useSelectionMode,
  useDragSort,
  useBookActions,
  useBookshelfLifecycle,
  useUngroupedBooks,
  useNasConnections,
} from "./bookshelf/hooks";

// 视图模式本地存储键：记忆书架网格/列表切换状态
const VIEW_MODE_STORAGE_KEY = "goread:bookshelf:viewMode";

export const Bookshelf: React.FC = () => {
  const { t } = useTranslation('bookshelf');
  const { t: tCommon } = useTranslation('common');

  // 1. 核心状态
  const state = useBookshelfState();
  const { nav, activeTab, loading, setLoading, query } = state;

  // 1.1 NAS 连接列表（动态网络书架页签，与「导入-NAS」页共享存储）
  const nasConnections = useNasConnections();
  // 当前 NAS 页签对应的连接（tab id 形如 nas:<连接id>；连接可能已被删除）
  const activeNasConnection = activeTab.startsWith("nas:")
    ? nasConnections.find((c) => c.id === activeTab.slice(4))
    : undefined;

  // 2. 数据管理
  const booksData = useBooksData(query);
  const { loadBooks, filteredBooks } = booksData;

  const groupsData = useGroupsData(query);
  const { groups, setGroups, loadGroups, filteredGroups } = groupsData;

  // 2.1 书架根目录未分组书籍（「本地」选项卡与分组平级直陈）
  const { loadUngroupedBooks, filteredUngroupedBooks } = useUngroupedBooks(query);

  // 3. 分组覆盖层
  const groupOverlay = useGroupOverlay(activeTab);
  const { groupOverlayOpen, overlayGroupId, lastGroupCloseTimeRef } = groupOverlay;

  // 4. 选择模式
  const selection = useSelectionMode({
    activeTab,
    activeGroupId: nav.activeGroupId,
    filteredBooks,
    filteredGroups,
    filteredUngroupedBooks,
  });
  const {
    selectionMode,
    selectedBookIds,
    setSelectedBookIds,
    selectedGroupIds,
    selectedCount,
    confirmOpen,
    setConfirmOpen,
    onBookLongPress,
    onGroupLongPress,
    exitSelection,
    selectAllCurrent,
    toggleBookSelection,
    toggleGroupSelection,
  } = selection;

  // 5. 拖拽排序
  const dragSort = useDragSort({
    activeTab,
    selectionMode,
    groupOverlayOpen,
    importOpen: false,
    // 动态 NAS 页签 id 列表（滑动切换页签时构造 tab 序列）
    nasTabIds: nasConnections.map((c) => c.id),
    lastGroupCloseTimeRef,
  });
  const {
    dragActive,
    sensors,
    onDragStart,
    onDragEnd,
    onDragCancel,
    swipeTouchStart,
    swipeTouchEnd,
  } = dragSort;

  // 6. Toast
  const toast = useToast();
  const { toastMsg, setToastMsg } = toast;

  // 6.1 新建文件夹（分组）抽屉状态
  const [createGroupOpen, setCreateGroupOpen] = useState(false);
  const [createGroupLoading, setCreateGroupLoading] = useState(false);

  // 6.2 「移动到」分组选择抽屉状态（选择模式批量移动书籍）
  const [moveDrawerOpen, setMoveDrawerOpen] = useState(false);
  const [moving, setMoving] = useState(false);

  // 6.3 书架视图模式（grid=网格卡片，list=列表行），从 localStorage 恢复，默认网格
  const [viewMode, setViewMode] = useState<BookshelfViewMode>(() => {
    try {
      return localStorage.getItem(VIEW_MODE_STORAGE_KEY) === "list" ? "list" : "grid";
    } catch {
      return "grid";
    }
  });

  /**
   * 切换书架视图模式（网格/列表互切）并持久化到 localStorage
   * 无参数；持久化失败（如隐私模式）时仅影响下次启动的记忆，不影响本次切换
   */
  const handleToggleViewMode = () => {
    setViewMode((prev) => {
      const next: BookshelfViewMode = prev === "grid" ? "list" : "grid";
      try {
        localStorage.setItem(VIEW_MODE_STORAGE_KEY, next);
      } catch {
        // 忽略持久化异常
      }
      return next;
    });
  };

  /**
   * 创建文件夹（分组）
   * 先按名称查重，再调用分组服务创建；成功后广播分组变化事件并刷新分组列表
   * @param name 文件夹名称（已去除首尾空白）
   */
  const handleCreateGroup = async (name: string) => {
    setCreateGroupLoading(true);
    try {
      const existing = await groupService.findGroupByName(name);
      if (existing) {
        setToastMsg(t("folderNameExists"));
        return;
      }
      await groupService.addGroup(name);
      window.dispatchEvent(new CustomEvent("goread:groups:changed"));
      await loadGroups();
      setCreateGroupOpen(false);
      setToastMsg(t("folderCreated"));
    } catch (e) {
      setToastMsg(tCommon("groupCreateFailed"));
    } finally {
      setCreateGroupLoading(false);
    }
  };

  /**
   * 批量移动选中书籍到目标分组
   * 仅书籍参与移动（分组选中不参与）；逐本调用分组移动服务，
   * 成功后广播分组变化事件、刷新书籍/分组/未分组列表并退出选择模式
   * @param groupId 目标分组 id；null 表示移出分组
   */
  const handleMoveToGroup = async (groupId: number | null) => {
    if (moving) return;
    if (selectedBookIds.size === 0) {
      setToastMsg(t("moveNoBooks"));
      setMoveDrawerOpen(false);
      return;
    }
    setMoving(true);
    try {
      for (const bookId of selectedBookIds) {
        await groupService.moveBookToGroup(bookId, groupId ?? undefined);
      }
      window.dispatchEvent(new CustomEvent("goread:groups:changed"));
      await Promise.all([loadBooks(), loadGroups(), loadUngroupedBooks()]);
      setMoveDrawerOpen(false);
      exitSelection();
      setToastMsg(t("moveSuccess"));
    } catch (e) {
      setToastMsg(t("moveFailed"));
    } finally {
      setMoving(false);
    }
  };

  // 7. 动作处理
  const { handleBookClick, handleDeleteBook, confirmDelete } = useBookActions({
    nav,
    activeTab,
    selectionMode,
    toggleBookSelection,
    setSelectedBookIds,
    setConfirmOpen,
    selectedBookIds,
    selectedGroupIds,
    loadBooks,
    loadGroups,
    exitSelection,
  });

  // 8. 生命周期 (初始加载)
  useBookshelfLifecycle(loadBooks, loadGroups, setLoading);

  // 书架根目录未分组书籍初始加载（后续由 books/groups 变化事件驱动刷新）
  useEffect(() => {
    loadUngroupedBooks();
  }, [loadUngroupedBooks]);

  // 8.1 全局底部菜单栏联动
  // 选择模式下隐藏全局底部菜单栏，让位于批量操作栏；退出选择或离开书架时恢复显示
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("goread:globalbar:visible", { detail: !selectionMode })
    );
    return () => {
      window.dispatchEvent(new CustomEvent("goread:globalbar:visible", { detail: true }));
    };
  }, [selectionMode]);

  // 底部菜单"书架"入口在书架页内的联动：处于分组详情时返回书架根目录
  useEffect(() => {
    const handleBookshelfClick = () => {
      if (nav.activeGroupId) nav.closeGroup();
    };
    window.addEventListener("goread:globalbar:bookshelf", handleBookshelfClick);
    return () =>
      window.removeEventListener("goread:globalbar:bookshelf", handleBookshelfClick);
  }, [nav]);

  if (loading) {
    return (
      <Loading
        visible
        overlay={false}
        text={tCommon('loading')}
        showSpinner={false}
        textStyle={{ fontSize: 16 }}
        style={{ height: '100vh' }}
      />
    );
  }

  return (
    <div
      style={{
        padding: `calc(${getSafeAreaInsets().top} + 16px) 8px 16px 16px`,
        height: "100vh",
        // border-box 契约：与统计/设置/关于一致，padding 从 100vh 内部扣除；
        // 默认 content-box 会被 padding 撑出视口，内部滚动区底部避让失准，末尾内容被全局底栏遮挡
        boxSizing: "border-box",
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
        onCreateCategory={() => setCreateGroupOpen(true)}
        onMoveFiles={() =>
          nav.toBookshelf(activeTab, {
            state: { selectionMode: true },
            replace: false,
            resetStack: false,
          })
        }
        onDeleteFiles={() =>
          nav.toBookshelf(activeTab, {
            state: { selectionMode: true },
            replace: false,
            resetStack: false,
          })
        }
        viewMode={viewMode}
        onToggleViewMode={handleToggleViewMode}
        nasTabs={nasConnections.map((c) => ({ id: c.id, name: c.name }))}
        selectedCount={selectedCount}
        onExitSelection={exitSelection}
        selectionActions={
          <>
            <button
              aria-label="全选"
              title={
                activeTab === "recent"
                  ? selectedBookIds.size === (filteredBooks?.length || 0) &&
                    (filteredBooks?.length || 0) > 0
                    ? "取消全选"
                    : "全选"
                  : selectedGroupIds.size + selectedBookIds.size ===
                    (filteredGroups?.length || 0) + (filteredUngroupedBooks?.length || 0) &&
                    (filteredGroups?.length || 0) + (filteredUngroupedBooks?.length || 0) > 0
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
                      : (filteredGroups?.length || 0) +
                        (filteredUngroupedBooks?.length || 0);
                  const selCount =
                    activeTab === "recent"
                      ? selectedBookIds.size
                      : selectedGroupIds.size + selectedBookIds.size;
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
          // 统一底部避让：与统计/设置/关于一致，滚动到底时内容紧贴全局底栏顶边（变量含安全区高度）
          paddingBottom: "var(--goread-navbar-h)",
        }}
        onTouchStart={swipeTouchStart}
        onTouchEnd={swipeTouchEnd}
      >
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onDragCancel={onDragCancel}
        >
          {/* 选择模式顶部栏已合并到上方最近/本地/NAS 标签区域 */}
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
                viewMode === "grid" ? (
                <SortableContext
                  items={filteredBooks.map((b) => b.id)}
                  strategy={rectSortingStrategy}
                >
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: `repeat(${GROUP_GRID_COLUMNS}, minmax(0, 1fr))`,
                      gap: GROUP_GRID_GAP + "px",
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
                          toggleBookSelection(book.id);
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
                  <div>
                    {filteredBooks.map((book) => (
                      <BookListRow
                        key={book.id}
                        book={book}
                        selectable={selectionMode}
                        selected={selectedBookIds.has(book.id)}
                        onClick={() => handleBookClick(book)}
                        onLongPress={() => onBookLongPress(book.id)}
                        onToggleSelect={() => toggleBookSelection(book.id)}
                      />
                    ))}
                  </div>
                )
              ) : (
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: `repeat(${GROUP_GRID_COLUMNS}, minmax(0, 1fr))`,
                    gap: GROUP_GRID_GAP + "px",
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
                        toggleBookSelection(book.id);
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
          ) : activeTab.startsWith("nas:") ? (
            activeNasConnection ? (
              <NasFileList
                connection={activeNasConnection}
                onNotify={(msg) => setToastMsg(msg)}
                viewMode={viewMode}
              />
            ) : (
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
                <div style={{ fontSize: "18px" }}>
                  {t("nasConnectionMissing")}
                </div>
              </div>
            )
          ) : filteredGroups.length === 0 && filteredUngroupedBooks.length === 0 ? (
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
            <>
            {!query ? (
              viewMode === "grid" ? (
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: `repeat(${GROUP_GRID_COLUMNS}, minmax(0, 1fr))`,
                    gap: GROUP_GRID_GAP + "px",
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
                    >
                      <div
                        onClick={() => {
                          if (dragActive) return;
                          if (selectionMode) {
                            toggleGroupSelection(g.id);
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
                          <FolderCover />
                          {selectionMode && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                if (dragActive) return;
                                toggleGroupSelection(g.id);
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
                            {t("filesCount", { count: g.book_count })}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div>
                  {filteredGroups.map((g) => (
                    <GroupListRow
                      key={g.id}
                      group={g}
                      selectable={selectionMode}
                      selected={selectedGroupIds.has(g.id)}
                      onClick={() => {
                        if (dragActive) return;
                        if (selectionMode) {
                          toggleGroupSelection(g.id);
                        } else {
                          nav.openGroup(g.id);
                        }
                      }}
                      onLongPress={() => onGroupLongPress(g.id)}
                      onToggleSelect={() => toggleGroupSelection(g.id)}
                    />
                  ))}
                </div>
              )
            ) : (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: `repeat(${GROUP_GRID_COLUMNS}, minmax(0, 1fr))`,
                  gap: GROUP_GRID_GAP + "px",
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
                        toggleGroupSelection(g.id);
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
                      <FolderCover />
                      {selectionMode && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (dragActive) return;
                            toggleGroupSelection(g.id);
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
                        {t("filesCount", { count: g.book_count })}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {/* 书架根目录未分组书籍：与分组平级直接展示，不套分组 */}
            {filteredUngroupedBooks.length > 0 &&
              (!query && viewMode === "list" ? (
                <div style={{ marginTop: 8 }}>
                  {filteredUngroupedBooks.map((book) => (
                    <BookListRow
                      key={book.id}
                      book={book}
                      selectable={selectionMode}
                      selected={selectedBookIds.has(book.id)}
                      onClick={() => handleBookClick(book)}
                      onLongPress={() => onBookLongPress(book.id)}
                      onToggleSelect={() => toggleBookSelection(book.id)}
                    />
                  ))}
                </div>
              ) : (
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: `repeat(${GROUP_GRID_COLUMNS}, minmax(0, 1fr))`,
                    gap: GROUP_GRID_GAP + "px",
                    alignContent: "start",
                    gridAutoRows: "min-content",
                    marginTop: 16,
                  }}
                >
                  {filteredUngroupedBooks.map((book) => (
                    <BookCard
                      width="100%"
                      key={book.id}
                      book={book}
                      onClick={() => handleBookClick(book)}
                      onLongPress={() => onBookLongPress(book.id)}
                      selectable={selectionMode}
                      selected={selectedBookIds.has(book.id)}
                      onToggleSelect={() => {
                        toggleBookSelection(book.id);
                      }}
                      onDelete={() => {
                        if (dragActive) return;
                        handleDeleteBook(book);
                      }}
                    />
                  ))}
                </div>
              ))}
            </>
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

      <Toast message={toastMsg} onClose={() => setToastMsg("")} />
      <CreateGroupDialog
        open={createGroupOpen}
        loading={createGroupLoading}
        onCancel={() => {
          if (createGroupLoading) return;
          setCreateGroupOpen(false);
        }}
        onConfirm={handleCreateGroup}
      />
      <MoveToGroupDrawer
        open={moveDrawerOpen}
        groups={groups}
        loading={moving}
        onClose={() => {
          if (moving) return;
          setMoveDrawerOpen(false);
        }}
        onSelectGroup={handleMoveToGroup}
      />
      <ConfirmDeleteDrawer
        open={confirmOpen}
        context={activeTab === "recent" ? "recent" : "all"}
        count={selectedCount}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={confirmDelete}
      />

      {/* 选择模式底部操作栏（移动到/删除）；
          非选择模式的底部固定入口栏（书架/导入/统计/设置/关于）已由 MainLayout 的全局菜单栏统一渲染 */}
      {selectionMode && (
        <SelectionActionBar
          showMove={activeTab === "all"}
          disabled={dragActive || selectedCount === 0}
          onMove={() => setMoveDrawerOpen(true)}
          onDelete={() => {
            if (dragActive || selectedCount === 0) return;
            setConfirmOpen(true);
          }}
        />
      )}

    </div>
  );
};

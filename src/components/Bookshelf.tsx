import React, {
  useEffect,
} from "react";
import { useTranslation } from "react-i18next";

import { IBook } from "../types";
import { ensurePermissionForDeleteLocal, ensurePermissionForImport } from "../utils/storagePermission";
import { IconDelete } from "./Icons";
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
import { bookService, groupService } from "../services";
import { BookCard } from "./BookCard";
import { DndContext, closestCenter } from "@dnd-kit/core";
import { SortableContext, rectSortingStrategy } from "@dnd-kit/sortable";
import { getSafeAreaInsets } from "../utils/layout";
import { DRAG_TOUCH_TOLERANCE_PX, SELECTION_LONGPRESS_DELAY_MS } from "../constants/interactions";

// Bookshelf components
import { TopBar as BookshelfTopBar } from "./bookshelf/TopBar";
import { GroupDetailOverlay } from "./bookshelf/GroupDetailOverlay";
import GroupCoverGrid from "./bookshelf/GroupCoverGrid";
import ConfirmDeleteDrawer from "./bookshelf/ConfirmDeleteDrawer";
import { SortableItem } from "./bookshelf/SortableItem";
import { SortableBookItem } from "./bookshelf/SortableBookItem";

// Bookshelf hooks
import {
  useToast,
  useBookshelfState,
  useBooksData,
  useGroupsData,
  useGroupOverlay,
  useSelectionMode,
  useDragSort,
} from "./bookshelf/hooks";

export const Bookshelf: React.FC = () => {
  const { t } = useTranslation('bookshelf');
  const { t: tCommon } = useTranslation('common');

  // 1. 核心状态
  const state = useBookshelfState();
  const { nav, activeTab, loading, setLoading, menuOpen, setMenuOpen, query } = state;

  // 2. 数据管理
  const booksData = useBooksData(query);
  const { books, setBooks, loadBooks, filteredBooks } = booksData;

  const groupsData = useGroupsData(query);
  const { groups, setGroups, loadGroups, groupCovers, filteredGroups } = groupsData;

  // 3. 分组覆盖层
  const groupOverlay = useGroupOverlay(activeTab);
  const { groupOverlayOpen, overlayGroupId, lastGroupCloseTimeRef } = groupOverlay;

  // 4. 选择模式
  const selection = useSelectionMode({
    activeTab,
    activeGroupId: nav.activeGroupId,
    filteredBooks,
    filteredGroups,
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
    books,
    setBooks,
    groups,
    setGroups,
    selectionMode,
    groupOverlayOpen,
    menuOpen,
    importOpen: false,
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

  // 7. Toast
  const toast = useToast();
  const { toastMsg, setToastMsg } = toast;

  // 初始加载
  useEffect(() => {
    const init = async () => {
      setLoading(true);
      await loadBooks();
      await loadGroups();
      setLoading(false);
    };
    init();
  }, []);

  // 事件处理函数
  const handleBookClick = (book: IBook) => {
    if (selectionMode) {
      toggleBookSelection(book.id);
      return;
    }
    // 后端 mark_book_opened 会自动更新 recent_order，使该书移到最前
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
          ok = await confirm(`仅从"最近"中移除该书籍？不会删除书籍`, {
            title: "goread",
          });
        } catch {
          ok = window.confirm(`仅从"最近"中移除该书籍？不会删除书籍`);
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
          onDragEnd={onDragEnd}
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
                    gridTemplateColumns: `repeat(${GROUP_GRID_COLUMNS}, minmax(0, 1fr))`,
                    gap: GROUP_GRID_GAP + "px",
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
                          <GroupCoverGrid
                            covers={groupCovers[g.id] || []}
                            tileRatio="3 / 4"
                          />
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
                      <GroupCoverGrid
                        covers={groupCovers[g.id] || []}
                        tileRatio="3 / 4"
                      />
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

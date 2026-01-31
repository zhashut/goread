import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { IBook } from "../../../types";
import { bookService, groupService, logError } from "../../../services";
import { cacheConfigService } from "../../../services/cacheConfigService";
import { epubPreloader, isEpubFile } from "../../../services/formats/epub/epubPreloader";
import { mobiPreloader, isMobiFile } from "../../../services/formats/mobi/mobiPreloader";
import { ensurePermissionForDeleteLocal } from "../../../utils/storagePermission";

interface UseBookActionsProps {
  nav: any;
  activeTab: string;
  selectionMode: boolean;
  toggleBookSelection: (id: number) => void;
  toggleGroupSelection?: (id: number) => void;
  setSelectedBookIds: React.Dispatch<React.SetStateAction<Set<number>>>;
  setConfirmOpen: (open: boolean) => void;
  selectedBookIds: Set<number>;
  selectedGroupIds: Set<number>;
  loadBooks: () => Promise<void>;
  loadGroups: () => Promise<void>;
  exitSelection: () => void;
}

/**
 * 书架操作 Hook
 * 包含书籍点击、删除等业务逻辑
 */
export const useBookActions = ({
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
}: UseBookActionsProps) => {
  const { t } = useTranslation('bookshelf');

  const handleBookClick = useCallback((book: IBook) => {
    if (selectionMode) {
      toggleBookSelection(book.id);
      return;
    }
    // EPUB 预加载：提前触发书籍加载，利用页面切换时间完成 ZIP 解析
    if (isEpubFile(book.file_path)) {
      epubPreloader.preload(book.file_path);
    }
    // MOBI 预加载：提前触发书籍加载，利用页面切换时间完成解析
    if (isMobiFile(book.file_path)) {
      mobiPreloader.preload(book.file_path);
    }
    // 后端 mark_book_opened 会自动更新 recent_order，使该书移到最前
    nav.toReader(book.id, { fromTab: activeTab });
  }, [selectionMode, toggleBookSelection, nav, activeTab]);

  const handleDeleteBook = useCallback(async (book: IBook) => {
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
        // 清理 EPUB 相关缓存（预加载、内存、磁盘）
        cacheConfigService.clearCache(book.file_path).catch((err) => {
          logError(`[Bookshelf] 删除书籍后清理缓存失败: ${err}`).catch(() => {});
        });
        await Promise.all([loadBooks(), loadGroups()]);
      }
    } catch (error: any) {
      const msg =
        typeof error?.message === "string" ? error.message : String(error);
      alert(t('deleteBookFailedWithReason', { reason: msg }));
    }
  }, [selectionMode, activeTab, setSelectedBookIds, setConfirmOpen, bookService, loadBooks, loadGroups, cacheConfigService, t]);

  const confirmDelete = useCallback(async (deleteLocal?: boolean) => {
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
      alert(t('deleteFailed'));
    }
  }, [activeTab, selectedBookIds, selectedGroupIds, bookService, groupService, loadBooks, loadGroups, exitSelection, t]);

  return {
    handleBookClick,
    handleDeleteBook,
    confirmDelete,
  };
};

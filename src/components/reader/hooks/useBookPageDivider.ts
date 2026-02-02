import { useState, useEffect, useCallback } from 'react';
import { bookService } from '../../../services/bookService';
import { IBook } from '../../../types';
import { logError } from '../../../services/commonService';

const STORAGE_KEY_PREFIX = 'book_hide_divider:';

export interface UseBookPageDividerResult {
  hideDivider: boolean;
  setHideDivider: (hide: boolean) => Promise<void>;
  loading: boolean;
}

/**
 * 管理书籍页分隔线隐藏状态的 Hook
 * 支持 DB 持久化（内部书籍）与 LocalStorage 持久化（外部文件/旧版本兜底）
 */
export const useBookPageDivider = (book?: IBook | null): UseBookPageDividerResult => {
  const [hideDivider, setHideState] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);

  // 初始化读取
  useEffect(() => {
    if (!book) {
      setLoading(false);
      return;
    }

    const loadState = async () => {
      try {
        // 1. 优先使用书籍对象中的字段（如果已通过 updateBookHideDivider 更新并同步回 frontend book store）
        // 注意：这里假设父组件传入的 book 是最新的，或者至少包含该字段
        // 但首次打开时 book 对象来自 DB，应该由后端填充该字段
        if (typeof book.hide_divider === 'boolean') {
          setHideState(book.hide_divider);
        } else {
          // 2. 兜底：检查 LocalStorage (用于外部文件或未迁移的老数据)
          // 键格式：book_hide_divider:<id> 或 book_hide_divider:external:<path>
          const key = book.id 
            ? `${STORAGE_KEY_PREFIX}${book.id}`
            : `${STORAGE_KEY_PREFIX}external:${book.file_path}`;
            
          const saved = localStorage.getItem(key);
          if (saved !== null) {
            setHideState(saved === 'true');
          } else {
            setHideState(false); // 默认显示
          }
        }
      } catch (error) {
        logError('Failed to load hide_divider state', { error: String(error) });
      } finally {
        setLoading(false);
      }
    };

    loadState();
  }, [book?.id, book?.file_path, book?.hide_divider]);

  // 更新状态
  const setHideDivider = useCallback(async (hide: boolean) => {
    if (!book) return;

    // 乐观更新
    setHideState(hide);

    try {
      if (book.id) {
        // 更新 DB
        await bookService.updateBookHideDivider(book.id, hide);
        
        // 可选：更新 LocalStorage 作为备份或缓存
        localStorage.setItem(`${STORAGE_KEY_PREFIX}${book.id}`, String(hide));
      } else {
        // 外部文件，仅更新 LocalStorage
        localStorage.setItem(`${STORAGE_KEY_PREFIX}external:${book.file_path}`, String(hide));
      }
    } catch (error) {
      logError('Failed to save hide_divider state', { error: String(error) });
      // 可以在这里回滚状态，但考虑到非关键功能，暂不回滚以避免 UI 跳变
    }
  }, [book]);

  return {
    hideDivider,
    setHideDivider,
    loading,
  };
};

import { useEffect } from "react";

/**
 * 书籍列表生命周期 Hook
 * 负责初始数据的加载
 */
export const useBookshelfLifecycle = (
  loadBooks: () => Promise<void>,
  loadGroups: () => Promise<void>,
  setLoading: (loading: boolean) => void
) => {
  // 初始加载
  useEffect(() => {
    const init = async () => {
      setLoading(true);
      await loadBooks();
      await loadGroups();
      setLoading(false);
    };
    init();
  }, [loadBooks, loadGroups, setLoading]);
};

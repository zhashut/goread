import { useEffect, useMemo, useState } from "react";
import { IBook } from "../types";
import { bookService, logError } from "../services";
import { normalizeAndroidPath } from "../utils/androidPath";

export const useImportedBooks = () => {
  const [allImportedBooks, setAllImportedBooks] = useState<IBook[]>([]);

  useEffect(() => {
    const loadImportedBooks = async () => {
      try {
        await bookService.initDatabase();
        const books = await bookService.getAllBooks();
        setAllImportedBooks(books);
      } catch (error) {
        await logError('加载已导入书籍失败', { error: String(error) });
      }
    };
    loadImportedBooks();
  }, []);

  // 已导入路径集合：统一归一化 Android 别名路径（/sdcard → /storage/emulated/0），
  // 使历史记录中的 /sdcard 路径与扫描/浏览页返回的真实路径能够匹配
  const importedPaths = useMemo(
    () => new Set(allImportedBooks.map((b) => normalizeAndroidPath(b.file_path))),
    [allImportedBooks]
  );

  return { allImportedBooks, importedPaths };
};


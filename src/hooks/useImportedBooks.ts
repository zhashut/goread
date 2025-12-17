import { useEffect, useMemo, useState } from "react";
import { IBook } from "../types";
import { bookService } from "../services";

export const useImportedBooks = () => {
  const [allImportedBooks, setAllImportedBooks] = useState<IBook[]>([]);

  useEffect(() => {
    const loadImportedBooks = async () => {
      try {
        await bookService.initDatabase();
        const books = await bookService.getAllBooks();
        setAllImportedBooks(books);
      } catch (error) {
        console.error("加载已导入书籍失败:", error);
      }
    };
    loadImportedBooks();
  }, []);

  const importedPaths = useMemo(
    () => new Set(allImportedBooks.map((b) => b.file_path)),
    [allImportedBooks]
  );

  return { allImportedBooks, importedPaths };
};


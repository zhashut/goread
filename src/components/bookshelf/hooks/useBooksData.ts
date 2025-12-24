import { useState, useEffect, useMemo, useCallback } from "react";
import { IBook } from "../../../types";
import { bookService, getReaderSettings } from "../../../services";

/**
 * 对列表按本地存储的排序顺序排序
 */
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

/**
 * 管理书籍数据的 Hook
 * 负责书籍列表加载、排序、过滤、自动修复最近阅读顺序
 */
export const useBooksData = (query: string) => {
    const [books, setBooks] = useState<IBook[]>([]);

    const loadBooks = useCallback(async () => {
        try {
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
                            } catch { }
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
        }
    }, []);

    // 监听书籍变化事件
    useEffect(() => {
        const onChanged = () => {
            loadBooks();
        };
        window.addEventListener("goread:books:changed", onChanged as any);
        return () =>
            window.removeEventListener("goread:books:changed", onChanged as any);
    }, [loadBooks]);

    // 基于搜索关键词过滤
    const filteredBooks = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return books;
        return books.filter((b) => (b.title || "").toLowerCase().includes(q));
    }, [books, query]);

    return {
        books,
        setBooks,
        loadBooks,
        filteredBooks,
    };
};

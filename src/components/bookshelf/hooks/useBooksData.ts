import { useState, useEffect, useMemo, useCallback } from "react";
import { IBook } from "../../../types";
import { bookService, getReaderSettings } from "../../../services";

/**
 * 管理书籍数据的 Hook
 * 负责书籍列表加载、过滤
 * 排序由后端 recent_order 字段控制，前端直接使用后端返回的顺序
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
                // 不限制数量时，获取所有有阅读记录的书籍
                const allBooks = await bookService.getAllBooks();
                list = (allBooks || [])
                    .filter((b) => (b.last_read_time || 0) > 0)
                    .sort((a, b) => {
                        // 先按 recent_order 排序（值大的在前），再按 last_read_time 排序
                        const orderA = a.recent_order ?? 0;
                        const orderB = b.recent_order ?? 0;
                        if (orderB !== orderA) return orderB - orderA;
                        return (b.last_read_time || 0) - (a.last_read_time || 0);
                    });
            } else {
                const limit = Math.max(1, recentCount);
                try {
                    // 后端已按 recent_order 排序，直接使用返回顺序
                    const recent = await bookService.getRecentBooks(limit);
                    list = Array.isArray(recent) ? recent : [];
                } catch {
                    const allBooks = await bookService.getAllBooks();
                    list = (allBooks || [])
                        .filter((b) => (b.last_read_time || 0) > 0)
                        .sort((a, b) => {
                            const orderA = a.recent_order ?? 0;
                            const orderB = b.recent_order ?? 0;
                            if (orderB !== orderA) return orderB - orderA;
                            return (b.last_read_time || 0) - (a.last_read_time || 0);
                        })
                        .slice(0, limit);
                }
            }
            // 直接使用后端返回的顺序，无需前端再排序
            setBooks(list);
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

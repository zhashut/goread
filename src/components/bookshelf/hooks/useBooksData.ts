import { useState, useEffect, useMemo, useCallback } from "react";
import { IBook } from "../../../types";
import { bookService, getReaderSettings, logError } from "../../../services";

/**
 * 管理书籍数据的 Hook
 * 负责书籍列表加载、过滤
 * 「最近」列表聚合任意页签中阅读过的书籍：按最近阅读时间降序排列；
 * recent_order 仅作为“是否在最近列表”的标记（手动移除后清零），不再参与排序
 */
export const useBooksData = (query: string) => {
    const [books, setBooks] = useState<IBook[]>([]);

    const loadBooks = useCallback(async () => {
        try {
            await bookService.initDatabase();
            const settings = getReaderSettings();
            // 明确检查 undefined，允许 0 (不限)
            const recentCount = settings.recentDisplayCount !== undefined ? settings.recentDisplayCount : 9;
            const limit = recentCount > 0 ? Math.max(1, recentCount) : undefined;
            // 聚合任意页签中阅读过的书籍：筛选「最近」列表成员（recent_order > 0，
            // 手动移除后清零），按最近阅读时间降序排列；超出显示数量的书籍自动
            // 被挤出列表，但其阅读历史（last_read_time）仍保留
            const allBooks = await bookService.getAllBooks();
            let list = (allBooks || [])
                .filter((b) => (b.recent_order ?? 0) > 0)
                .sort((a, b) => (b.last_read_time || 0) - (a.last_read_time || 0));
            if (limit !== undefined) {
                list = list.slice(0, limit);
            }
            setBooks(list);
        } catch (error) {
            await logError('加载书籍列表失败', { error: String(error) });
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

import { useState, useEffect, useMemo, useCallback } from "react";
import { IBook } from "../../../types";
import { bookService, logError } from "../../../services";

/**
 * 书架根目录未分组书籍数据 Hook（「全部」选项卡使用）
 *
 * 加载 group_id 为空的书籍（即存放在书架根目录的书籍），
 * 监听书籍/分组变化事件自动刷新；分组移动会改变 group_id，
 * 因此两类事件都需要监听。
 *
 * 参数：query 搜索关键词（按书名过滤）
 * 返回值：ungroupedBooks 未分组书籍列表；loadUngroupedBooks 手动刷新方法
 */
export const useUngroupedBooks = (query: string) => {
    const [ungroupedBooks, setUngroupedBooks] = useState<IBook[]>([]);

    const loadUngroupedBooks = useCallback(async () => {
        try {
            const all = await bookService.getAllBooks();
            // group_id 为空即书架根目录书籍（未设置分组的书默认存放于此）；
            // NAS 网络书架缓存书（source === 'nas'）不占用本地书架，仅在「最近」页出现
            const list = (all || []).filter((b) => !b.group_id && b.source !== 'nas');
            // 根目录书籍统一按书名 A→Z 排序（中文按拼音）
            const collator = new Intl.Collator("zh-Hans-CN");
            list.sort((a, b) => collator.compare(a.title || "", b.title || ""));
            setUngroupedBooks(list);
        } catch (error) {
            await logError('加载未分组书籍失败', { error: String(error) });
            setUngroupedBooks([]);
        }
    }, []);

    // 监听书籍/分组变化事件（书籍增删、移动分组都会影响根目录内容）
    useEffect(() => {
        const onChanged = () => {
            loadUngroupedBooks();
        };
        window.addEventListener("goread:books:changed", onChanged as any);
        window.addEventListener("goread:groups:changed", onChanged as any);
        return () => {
            window.removeEventListener("goread:books:changed", onChanged as any);
            window.removeEventListener("goread:groups:changed", onChanged as any);
        };
    }, [loadUngroupedBooks]);

    // 基于搜索关键词过滤
    const filteredUngroupedBooks = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return ungroupedBooks;
        return ungroupedBooks.filter((b) => (b.title || "").toLowerCase().includes(q));
    }, [ungroupedBooks, query]);

    return {
        ungroupedBooks,
        loadUngroupedBooks,
        filteredUngroupedBooks,
    };
};

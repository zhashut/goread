import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { IBook, IBookmark } from "../../../types";
import { bookmarkService } from "../../../services";
import { TOAST_DURATION_SHORT_MS } from "../../../constants/config";

/**
 * 管理书签的 Hook
 * 负责获取书签列表、添加书签、删除书签以及书签提示气泡的状态管理
 */
export const useBookmarks = (book: IBook | null, isExternal: boolean) => {
    const { t: tCommon } = useTranslation("common");
    const [bookmarks, setBookmarks] = useState<IBookmark[]>([]);
    const [bookmarkToastVisible, setBookmarkToastVisible] = useState(false);
    const [bookmarkToastText, setBookmarkToastText] = useState("");

    // 加载书签
    useEffect(() => {
        if (isExternal || !book?.id) {
            setBookmarks([]);
            return;
        }

        let isMounted = true;
        bookmarkService
            .getBookmarks(book.id)
            .then((list) => {
                if (isMounted) {
                    setBookmarks(Array.isArray(list) ? list : []);
                }
            })
            .catch((e) => {
                console.warn("获取书签失败", e);
                if (isMounted) setBookmarks([]);
            });

        return () => {
            isMounted = false;
        };
    }, [book?.id, isExternal]);

    const showToast = useCallback((text: string, duration = TOAST_DURATION_SHORT_MS) => {
        setBookmarkToastText(text);
        setBookmarkToastVisible(true);
        setTimeout(() => setBookmarkToastVisible(false), duration);
    }, []);

    const addBookmark = useCallback(
        async (currentPage: number, title?: string) => {
            if (isExternal || !book) return false;
            try {
                const created = await bookmarkService.addBookmark(
                    book.id,
                    currentPage,
                    title || `第 ${currentPage} 页`
                );
                setBookmarks((prev) =>
                    [...prev, created].sort((a, b) => a.page_number - b.page_number)
                );
                showToast(tCommon("bookmarkAdded"));
                return true;
            } catch (e) {
                console.error("添加书签失败", e);
                alert(tCommon("addBookmarkFailed"));
                return false;
            }
        },
        [book, isExternal, tCommon, showToast]
    );

    const deleteBookmark = useCallback(
        async (id: number) => {
            if (isExternal) return false;
            try {
                await bookmarkService.deleteBookmark(id);
                setBookmarks((prev) => prev.filter((b) => b.id !== id));
                return true;
            } catch (e) {
                console.error("删除书签失败", e);
                alert(tCommon("deleteBookmarkFailed"));
                return false;
            }
        },
        [isExternal, tCommon]
    );

    return {
        bookmarks,
        bookmarkToastVisible,
        bookmarkToastText,
        addBookmark,
        deleteBookmark,
        setBookmarkToastVisible,
        setBookmarkToastText,
        setBookmarks,
        showToast,
    };
};

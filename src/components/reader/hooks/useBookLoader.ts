import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ExternalFileOpenPayload } from "../../../types";
import {
    bookService,
    bookmarkService,
    statsService,
    logError,
} from "../../../services";
import {
    IBookRenderer,
    getBookFormat,
    createRenderer,
    isFormatSupported,
} from "../../../services/formats";
import { resolveLocalPathFromUri } from "../../../services/resolveLocalPath";
import { useAppNav } from "../../../router/useAppNav";
import { useReaderState } from "./useReaderState";
import { useToc } from "./useToc";
import { useBookmarks } from "./useBookmarks";

// Defined locally or could be exported from a central type file
export interface ExternalFileEventDetail extends ExternalFileOpenPayload {
    path?: string;
}

type ReaderState = ReturnType<typeof useReaderState>;
type TocActions = Pick<ReturnType<typeof useToc>, "loadToc">;
type BookmarkActions = Pick<ReturnType<typeof useBookmarks>, "setBookmarks">;
type CleanupActions = {
    resetCache: () => void;
};

/**
 * 负责书籍加载流程的 Hook
 */
export const useBookLoader = (
    params: {
        bookId?: string;
        isExternal: boolean;
        externalFile?: ExternalFileEventDetail;
    },
    readerState: ReaderState,
    refs: {
        rendererRef: React.MutableRefObject<IBookRenderer | null>;
        modeVersionRef: React.MutableRefObject<number>;
        epubRenderedRef: React.MutableRefObject<boolean>;
    },
    tocActions: TocActions,
    bookmarkActions: BookmarkActions,
    cleanupActions: CleanupActions
) => {
    const { t: tCommon } = useTranslation("common");
    const nav = useAppNav();
    const {
        setBook,
        setCurrentPage,
        setTotalPages,
        setLoading,
        setExternalTitle,
        setExternalPath,
        setIsDomRender,
        bookIdRef,
    } = readerState;
    const { rendererRef, modeVersionRef, epubRenderedRef } = refs;

    const externalKey = params.externalFile
        ? params.externalFile.uri || params.externalFile.path || ""
        : "";

    useEffect(() => {
        const currentKey = params.isExternal
            ? externalKey || undefined
            : params.bookId;
        bookIdRef.current = currentKey;
        modeVersionRef.current += 1;

        if (rendererRef.current) {
            rendererRef.current.close();
            rendererRef.current = null;
        }
        epubRenderedRef.current = false;
        cleanupActions.resetCache();

        setLoading(true);
        setCurrentPage(1);
        setTotalPages(1);

        const loadBook = async () => {
            try {
                setLoading(true);
                const books = await bookService.getAllBooks();
                const targetBook = books.find((b) => b.id === parseInt(params.bookId!));

                if (!targetBook) {
                    alert(tCommon("bookNotFound"));
                    nav.toBookshelf();
                    return;
                }

                setBook(targetBook);
                setCurrentPage(targetBook.current_page);
                setTotalPages(targetBook.total_pages);

                if (targetBook.status === 1) {
                    try {
                        const hasRecords = await statsService.hasReadingSessions(
                            targetBook.id
                        );
                        if (!hasRecords) {
                            await statsService.unmarkBookFinished(targetBook.id);
                            targetBook.status = 0;
                            targetBook.finished_at = null;
                            setBook({ ...targetBook });
                        }
                    } catch (e) {
                        console.error(e);
                    }
                }

                if (!params.isExternal) {
                    try {
                        await bookService.markBookOpened(targetBook.id);
                        try {
                            const orderKey = "recent_books_order";
                            const orderStr = localStorage.getItem(orderKey);
                            let order: number[] = [];
                            if (orderStr) {
                                order = JSON.parse(orderStr);
                            }
                            order = order.filter((id) => id !== targetBook.id);
                            order.unshift(targetBook.id);
                            localStorage.setItem(orderKey, JSON.stringify(order));
                        } catch { }
                    } catch (e) {
                        console.warn("标记书籍已打开失败", e);
                    }
                }

                if (!isFormatSupported(targetBook.file_path)) {
                    const format = getBookFormat(targetBook.file_path);
                    alert(tCommon("unsupportedFormat", { format: format || "Unknown" }));
                    nav.toBookshelf();
                    return;
                }

                const renderer = createRenderer(targetBook.file_path);
                rendererRef.current = renderer;

                const useDom =
                    renderer.capabilities.supportsDomRender &&
                    !renderer.capabilities.supportsBitmap;
                setIsDomRender(useDom);

                const bookInfo = await renderer.loadDocument(targetBook.file_path);
                const pageCount = Math.max(
                    1,
                    bookInfo.pageCount ?? targetBook.total_pages ?? 1
                );
                setTotalPages(pageCount);
                setLoading(false);

                Promise.resolve().then(() => {
                    tocActions.loadToc(
                        renderer,
                        pageCount,
                        targetBook.title || "目录",
                        targetBook.file_path
                    );
                });

                Promise.resolve().then(async () => {
                    try {
                        const list = await bookmarkService.getBookmarks(targetBook.id);
                        bookmarkActions.setBookmarks(Array.isArray(list) ? list : []);
                    } catch (e) {
                        console.warn("获取书签失败", e);
                        bookmarkActions.setBookmarks([]);
                    }
                });
            } catch (error) {
                await logError("加载书籍失败", { error: String(error) });
                alert(tCommon("loadBookFailed"));
            }
        };

        const loadExternal = async (file: ExternalFileEventDetail) => {
            try {
                setLoading(true);
                setBook(null);
                bookmarkActions.setBookmarks([]);
                setExternalPath(null);

                const rawPath = file.path || file.uri;
                if (!rawPath) {
                    alert(tCommon("operationFailed"));
                    nav.toBookshelf();
                    return;
                }

                let filePath = rawPath;
                try {
                    filePath = await resolveLocalPathFromUri(rawPath);
                } catch (e) {
                    console.error("解析外部文件本地路径失败", e);
                    alert(tCommon("operationFailed"));
                    nav.toBookshelf();
                    return;
                }

                if (!isFormatSupported(filePath)) {
                    const format = getBookFormat(filePath);
                    alert(tCommon("unsupportedFormat", { format: format || "Unknown" }));
                    nav.toBookshelf();
                    return;
                }

                const renderer = createRenderer(filePath);
                rendererRef.current = renderer;

                const useDom =
                    renderer.capabilities.supportsDomRender &&
                    !renderer.capabilities.supportsBitmap;
                setIsDomRender(useDom);

                const bookInfo = await renderer.loadDocument(filePath);
                const pageCount = Math.max(1, bookInfo.pageCount ?? 1);

                setTotalPages(pageCount);
                setCurrentPage(1);
                setLoading(false);
                setExternalPath(filePath);

                const title =
                    file.displayName ||
                    bookInfo.title ||
                    (filePath.split(/[/\\]/).pop() || "");
                setExternalTitle(title);

                Promise.resolve().then(() => {
                    tocActions.loadToc(renderer, pageCount, title, filePath);
                });
            } catch (error) {
                await logError("加载书籍失败 failed", { error: String(error) });
                alert(tCommon("loadBookFailed"));
            }
        };

        if (params.isExternal) {
            if (
                params.externalFile &&
                (params.externalFile.uri || params.externalFile.path)
            ) {
                loadExternal(params.externalFile);
            } else {
                setLoading(false);
            }
        } else {
            if (params.bookId) {
                loadBook();
            } else {
                setLoading(false);
            }
        }

        return () => {
            if (rendererRef.current) {
                rendererRef.current.close();
                rendererRef.current = null;
            }
            cleanupActions.resetCache();
        };
    }, [params.bookId, params.isExternal, externalKey]);
};

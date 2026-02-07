import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ExternalFileOpenPayload } from "../../../types";
import {
    bookService,
    bookmarkService,
    statsService,
    logError,
} from "../../../services";
import { rebuildSingleBookCover } from "../../../utils/coverUtils";
import {
    IBookRenderer,
    getBookFormat,
    createRenderer,
    isFormatSupported,
} from "../../../services/formats";
import { EpubRenderer } from "../../../services/formats/epub/EpubRenderer";
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
        readingMode?: string;
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

    // 用于追踪当前已成功加载的书籍标识和 renderer 引用
    // 这个 ref 不会被 cleanup 清除，只在书籍标识变化时更新
    const loadedStateRef = useRef<{ key: string | undefined, renderer: IBookRenderer | null }>({ key: undefined, renderer: null });
    const prevReadingModeRef = useRef<string | undefined>(params.readingMode);

    useEffect(() => {
        const currentKey = params.isExternal
            ? externalKey || undefined
            : params.bookId;

        // 检查模式变化 (仅针对 EPUB): 如果模式改变，强制不复用旧 renderer，从而触发重载
        if (
            loadedStateRef.current.key === currentKey &&
            loadedStateRef.current.renderer instanceof EpubRenderer &&
            prevReadingModeRef.current !== params.readingMode &&
            prevReadingModeRef.current !== undefined
        ) {
            // 模式变化，标记为需要重新加载
            loadedStateRef.current = { key: undefined, renderer: null };
            // 注意：旧 renderer 会在下面的逻辑中被 rendererRef 替换或在 close() 中被清理（如果它是当前的）
            // 但 loadedStateRef 中的引用被丢弃了，所以 createRenderer 会被再次调用
        }
        prevReadingModeRef.current = params.readingMode;

        // 如果书籍标识未变化且之前已成功加载 renderer，复用它
        if (loadedStateRef.current.key === currentKey && loadedStateRef.current.renderer) {
            // 恢复 rendererRef 引用（可能被 cleanup 清除了）
            rendererRef.current = loadedStateRef.current.renderer;
            setLoading(false);
            return;
        }

        // 如果书籍标识未变化但 renderer 正在加载中（key 已设置但 renderer 为 null），跳过
        if (loadedStateRef.current.key === currentKey && loadedStateRef.current.renderer === null) {
            return;
        }

        // 仅在书籍标识变化时关闭旧 renderer
        if (loadedStateRef.current.key !== currentKey && loadedStateRef.current.renderer) {
            loadedStateRef.current.renderer.close();
        }

        // 同步设置 key，标记"正在加载"状态（renderer 为 null）
        // 这样 React Strict Mode 第二次运行时会进入上面的"跳过"分支
        loadedStateRef.current = { key: currentKey, renderer: null };

        bookIdRef.current = currentKey;
        modeVersionRef.current += 1;

        // 清理 rendererRef
        rendererRef.current = null;
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
                // 使用 precise_progress（浮点数）恢复精确位置，若不存在则回退到 current_page
                const initialProgress = targetBook.precise_progress ?? targetBook.current_page;
                setCurrentPage(initialProgress);
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
                        await logError('检查阅读记录失败', { error: String(e), bookId: targetBook.id });
                    }
                }

                if (!params.isExternal) {
                    try {
                        // 后端 mark_book_opened 会自动更新 last_read_time 和 recent_order
                        // 同时检查封面文件是否存在，返回是否需要重建
                        const needsRebuild = await bookService.markBookOpened(targetBook.id);

                        // 如果需要重建封面，异步触发重建（不阻塞阅读）
                        if (needsRebuild) {
                            rebuildSingleBookCover(targetBook).catch((e) => {
                                logError('重建封面失败', { error: String(e), bookId: targetBook.id });
                            });
                        }
                    } catch (e) {
                        await logError('标记书籍已打开失败', { error: String(e), bookId: targetBook.id });
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
                // 保存到 loadedStateRef，用于后续复用
                loadedStateRef.current = { key: currentKey, renderer };

                const useDom =
                    renderer.capabilities.supportsDomRender &&
                    !renderer.capabilities.supportsBitmap;
                setIsDomRender(useDom);

                // 在 loadDocument 之前设置期望的阅读模式
                // 横向模式需要同步加载，纵向模式可使用懒加载
                if (renderer instanceof EpubRenderer) {
                    const expectedMode = targetBook.reading_mode || 'vertical';
                    renderer.setExpectedReadingMode(expectedMode);
                }

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
                // 保存到 loadedStateRef，用于后续复用
                loadedStateRef.current = { key: currentKey, renderer };

                const useDom =
                    renderer.capabilities.supportsDomRender &&
                    !renderer.capabilities.supportsBitmap;
                setIsDomRender(useDom);

                // 外部文件默认使用纵向模式，可使用懒加载
                if (renderer instanceof EpubRenderer) {
                    renderer.setExpectedReadingMode('vertical');
                }

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
            // cleanup 时不关闭 loadedStateRef 中的 renderer，只清理 rendererRef 引用
            // 这样 React Strict Mode 双重调用时，下一次 effect 可以复用之前的 renderer
            rendererRef.current = null;
            // 注意：不重置 cleanupActions.resetCache()，因为 renderer 仍然有效
            // cleanupActions.resetCache();
        };
    }, [params.bookId, params.isExternal, externalKey, params.readingMode]);
};

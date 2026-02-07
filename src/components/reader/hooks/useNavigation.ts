import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { bookService, statsService, logError } from "../../../services";
import { MarkdownRenderer } from "../../../services/formats/markdown/MarkdownRenderer";
import { MobiRenderer } from "../../../services/formats/mobi/MobiRenderer";
import { EpubRenderer } from "../../../services/formats/epub/EpubRenderer";
import { HtmlRenderer } from "../../../services/formats/html/HtmlRenderer";
import { TxtRenderer } from "../../../services/formats/txt/TxtRenderer";
import { useReaderState } from "./useReaderState";
import { usePageRenderer } from "./usePageRenderer";
import { useToc } from "./useToc";
import { IBookRenderer } from "../../../services/formats";

type NavigationProps = {
    readerState: ReturnType<typeof useReaderState>;
    pageRenderer: Pick<
        ReturnType<typeof usePageRenderer>,
        "renderPage" | "renderPageToTarget" | "getSmartPredictor" | "renderedPagesRef"
    >;
    tocData: Pick<ReturnType<typeof useToc>, "toc">;
    refs: {
        verticalCanvasRefs: React.MutableRefObject<Map<number, HTMLCanvasElement>>;
        rendererRef: React.MutableRefObject<IBookRenderer | null>;
    };
    data: {
        readingMode: "horizontal" | "vertical";
        isExternal: boolean;
        markReadingActive: () => void;
    };
};

/**
 * 导航逻辑 Hook
 * 负责页面跳转 (goToPage, next/prev)，章节跳转，以及处理完成状态切换
 */
export const useNavigation = ({
    readerState,
    pageRenderer,
    tocData,
    refs,
    data,
}: NavigationProps) => {
    const { t: tCommon } = useTranslation("common");
    const {
        currentPage,
        setCurrentPage,
        totalPages,
        isDomRender,
        book,
        setBook,
        latestPreciseProgressRef,
    } = readerState;
    const { verticalCanvasRefs, rendererRef } = refs;
    const { readingMode, isExternal, markReadingActive } = data;

    const goToPage = useCallback(
        async (pageNum: number) => {
            // 提取整数页码，用于边界检查和 currentPage 更新
            const intPage = Math.floor(pageNum);
            if (intPage < 1 || intPage > totalPages) return;

            markReadingActive();

            // 对于 Mobi 格式，页码由内部滚动监听驱动的 onPageChange 回调统一更新
            // 其他格式需要提前设置页码（使用整数部分）
            const renderer = rendererRef.current;
            const isMobi = renderer && renderer instanceof MobiRenderer;
            const isEpub = renderer && renderer instanceof EpubRenderer;
            const isTxt = renderer && renderer instanceof TxtRenderer;

            // TXT 纵向模式：先更新精确进度，再更新整数页码
            // 这样 useTxtPaging 的 useEffect 能拿到正确的精确进度
            if (isTxt && (renderer as TxtRenderer).isVerticalMode() && latestPreciseProgressRef) {
                latestPreciseProgressRef.current = pageNum;
            }

            if (!isMobi) {
                setCurrentPage(intPage);
            }

            try {
                if (isDomRender) {
                    if (renderer && renderer instanceof MarkdownRenderer) {
                        const scrollContainer = renderer.getScrollContainer();
                        if (scrollContainer) {
                            const viewportHeight = scrollContainer.clientHeight;
                            renderer.scrollToVirtualPage(pageNum, viewportHeight);
                        }
                    } else if (renderer && renderer instanceof HtmlRenderer) {
                        const scrollContainer = renderer.getScrollContainer();
                        if (scrollContainer) {
                            const viewportHeight = scrollContainer.clientHeight;
                            renderer.scrollToVirtualPage(pageNum, viewportHeight);
                        }
                    } else if (renderer && renderer instanceof MobiRenderer) {
                        const scrollContainer = renderer.getScrollContainer();
                        if (scrollContainer) {
                            const viewportHeight = scrollContainer.clientHeight;
                            renderer.scrollToVirtualPage(pageNum, viewportHeight);
                        }
                    } else if (renderer && renderer instanceof EpubRenderer) {
                        // 传递完整的浮点数进度，渲染器内部处理精确位置恢复
                        await renderer.goToPage(pageNum);
                    } else if (renderer && renderer instanceof TxtRenderer) {
                        // TXT 纵向模式使用精确进度定位
                        if (renderer.isVerticalMode()) {
                            // 先更新精确进度，避免 useTxtPaging 的 useEffect 覆盖
                            renderer.updatePreciseProgress(pageNum);
                            const scrollContainer = renderer.getScrollContainer();
                            if (scrollContainer) {
                                const viewportHeight = scrollContainer.clientHeight;
                                renderer.scrollToVirtualPage(pageNum, viewportHeight);
                            }
                        } else {
                            // 横向模式使用整数页码
                            await renderer.goToPage(intPage);
                        }
                    }
                } else if (readingMode === "horizontal") {
                    // 强制渲染，因为是主动跳转
                    await pageRenderer.renderPage(intPage, true);
                } else {
                    // 纵向模式
                    const target = verticalCanvasRefs.current.get(intPage);
                    if (target) {
                        target.scrollIntoView({ behavior: "auto", block: "start" });
                    }
                    if (!pageRenderer.renderedPagesRef.current.has(intPage)) {
                        await pageRenderer.renderPageToTarget(intPage, target || null);
                    }
                }

                const predictor = pageRenderer.getSmartPredictor();
                if (predictor) {
                    predictor.recordPageVisit(intPage);
                }

                // Mobi 格式的进度由 onPageChange 回调保存，避免重复写入
                // EPUB 格式在精确进度恢复时，进度由渲染器内部回调更新
                if (!isExternal && book && !isMobi && !isEpub) {
                    bookService.updateBookProgress(book.id, intPage).catch(() => { });
                }
            } catch (e) {
                await logError('页面跳转失败', { error: String(e), pageNum });
            }
        },
        [
            totalPages,
            markReadingActive,
            setCurrentPage,
            isDomRender,
            rendererRef,
            readingMode,
            pageRenderer,
            verticalCanvasRefs,
            isExternal,
            book,
        ]
    );

    const nextPage = useCallback(() => {
        // EPUB 横向模式下，始终按章节整数跳转
        const renderer = rendererRef.current;
        if (readingMode === "horizontal" && renderer && renderer instanceof EpubRenderer) {
            const next = Math.floor(currentPage) + 1;
            goToPage(next);
            return;
        }
        goToPage(currentPage + 1);
    }, [goToPage, currentPage, readingMode, rendererRef]);

    const prevPage = useCallback(() => {
        // EPUB 横向模式下，始终按章节整数跳转
        const renderer = rendererRef.current;
        if (readingMode === "horizontal" && renderer && renderer instanceof EpubRenderer) {
            // 确保跳转到上一章的开头
            const prev = Math.floor(currentPage) - 1;
            goToPage(prev);
            return;
        }
        goToPage(currentPage - 1);
    }, [goToPage, currentPage, readingMode, rendererRef]);

    const toggleFinish = useCallback(async () => {
        if (isExternal || !book) return;
        const newStatus = book.status === 1 ? 0 : 1;

        setBook((prev) => (prev ? { ...prev, status: newStatus } : null));

        try {
            if (newStatus === 1) {
                await statsService.markBookFinished(book.id);
            } else {
                await statsService.unmarkBookFinished(book.id);
            }
        } catch (e) {
            setBook((prev) => (prev ? { ...prev, status: book.status } : null));
            alert(tCommon("operationFailed"));
        }
    }, [isExternal, book, setBook, tCommon]);

    // 辅助：查找当前章节页码
    const findCurrentChapterPage = useCallback(() => {
        const pages: number[] = [];
        const collect = (ns: typeof tocData.toc) => {
            for (const n of ns) {
                if (typeof n.page === "number") pages.push(n.page);
                if (n.children && n.children.length) collect(n.children);
            }
        };
        collect(tocData.toc);
        pages.sort((a, b) => a - b);
        let target: number | undefined = undefined;
        for (const p of pages) {
            if (p <= currentPage) target = p;
            else break;
        }
        return target;
    }, [tocData.toc, currentPage]);

    const prevChapter = useCallback(() => {
        const page = findCurrentChapterPage();
        if (typeof page === "number" && page < currentPage) {
            goToPage(page);
        } else {
            prevPage();
        }
    }, [findCurrentChapterPage, currentPage, goToPage, prevPage]);

    const nextChapter = useCallback(() => {
        const pages: number[] = [];
        const collect = (ns: typeof tocData.toc) => {
            for (const n of ns) {
                if (typeof n.page === "number") pages.push(n.page);
                if (n.children && n.children.length) collect(n.children);
            }
        };
        collect(tocData.toc);
        pages.sort((a, b) => a - b);
        const target = pages.find((p) => p > currentPage);
        if (typeof target === "number") {
            goToPage(target);
        } else {
            nextPage();
        }
    }, [tocData.toc, currentPage, goToPage, nextPage]);

    return {
        goToPage,
        nextPage,
        prevPage,
        toggleFinish,
        prevChapter,
        nextChapter,
        findCurrentChapterPage
    };
};

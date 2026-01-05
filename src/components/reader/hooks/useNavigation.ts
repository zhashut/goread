import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { bookService, statsService, logError } from "../../../services";
import { MarkdownRenderer } from "../../../services/formats/markdown/MarkdownRenderer";
import { EpubRenderer } from "../../../services/formats/epub/EpubRenderer";
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
    } = readerState;
    const { verticalCanvasRefs, rendererRef } = refs;
    const { readingMode, isExternal, markReadingActive } = data;

    const goToPage = useCallback(
        async (pageNum: number) => {
            if (pageNum < 1 || pageNum > totalPages) return;

            markReadingActive();
            setCurrentPage(pageNum);

            try {
                if (isDomRender) {
                    const renderer = rendererRef.current;
                    if (renderer && renderer instanceof MarkdownRenderer) {
                        const scrollContainer = renderer.getScrollContainer();
                        if (scrollContainer) {
                            const viewportHeight = scrollContainer.clientHeight;
                            renderer.scrollToVirtualPage(pageNum, viewportHeight);
                        }
                    } else if (renderer && renderer instanceof EpubRenderer) {
                        await renderer.goToPage(pageNum);
                    }
                } else if (readingMode === "horizontal") {
                    // 强制渲染，因为是主动跳转
                    await pageRenderer.renderPage(pageNum, true);
                } else {
                    // 纵向模式
                    const target = verticalCanvasRefs.current.get(pageNum);
                    if (target) {
                        target.scrollIntoView({ behavior: "auto", block: "start" });
                    }
                    if (!pageRenderer.renderedPagesRef.current.has(pageNum)) {
                        await pageRenderer.renderPageToTarget(pageNum, target || null);
                    }
                }

                const predictor = pageRenderer.getSmartPredictor();
                if (predictor) {
                    predictor.recordPageVisit(pageNum);
                }

                if (!isExternal && book) {
                    bookService.updateBookProgress(book.id, pageNum).catch(() => { });
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

    const nextPage = useCallback(() => goToPage(currentPage + 1), [goToPage, currentPage]);
    const prevPage = useCallback(() => goToPage(currentPage - 1), [goToPage, currentPage]);

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

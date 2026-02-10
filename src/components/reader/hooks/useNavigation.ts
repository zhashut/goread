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
import { TocNode } from "../types";

type NavigationProps = {
    readerState: ReturnType<typeof useReaderState>;
    pageRenderer: Pick<
        ReturnType<typeof usePageRenderer>,
        "renderPage" | "renderPageToTarget" | "getSmartPredictor" | "renderedPagesRef"
    >;
    tocData: Pick<ReturnType<typeof useToc>, "toc" | "activeNodeSignature">;
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
        setContentReady,
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

            const renderer = rendererRef.current;
            const isMobi = renderer && renderer instanceof MobiRenderer;
            const isEpub = renderer && renderer instanceof EpubRenderer;
            const isTxt = renderer && renderer instanceof TxtRenderer;

            markReadingActive();

            if (
                isDomRender &&
                renderer &&
                renderer instanceof EpubRenderer &&
                readingMode === "vertical" &&
                Math.abs(pageNum - currentPage) > 1
            ) {
                setContentReady(false);
            }

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
                        if (latestPreciseProgressRef) {
                            latestPreciseProgressRef.current = pageNum;
                        }
                        await renderer.jumpToPreciseProgress(pageNum);
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

                if (!isExternal && book && !isMobi && !isEpub) {
                    let progressToSave: number = intPage;
                    if (renderer && renderer instanceof TxtRenderer) {
                        try {
                            const precise = renderer.getPreciseProgress();
                            if (precise > 0 && isFinite(precise)) {
                                progressToSave = precise;
                            }
                        } catch {
                        }
                    }
                    bookService.updateBookProgress(book.id, progressToSave).catch(() => { });
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
            currentPage,
            latestPreciseProgressRef,
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

    // 收集并排序所有章节页码
    const chapterPages = useCallback(() => {
        const pages: number[] = [];
        const collect = (ns: TocNode[]) => {
            for (const n of ns) {
                if (typeof n.page === "number") pages.push(n.page);
                if (n.children?.length) collect(n.children);
            }
        };
        collect(tocData.toc);
        pages.sort((a, b) => a - b);
        return pages;
    }, [tocData.toc]);

    // 收集所有 anchor 型章节（按文档顺序）
    const chapterAnchors = useCallback(() => {
        const anchors: string[] = [];
        const collect = (ns: TocNode[]) => {
            for (const n of ns) {
                if (n.anchor) anchors.push(n.anchor);
                if (n.children?.length) collect(n.children);
            }
        };
        collect(tocData.toc);
        return anchors;
    }, [tocData.toc]);

    // 从 activeNodeSignature 中定位当前 anchor 在列表中的索引
    const findCurrentAnchorIndex = useCallback((anchors: string[]): number => {
        const sig = tocData.activeNodeSignature;
        if (!sig) return -1;
        // signature 格式: "title|-1|level"，通过 title+level 匹配 anchor
        const parts = sig.split("|");
        const level = parseInt(parts[parts.length - 1], 10);
        const title = parts.slice(0, parts.length - 2).join("|");
        let matched: string | undefined;
        const find = (ns: TocNode[], lvl: number): boolean => {
            for (const n of ns) {
                if (n.anchor && n.title === title && lvl === level) {
                    matched = n.anchor;
                    return true;
                }
                if (n.children?.length && find(n.children, lvl + 1)) return true;
            }
            return false;
        };
        find(tocData.toc, 0);
        return matched ? anchors.indexOf(matched) : -1;
    }, [tocData.toc, tocData.activeNodeSignature]);

    // anchor 型章节跳转
    const scrollToChapterAnchor = useCallback((anchor: string) => {
        rendererRef.current?.scrollToAnchor?.(anchor);
    }, [rendererRef]);

    // EPUB 已有独立的章节跳转机制（prevPage/nextPage 对 EPUB 按 section 索引跳转），不走 anchor 分支
    const isEpubRenderer = useCallback(() => {
        return rendererRef.current instanceof EpubRenderer;
    }, [rendererRef]);

    const prevChapter = useCallback(() => {
        const pages = chapterPages();
        // 页码型章节导航（PDF、TXT 等）
        if (pages.length > 1) {
            let target: number | undefined;
            for (const p of pages) {
                if (p < currentPage) target = p;
                else break;
            }
            if (typeof target === "number") { goToPage(target); return; }
            prevPage(); return;
        }
        // anchor 型章节导航（Markdown、HTML、MOBI），EPUB 除外
        const anchors = chapterAnchors();
        if (anchors.length > 1 && isDomRender && !isEpubRenderer()) {
            const idx = findCurrentAnchorIndex(anchors);
            if (idx > 0) { scrollToChapterAnchor(anchors[idx - 1]); return; }
        }
        prevPage();
    }, [chapterPages, chapterAnchors, findCurrentAnchorIndex, scrollToChapterAnchor, isEpubRenderer, currentPage, goToPage, prevPage, isDomRender]);

    const nextChapter = useCallback(() => {
        const pages = chapterPages();
        // 页码型章节导航（PDF、TXT 等）
        if (pages.length > 1) {
            const target = pages.find((p) => p > currentPage);
            if (typeof target === "number") { goToPage(target); return; }
            nextPage(); return;
        }
        // anchor 型章节导航（Markdown、HTML、MOBI），EPUB 除外
        const anchors = chapterAnchors();
        if (anchors.length > 1 && isDomRender && !isEpubRenderer()) {
            const idx = findCurrentAnchorIndex(anchors);
            if (idx >= 0 && idx < anchors.length - 1) { scrollToChapterAnchor(anchors[idx + 1]); return; }
        }
        nextPage();
    }, [chapterPages, chapterAnchors, findCurrentAnchorIndex, scrollToChapterAnchor, isEpubRenderer, currentPage, goToPage, nextPage, isDomRender]);

    return {
        goToPage,
        nextPage,
        prevPage,
        toggleFinish,
        prevChapter,
        nextChapter
    };
};

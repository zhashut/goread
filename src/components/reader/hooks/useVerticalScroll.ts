import { useState, useRef, useEffect } from "react";
import { TocNode } from "../../reader/types";
import { findActiveNodeSignature } from "./useToc";
import { LAZY_LOAD_ROOT_MARGIN } from "../../../constants/config";
import { useReaderState } from "./useReaderState";
import { bookService } from "../../../services";
import { SmartPredictor } from "../../../utils/pdfOptimization";

type VerticalScrollProps = {
    readerState: ReturnType<typeof useReaderState>;
    refs: {
        verticalCanvasRefs: React.MutableRefObject<Map<number, HTMLCanvasElement>>;
        verticalScrollRef: React.RefObject<HTMLDivElement>;
        mainViewRef: React.RefObject<HTMLDivElement>;
        renderedPagesRef: React.MutableRefObject<Set<number>>;
    };
    actions: {
        renderPageToTarget: (
            pageNum: number,
            canvasEl: HTMLCanvasElement | null
        ) => Promise<void>;
        setActiveNodeSignature: (sig: string | undefined) => void;
        getSmartPredictor: () => SmartPredictor | null;
        markReadingActive: () => void;
    };
    data: {
        toc: TocNode[];
        readingMode: "horizontal" | "vertical";
        isSeeking: boolean;
        setSeekPage: (page: number | null) => void;
        setIsSeeking: (seeking: boolean) => void;
    };
};

/**
 * 纵向模式滚动与渲染逻辑 Hook
 * 负责：
 * 1. IntersectionObserver 懒加载
 * 2. 滚动时更新 CurrentPage
 * 3. 滚动时更新 TOC 高亮
 */
export const useVerticalScroll = ({
    readerState,
    refs,
    actions,
    data,
}: VerticalScrollProps) => {
    const {
        book,
        isExternal,
        currentPageRef,
        setCurrentPage,
        totalPages,
        loading,
        isDomRender,
    } = readerState;
    const { verticalCanvasRefs, verticalScrollRef, mainViewRef, renderedPagesRef } =
        refs;
    const { readingMode, isSeeking, toc } = data;

    const [verticalLazyReady, setVerticalLazyReady] = useState(false);
    const verticalScrollRafRef = useRef<number | null>(null);
    const lastSeekTsRef = useRef<number>(0);

    // 1. 懒加载观察器
    useEffect(() => {
        if (
            readingMode !== "vertical" ||
            (!book && !isExternal) ||
            totalPages === 0 ||
            !verticalLazyReady
        )
            return;

        let observer: IntersectionObserver | null = null;
        const timer = setTimeout(() => {
            const rootEl =
                verticalScrollRef.current || mainViewRef.current || undefined;
            const canvases = Array.from(verticalCanvasRefs.current.values());

            if (!rootEl || canvases.length === 0) return;

            observer = new IntersectionObserver(
                async (entries) => {
                    for (const entry of entries) {
                        const target = entry.target as HTMLCanvasElement;
                        const pageAttr = target.getAttribute("data-page");
                        const pageNum = pageAttr ? Number(pageAttr) : NaN;
                        if (isNaN(pageNum)) continue;

                        if (entry.isIntersecting) {
                            if (!renderedPagesRef.current.has(pageNum)) {
                                await actions.renderPageToTarget(pageNum, target);
                            }
                        }
                    }
                },
                { root: rootEl, rootMargin: LAZY_LOAD_ROOT_MARGIN, threshold: 0.01 }
            );

            canvases.forEach((el) => observer!.observe(el));
        }, 100);

        return () => {
            clearTimeout(timer);
            observer && observer.disconnect();
        };
    }, [readingMode, totalPages, book, verticalLazyReady, isExternal]);

    // 2. 滚动监听同步逻辑
    useEffect(() => {
        if (loading) return;
        if (readingMode !== "vertical") return;
        if (isDomRender) return;
        // 关键修复：只有当懒加载/初始滚动准备好后，才允许滚动更新页码
        // 这防止了模式切换初期 scroll=0 导致的页码重置为 1
        if (!verticalLazyReady) return;

        const vs = verticalScrollRef.current;
        const mv = mainViewRef.current;

        const updateFromScroll = () => {
            verticalScrollRafRef.current = null;
            if (isSeeking) {
                const now = Date.now();
                if (now - lastSeekTsRef.current <= 400) {
                    return;
                }
                data.setIsSeeking(false);
                data.setSeekPage(null);
            }

            const hasVsScroll = !!(vs && vs.scrollHeight > vs.clientHeight + 2);
            const hasMvScroll = !!(mv && mv.scrollHeight > mv.clientHeight + 2);
            const activeContainer = hasVsScroll ? vs : hasMvScroll ? mv : null;
            const activeRect = activeContainer?.getBoundingClientRect();
            const centerY = activeContainer
                ? activeRect!.top + activeContainer.clientHeight * 0.5
                : window.innerHeight * 0.5;

            let pageUnderCenter: number | null = null;
            verticalCanvasRefs.current.forEach((canvas, pageNum) => {
                if (!canvas) return;
                const rect = canvas.getBoundingClientRect();
                if (rect.top <= centerY && rect.bottom >= centerY) {
                    pageUnderCenter = pageNum;
                }
            });

            let bestPage = pageUnderCenter ?? currentPageRef.current;
            if (pageUnderCenter === null) {
                let bestDist = Infinity;
                verticalCanvasRefs.current.forEach((canvas, pageNum) => {
                    if (!canvas) return;
                    const rect = canvas.getBoundingClientRect();
                    const dist = Math.abs(rect.top - centerY);
                    if (dist < bestDist) {
                        bestDist = dist;
                        bestPage = pageNum;
                    }
                });
            }

            if (bestPage !== currentPageRef.current) {
                setCurrentPage(bestPage);
                actions.markReadingActive();

                if (!isExternal && book && book.id) {
                    bookService.updateBookProgress(book.id, bestPage).catch(() => { });
                }
                const predictor = actions.getSmartPredictor();
                if (predictor) {
                    predictor.recordPageVisit(bestPage);
                }
            }

            // 更新 Active Node Signature
            const canvas = verticalCanvasRefs.current.get(bestPage);
            if (canvas && activeContainer) {
                const rect = canvas.getBoundingClientRect();
                let progress = (centerY - rect.top) / rect.height;
                progress = Math.max(0, Math.min(1, progress));
                const isPageFullyVisible = rect.height <= activeContainer.clientHeight;
                const sig = findActiveNodeSignature(
                    bestPage,
                    progress,
                    isPageFullyVisible,
                    toc
                );
                actions.setActiveNodeSignature(sig || undefined);
            }
        };

        const onScroll = () => {
            if (verticalScrollRafRef.current !== null) return;
            verticalScrollRafRef.current = requestAnimationFrame(updateFromScroll);
        };

        if (vs) vs.addEventListener("scroll", onScroll, { passive: true });
        if (mv) mv.addEventListener("scroll", onScroll, { passive: true });
        window.addEventListener("scroll", onScroll, { passive: true });

        updateFromScroll();

        return () => {
            if (vs) vs.removeEventListener("scroll", onScroll);
            if (mv) mv.removeEventListener("scroll", onScroll);
            window.removeEventListener("scroll", onScroll);
            if (verticalScrollRafRef.current !== null) {
                cancelAnimationFrame(verticalScrollRafRef.current);
                verticalScrollRafRef.current = null;
            }
        };
    }, [
        readingMode,
        book,
        isSeeking,
        totalPages, // totalPages 变化可能引起布局变化，需要重新绑定? 其实不需要，依赖 refs
        loading,
        toc,
        isDomRender,
        isExternal,
        verticalLazyReady // Added dependency
    ]);

    useEffect(() => {
        if (verticalScrollRafRef.current !== null) {
            cancelAnimationFrame(verticalScrollRafRef.current);
            verticalScrollRafRef.current = null;
        }
        setVerticalLazyReady(false);
    }, [readingMode]);

    return {
        verticalLazyReady,
        setVerticalLazyReady,
        lastSeekTsRef,
    };
};

import { useRef, useEffect, useCallback } from "react";
import { MarkdownRenderer } from "../../../services/formats/markdown/MarkdownRenderer";
import { HtmlRenderer } from "../../../services/formats/html/HtmlRenderer";
import { IBookRenderer } from "../../../services/formats";
import { bookService } from "../../../services";
import { TocNode } from "../../reader/types";
import { useReaderState } from "./useReaderState";

const DOM_SCROLL_ACTIVE_INTERVAL = 10000;

type DomPaginationRenderer = IBookRenderer & {
    getScrollContainer(): HTMLElement | null;
    calculateVirtualPages(viewportHeight: number): number;
    getCurrentVirtualPage(scrollTop: number, viewportHeight: number): number;
    scrollToVirtualPage(page: number, viewportHeight: number): void;
};

const isDomPaginationRenderer = (
    renderer: IBookRenderer | null
): renderer is DomPaginationRenderer => {
    if (!renderer) return false;
    // MOBI 的页码由内部滚动监听驱动，不走通用 DOM 分页逻辑
    if (renderer instanceof MarkdownRenderer) return true;
    if (renderer instanceof HtmlRenderer) return true;
    return false;
};

type DomRendererProps = {
    readerState: ReturnType<typeof useReaderState>;
    refs: {
        rendererRef: React.MutableRefObject<IBookRenderer | null>;
    };
    actions: {
        markReadingActive: () => void;
        setActiveNodeSignature: (sig: string | undefined) => void;
    };
    data: {
        readingMode: "horizontal" | "vertical";
        toc: TocNode[];
        activeNodeSignature: string | undefined;
        isExternal: boolean;
    };
};

/**
 * DOM 模式渲染 Hook
 * 负责：
 * 1. 提供 domContainerRef
 * 2. 监听 DOM 滚动计算虚拟页码
 * 3. 监听 DOM 滚动计算当前章节高亮 (Markdown)
 * 4. 虚拟总页数计算
 */
export const useDomRenderer = ({
    readerState,
    refs,
    actions,
    data,
}: DomRendererProps) => {
    const domContainerRef = useRef<HTMLDivElement>(null);
    // domRestoreDoneRef exposed via hook
    const domRestoreDoneRef = readerState.domRestoreDoneRef;
    const lastScrollActiveMarkRef = useRef<number>(0);

    const {
        isDomRender,
        loading,
        book,
        totalPages,
        setTotalPages,
        currentPage,
        setCurrentPage,
        savedPageAtOpenRef,
    } = readerState;
    const { rendererRef } = refs;
    const { markReadingActive, setActiveNodeSignature } = actions;
    const { readingMode, toc, activeNodeSignature, isExternal } = data;

    const waitForContainer = useCallback(() => {
        return new Promise<void>((resolve) => {
            const checkContainer = () => {
                const container = domContainerRef.current;
                if (container) {
                    const { clientWidth, clientHeight } = container;
                    if (clientWidth > 0 && clientHeight > 0) {
                        resolve();
                    } else {
                        requestAnimationFrame(checkContainer);
                    }
                } else {
                    setTimeout(checkContainer, 50);
                }
            };
            checkContainer();
        });
    }, []);

    // 1. 滚动监听：计算虚拟页码和进度
    // 将 totalPages 从依赖中移除，避免 setTotalPages 导致的循环重置
    useEffect(() => {
        if (!isDomRender || loading || (!book && !isExternal)) return;

        const renderer = rendererRef.current;
        if (!isDomPaginationRenderer(renderer)) return;

        let cleanup: (() => void) | null = null;
        let attempts = 0;
        const maxAttempts = 10;
        let timeoutId: ReturnType<typeof setTimeout> | null = null;

        const setupScrollListener = (): (() => void) | null => {
            const scrollContainer = renderer.getScrollContainer();
            if (!scrollContainer) return null;

            if (scrollContainer.scrollHeight <= scrollContainer.clientHeight + 10) {
                return null;
            }

            let rafId: number | null = null;
            // 使用 Ref 追踪当前状态，避免闭包过时
            const stateRef = { lastPage: currentPage, lastTotalPages: totalPages, lastSavedProgress: currentPage };

            // 更新 Ref
            // 更新 Ref
            stateRef.lastPage = currentPage;
            stateRef.lastTotalPages = totalPages;
            stateRef.lastSavedProgress = currentPage;

            const handleScroll = () => {
                if (rafId !== null) return;
                rafId = requestAnimationFrame(() => {
                    rafId = null;
                    const nowTs = Date.now();
                    if (nowTs - lastScrollActiveMarkRef.current >= DOM_SCROLL_ACTIVE_INTERVAL) {
                        lastScrollActiveMarkRef.current = nowTs;
                        markReadingActive();
                    }
                    const viewportHeight = scrollContainer.clientHeight;
                    if (viewportHeight <= 0) return;

                    // 增加容错：只有高度变化或显著差异才重新计算
                    if (scrollContainer.scrollHeight <= viewportHeight + 10) return;

                    const virtualTotalPages =
                        renderer.calculateVirtualPages(viewportHeight);
                    const virtualCurrentPage = renderer.getCurrentVirtualPage(
                        scrollContainer.scrollTop,
                        viewportHeight
                    );

                    // 避免不必要的 totalPages 更新，检查值是否真的改变
                    if (virtualTotalPages !== stateRef.lastTotalPages && virtualTotalPages > 1) {
                        // 使用函数式更新来避免对 totalPages 的依赖，或者在外部做防抖
                        // 这里直接调用 setTotalPages，但因为 totalPages 已从 useEffect 依赖移除，
                        // 所以不会导致 listener 重新绑定，只会触发组件重渲染，这是预期的。
                        setTotalPages(virtualTotalPages);
                        // Update local ref
                        stateRef.lastTotalPages = virtualTotalPages;

                        if (!isExternal && book) {
                            bookService
                                .updateBookTotalPages(book.id, virtualTotalPages)
                                .catch(() => { });
                        }
                    }

                    const canUpdatePage =
                        scrollContainer.scrollTop > 0 ||
                        savedPageAtOpenRef.current === 1 ||
                        domRestoreDoneRef.current;

                    if (canUpdatePage) {
                        let progressToSave = virtualCurrentPage;
                        let shouldSave = false;
                        
                        // Try to get precise progress
                        if (typeof (renderer as any).getPreciseProgress === 'function') {
                            progressToSave = (renderer as any).getPreciseProgress();
                            // For precise progress, save if changed significantly (> 0.005) or integer page changed
                            if (Math.abs(progressToSave - stateRef.lastSavedProgress) > 0.005 || virtualCurrentPage !== stateRef.lastPage) {
                                shouldSave = true;
                            }
                        } else {
                            // Legacy behavior: save only when integer page changes
                            if (virtualCurrentPage !== stateRef.lastPage) {
                                shouldSave = true;
                            }
                        }

                        // Update UI state if integer page changed
                        if (virtualCurrentPage !== stateRef.lastPage) {
                            stateRef.lastPage = virtualCurrentPage;
                            setCurrentPage(virtualCurrentPage);
                            markReadingActive();
                        }

                        // Save to DB
                        if (shouldSave) {
                           stateRef.lastSavedProgress = progressToSave;
                           if (!isExternal && book) {
                               bookService
                                   .updateBookProgress(book.id, progressToSave)
                                   .catch(() => { });
                           }
                        }
                    }

                    try {
                        if (renderer instanceof MarkdownRenderer) {
                            const centerY =
                                scrollContainer.scrollTop + scrollContainer.clientHeight * 0.5;
                            const headings = Array.from(
                                scrollContainer.querySelectorAll("h1,h2,h3,h4,h5,h6")
                            ) as HTMLElement[];
                            if (headings.length > 0) {
                                let bestIdx = 0;
                                let bestDist = Infinity;
                                for (let i = 0; i < headings.length; i++) {
                                    const h = headings[i];
                                    const top = h.offsetTop;
                                    const bottom = top + h.offsetHeight;
                                    const dist =
                                        centerY >= top && centerY <= bottom
                                            ? 0
                                            : Math.min(
                                                Math.abs(centerY - top),
                                                Math.abs(centerY - bottom)
                                            );
                                    if (dist < bestDist) {
                                        bestDist = dist;
                                        bestIdx = i;
                                    }
                                }
                                const anchor = `heading-${bestIdx}`;
                                const findByAnchor = (
                                    nodes: TocNode[],
                                    level: number
                                ): { title: string; level: number } | null => {
                                    for (const n of nodes) {
                                        if (n.anchor === anchor) return { title: n.title, level };
                                        if (n.children) {
                                            const r = findByAnchor(n.children, level + 1);
                                            if (r) return r;
                                        }
                                    }
                                    return null;
                                };
                                const found = findByAnchor(toc, 0);
                                if (found) {
                                    const sig = `${found.title}|-1|${found.level}`;
                                    if (sig !== activeNodeSignature) setActiveNodeSignature(sig);
                                }
                            }
                        }
                        
                        // HTML 格式目录高亮处理
                        if (renderer instanceof HtmlRenderer) {
                            const shadowRoot = (renderer as any)._shadowRoot as ShadowRoot | null;
                            if (shadowRoot) {
                                const centerY = scrollContainer.scrollTop + scrollContainer.clientHeight * 0.5;
                                const headings = Array.from(
                                    shadowRoot.querySelectorAll("h1,h2,h3,h4,h5,h6")
                                ) as HTMLElement[];
                                
                                if (headings.length > 0) {
                                    let bestIdx = 0;
                                    let bestDist = Infinity;
                                    for (let i = 0; i < headings.length; i++) {
                                        const h = headings[i];
                                        const top = h.offsetTop;
                                        const bottom = top + h.offsetHeight;
                                        const dist =
                                            centerY >= top && centerY <= bottom
                                                ? 0
                                                : Math.min(
                                                    Math.abs(centerY - top),
                                                    Math.abs(centerY - bottom)
                                                );
                                        if (dist < bestDist) {
                                            bestDist = dist;
                                            bestIdx = i;
                                        }
                                    }
                                    const anchor = `html-heading-${bestIdx}`;
                                    const findByAnchor = (
                                        nodes: TocNode[],
                                        level: number
                                    ): { title: string; level: number } | null => {
                                        for (const n of nodes) {
                                            if (n.anchor === anchor) return { title: n.title, level };
                                            if (n.children) {
                                                const r = findByAnchor(n.children, level + 1);
                                                if (r) return r;
                                            }
                                        }
                                        return null;
                                    };
                                    const found = findByAnchor(toc, 0);
                                    if (found) {
                                        const sig = `${found.title}|-1|${found.level}`;
                                        if (sig !== activeNodeSignature) setActiveNodeSignature(sig);
                                    }
                                }
                            }
                        }
                    } catch { }
                });
            };

            scrollContainer.addEventListener("scroll", handleScroll, {
                passive: true,
            });
            handleScroll();

            return () => {
                scrollContainer.removeEventListener("scroll", handleScroll);
                if (rafId !== null) {
                    cancelAnimationFrame(rafId);
                }
            };
        };

        const trySetup = () => {
            // 每次尝试前先清理旧的（如果有）
            if (cleanup) cleanup();
            cleanup = setupScrollListener();
            if (!cleanup && attempts < maxAttempts) {
                attempts++;
                timeoutId = setTimeout(trySetup, 300);
            }
        };

        timeoutId = setTimeout(trySetup, 500);

        return () => {
            if (timeoutId) clearTimeout(timeoutId);
            if (cleanup) cleanup();
        };
    }, [isDomRender, book, loading, readingMode, isExternal]); // Removed totalPages to prevent loop

    // 2. 补充检查 (确保虚拟页码正确)
    useEffect(() => {
        if (!isDomRender || (!book && !isExternal) || loading) return;
        const renderer = rendererRef.current;
        if (!isDomPaginationRenderer(renderer)) return;
        let attempts = 0;
        const maxAttempts = 50;
        const check = () => {
            const sc = renderer.getScrollContainer();
            if (!sc) {
                schedule();
                return;
            }
            const vh = sc.clientHeight;
            if (vh <= 0) {
                schedule();
                return;
            }
            const vt = renderer.calculateVirtualPages(vh);
            if (vt > 1 && vt !== totalPages) {
                setTotalPages(vt);
                if (!isExternal && book) {
                    bookService.updateBookTotalPages(book.id, vt).catch(() => { });
                }
            } else {
                schedule();
            }
        };
        const schedule = () => {
            attempts++;
            if (attempts < maxAttempts) setTimeout(check, 100);
        };
        setTimeout(check, 150);
    }, [isDomRender, book?.id, loading]);

    return {
        domContainerRef,
        waitForContainer,
        domRestoreDoneRef
    };
};

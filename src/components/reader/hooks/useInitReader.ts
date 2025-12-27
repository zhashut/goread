import { useRef, useEffect } from "react";
import { log, bookService, ReaderSettings } from "../../../services";
import { MarkdownRenderer } from "../../../services/formats/markdown/MarkdownRenderer";
import { EpubRenderer } from "../../../services/formats/epub/EpubRenderer";
import { IBookRenderer, getBookFormat } from "../../../services/formats";
import { TocNode } from "../../reader/types";
import { useReaderState } from "./useReaderState";
import { usePageRenderer } from "./usePageRenderer";

type InitReaderProps = {
    readerState: ReturnType<typeof useReaderState>;
    refs: {
        rendererRef: React.MutableRefObject<IBookRenderer | null>;
        domContainerRef: React.RefObject<HTMLDivElement>;
        canvasRef: React.RefObject<HTMLCanvasElement>;
        verticalCanvasRefs: React.MutableRefObject<Map<number, HTMLCanvasElement>>;
        renderedPagesRef: React.MutableRefObject<Set<number>>;
        epubRenderedRef: React.MutableRefObject<boolean>;
        domRestoreDoneRef: React.MutableRefObject<boolean>;
    };
    actions: {
        waitForContainer: () => Promise<void>;
        renderPage: ReturnType<typeof usePageRenderer>["renderPage"];
        renderPageToTarget: ReturnType<typeof usePageRenderer>["renderPageToTarget"];
        setVerticalLazyReady: (ready: boolean) => void;
        setActiveNodeSignature: (sig: string | undefined) => void;
        setToc: (nodes: TocNode[]) => void;
    };
    data: {
        readingMode: "horizontal" | "vertical";
        settings: ReaderSettings;
        toc: TocNode[];
    };
};

/**
 * 初始化渲染 Hook
 * 负责书籍加载完成后的首次渲染逻辑（处理三种模式：DOM, Horizontal, Vertical）
 */
export const useInitReader = ({
    readerState,
    refs,
    actions,
    data,
}: InitReaderProps) => {
    const {
        loading,
        totalPages,
        book,
        isExternal,
        externalPath,
        isDomRender,
        // currentPage - 使用 currentPageRef 代替，避免依赖循环
        setCurrentPage,
        setContentReady,
    } = readerState;
    const {
        rendererRef,
        domContainerRef,
        canvasRef,
        verticalCanvasRefs,
        renderedPagesRef,
        epubRenderedRef,
        domRestoreDoneRef,
    } = refs;
    const {
        waitForContainer,
        renderPage,
        renderPageToTarget,
        setVerticalLazyReady,
        setActiveNodeSignature,
        setToc,
    } = actions;
    const { readingMode, settings } = data;

    // Add logic to track initialization to prevent unwanted scrolls
    const hasInitializedRef = useRef(false);
    const lastThemeRef = useRef<string | undefined>();

    // Reset initialization flag when book or mode changes
    useEffect(() => {
        hasInitializedRef.current = false;
    }, [book?.id, isExternal, readingMode]);

    useEffect(() => {
        if (loading || totalPages === 0 || (!book && !isExternal)) return;

        const currentTheme = settings.theme || "light";
        const prevTheme = lastThemeRef.current;
        const themeChanged = typeof prevTheme !== "undefined" && prevTheme !== currentTheme;
        lastThemeRef.current = currentTheme;

        const filePathForEpub = isExternal ? externalPath : book?.file_path;
        const isEpub = filePathForEpub && getBookFormat(filePathForEpub) === "epub";
        if (isEpub && epubRenderedRef.current && !themeChanged) {
            log(
                `[Reader] EPUB 已渲染，跳过重复渲染（模式切换由 setReadingMode 处理）`
            );
            return;
        }

        // 使用 currentPageRef 而不是 currentPage state，避免依赖循环
        const pageToRender = readerState.currentPageRef.current;

        log(
            `[Reader] 开始首次渲染，模式: ${readingMode}, DOM渲染: ${isDomRender}, 当前页: ${pageToRender}`
        );

        const renderInitial = async () => {
            // DOM 渲染模式
            if (isDomRender) {
                const renderer = rendererRef.current;
                if (!renderer) {
                    log("[Reader] DOM渲染模式: 渲染器未初始化");
                    return;
                }

                await waitForContainer();

                try {
                    log("[Reader] 开始 DOM 渲染");

                    if (renderer instanceof MarkdownRenderer) {
                        renderer.onPositionRestored = () => {
                            log("[Reader] Markdown 位置恢复完成");
                            setContentReady(true);
                        };
                    }

                    // DOM 渲染
                    await renderer.renderPage(1, domContainerRef.current!, {
                        initialVirtualPage: pageToRender || 1,
                        readingMode: readingMode,
                        theme: currentTheme,
                        pageGap: settings.pageGap,
                    });
                    log("[Reader] DOM 渲染完成");
                    domRestoreDoneRef.current = true;

                    if (!(renderer instanceof MarkdownRenderer)) {
                        setContentReady(true);
                    }

                    if (renderer instanceof EpubRenderer) {
                        renderer.onPageChange = (p: number) => {
                            setCurrentPage(p);
                            if (!isExternal && book) {
                                bookService.updateBookProgress(book.id, p).catch(() => { });
                            }
                        };
                    }

                    if (isEpub) {
                        epubRenderedRef.current = true;
                    }

                    // 刷新 DOM 提取的目录 (MdCatalog/Epub TOC)
                    try {
                        const items = await renderer.getToc();
                        const toTocNode = (list: any[]): TocNode[] => {
                            return (list || []).map((item: any) => ({
                                title: String(item?.title || ""),
                                page:
                                    typeof item?.location === "number"
                                        ? item.location
                                        : undefined,
                                anchor:
                                    typeof item?.location === "string"
                                        ? item.location
                                        : undefined,
                                children: item?.children ? toTocNode(item.children) : [],
                                expanded: false,
                            }));
                        };
                        const nodes = toTocNode(items as any);
                        if (nodes.length > 0) setToc(nodes);

                        if (renderer instanceof EpubRenderer) {
                            renderer.onTocChange = (href: string) => {
                                const normalizeHref = (h: string) => h?.split("#")[0] || "";
                                const hrefBase = normalizeHref(href);

                                const findByHref = (
                                    list: TocNode[],
                                    level: number
                                ): { title: string; level: number } | null => {
                                    for (const n of list) {
                                        const anchorBase = normalizeHref(n.anchor || "");
                                        if (
                                            n.anchor === href ||
                                            (hrefBase && anchorBase === hrefBase)
                                        ) {
                                            return { title: n.title, level };
                                        }
                                        if (n.children) {
                                            const r = findByHref(n.children, level + 1);
                                            if (r) return r;
                                        }
                                    }
                                    return null;
                                };
                                const found = findByHref(nodes, 0);
                                if (found) {
                                    const sig = `${found.title}|-1|${found.level}`;
                                    setActiveNodeSignature(sig);
                                }
                            };
                        }
                    } catch { }
                } catch (e) {
                    console.error("[Reader] DOM 渲染失败:", e);
                }
                return;
            }

            if (readingMode === "horizontal") {
                const waitForCanvas = () => {
                    return new Promise<void>((resolve) => {
                        const checkCanvas = () => {
                            if (canvasRef.current) {
                                log("[Reader] 横向模式 canvas 已准备好");
                                resolve();
                            } else {
                                setTimeout(checkCanvas, 50);
                            }
                        };
                        checkCanvas();
                    });
                };

                await waitForCanvas();
                log(`[Reader] 开始渲染横向模式页面: ${pageToRender}`);
                await renderPage(pageToRender);
                log("[Reader] 横向模式页面渲染完成");
            } else {
                const waitForCanvases = () => {
                    return new Promise<void>((resolve) => {
                        const checkCanvases = () => {
                            const canvas = verticalCanvasRefs.current.get(pageToRender);
                            if (canvas) {
                                log("[Reader] 纵向模式 canvas 已准备好");
                                resolve();
                            } else {
                                log("[Reader] 等待纵向模式 canvas...");
                                setTimeout(checkCanvases, 50);
                            }
                        };
                        checkCanvases();
                    });
                };

                await waitForCanvases();

                const canvas = verticalCanvasRefs.current.get(pageToRender);
                if (canvas && !renderedPagesRef.current.has(pageToRender)) {
                    await renderPageToTarget(pageToRender, canvas);
                }

                // 使用闭包捕获的 totalPages
                const otherPages = [
                    Math.max(1, pageToRender - 1),
                    Math.min(totalPages, pageToRender + 1),
                ].filter((p) => p !== pageToRender);

                log(
                    `[Reader] 开始渲染纵向模式邻近页面: ${JSON.stringify(otherPages)}`
                );
                Promise.all(
                    otherPages.map((pageNum) => {
                        const c = verticalCanvasRefs.current.get(pageNum);
                        if (c && !renderedPagesRef.current.has(pageNum)) {
                            return renderPageToTarget(pageNum, c);
                        }
                        return Promise.resolve();
                    })
                ).catch((e) => console.warn("邻近页面渲染失败", e));

                log("[Reader] 纵向模式页面渲染完成");

                const currentCanvas = verticalCanvasRefs.current.get(pageToRender);
                if (currentCanvas && !hasInitializedRef.current) {
                    setTimeout(() => {
                        currentCanvas.scrollIntoView({ behavior: "auto", block: "start" });
                        setVerticalLazyReady(true);
                        hasInitializedRef.current = true;
                    }, 100);
                } else if (hasInitializedRef.current) {
                    // Already initialized, just ensure lazy ready is ON
                    setVerticalLazyReady(true);
                }
            }
        };

        renderInitial();
        // 关键：移除 totalPages 和 currentPage 从依赖，只在 book/mode 变化时重新初始化
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        loading,
        book?.id, // 使用 book.id 而不是整个 book 对象
        readingMode,
        isDomRender,
        isExternal,
        externalPath,
        settings.theme,
    ]);
};

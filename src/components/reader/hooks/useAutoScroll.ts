import { useState, useRef, useEffect } from "react";
import {
    AUTO_PAGE_INTERVAL_MS,
    DEFAULT_SCROLL_SPEED_PX_PER_SEC,
} from "../../../constants/config";
import { EpubRenderer } from "../../../services/formats/epub/EpubRenderer";
import { MarkdownRenderer } from "../../../services/formats/markdown/MarkdownRenderer";
import { MobiRenderer } from "../../../services/formats/mobi/MobiRenderer";
import { TxtRenderer } from "../../../services/formats/txt/TxtRenderer";
import { useReaderState } from "./useReaderState";
import { useNavigation } from "./useNavigation";
import { IBookRenderer } from "../../../services/formats";
import { useAppLifecycle } from "../../../hooks/useAppLifecycle";

type AutoScrollProps = {
    readerState: ReturnType<typeof useReaderState>;
    navigation: Pick<ReturnType<typeof useNavigation>, "goToPage">;
    refs: {
        rendererRef: React.MutableRefObject<IBookRenderer | null>;
        verticalScrollRef: React.RefObject<HTMLDivElement>;
        mainViewRef: React.RefObject<HTMLDivElement>;
        domContainerRef: React.RefObject<HTMLDivElement>;
    };
    data: {
        readingMode: "horizontal" | "vertical";
        tocOverlayOpen: boolean;
        modeOverlayOpen: boolean;
        scrollSpeed?: number;
        markReadingActive: () => void;
    };
};

/**
 * 自动滚动 Hook
 * 负责横向模式的自动翻页和纵向/DOM模式的平滑滚动
 */
export const useAutoScroll = ({
    readerState,
    navigation,
    refs,
    data,
}: AutoScrollProps) => {
    const [autoScroll, setAutoScroll] = useState(false);
    const autoScrollTimerRef = useRef<number | null>(null);
    const autoScrollRafRef = useRef<number | null>(null);

    const { isDomRender, currentPage, totalPages } = readerState;
    const { rendererRef, verticalScrollRef, mainViewRef, domContainerRef } = refs;
    const {
        readingMode,
        tocOverlayOpen,
        modeOverlayOpen,
        scrollSpeed,
        markReadingActive,
    } = data;
    const { goToPage } = navigation;

    useEffect(() => {
        const stopAll = () => {
            if (autoScrollTimerRef.current !== null) {
                window.clearInterval(autoScrollTimerRef.current);
                autoScrollTimerRef.current = null;
            }
            if (autoScrollRafRef.current !== null) {
                cancelAnimationFrame(autoScrollRafRef.current);
                autoScrollRafRef.current = null;
            }
        };

        if (!autoScroll || tocOverlayOpen || modeOverlayOpen) {
            stopAll();
            return () => stopAll();
        }

        if (readingMode === "horizontal") {
            stopAll();
            let running = false;
            autoScrollTimerRef.current = window.setInterval(() => {
                if (running) return;
                running = true;
                void (async () => {
                    const r = rendererRef.current;
                    if (r && r instanceof EpubRenderer) {
                        const p =
                            typeof (r as any).getInstantPreciseProgress === "function"
                                ? (r as any).getInstantPreciseProgress()
                                : typeof (r as any).getPreciseProgress === "function"
                                    ? (r as any).getPreciseProgress()
                                    : currentPage;
                        if (p >= totalPages + 0.999999) {
                            stopAll();
                            setAutoScroll(false);
                            return;
                        }
                        await r.nextPage();
                        markReadingActive();
                        return;
                    }

                    // TXT 横向章节模式：自动翻页与手动翻页语义保持一致，
                    // 先翻章内页，章末才跨章。若直接走下面的 goToPage(currentPage + 1)，
                    // 因 currentPage = 章节序号（totalPages = 章节总数），会每 2s 跳过一整章
                    if (
                        r &&
                        r instanceof TxtRenderer &&
                        r.isChapterMode() &&
                        !r.isVerticalMode()
                    ) {
                        if (r.hasNextPageInChapter()) {
                            await r.goToNextPageInChapter();
                            markReadingActive();
                            return;
                        }
                        // 已是最后一章末页：无内容可翻，停止自动翻页
                        if (currentPage >= totalPages) {
                            stopAll();
                            setAutoScroll(false);
                            return;
                        }
                        // 章末：跨到下一章首页
                        await goToPage(currentPage + 1);
                        markReadingActive();
                        return;
                    }

                    if (currentPage >= totalPages) {
                        stopAll();
                        setAutoScroll(false);
                        return;
                    }
                    await goToPage(currentPage + 1);
                })().finally(() => {
                    running = false;
                });
            }, AUTO_PAGE_INTERVAL_MS);
        } else {
            stopAll();
            const speed = scrollSpeed || DEFAULT_SCROLL_SPEED_PX_PER_SEC;

            const r = rendererRef.current;
            if (isDomRender && r && r instanceof EpubRenderer) {
                const container = r.getScrollContainer();
                if (container) {
                    const step = () => {
                        if (!autoScroll || tocOverlayOpen || modeOverlayOpen) {
                            stopAll();
                            return;
                        }
                        const atBottom =
                            container.scrollTop + container.clientHeight >=
                            container.scrollHeight - 2;
                        if (atBottom) {
                            stopAll();
                            setAutoScroll(false);
                            return;
                        }
                        container.scrollTop = container.scrollTop + speed / 60;
                        markReadingActive();
                        autoScrollRafRef.current = requestAnimationFrame(step);
                    };
                    autoScrollRafRef.current = requestAnimationFrame(step);
                } else {
                    const step = () => {
                        if (!autoScroll || tocOverlayOpen || modeOverlayOpen) {
                            stopAll();
                            return;
                        }
                        r.scrollBy(speed / 60);
                        markReadingActive();
                        autoScrollRafRef.current = requestAnimationFrame(step);
                    };
                    autoScrollRafRef.current = requestAnimationFrame(step);
                }
            } else {
                let el: HTMLElement | null = null;
                if (isDomRender) {
                    if (r && (r instanceof MarkdownRenderer || r instanceof MobiRenderer)) {
                        el = r.getScrollContainer();
                    }
                    if (!el) el = domContainerRef.current;
                } else {
                    el = verticalScrollRef.current || mainViewRef.current;
                }
                if (!el) return () => stopAll();
                const step = () => {
                    if (!autoScroll || tocOverlayOpen || modeOverlayOpen) {
                        stopAll();
                        return;
                    }
                    const atBottom =
                        el!.scrollTop + el!.clientHeight >= el!.scrollHeight - 2;
                    if (atBottom) {
                        stopAll();
                        setAutoScroll(false);
                        return;
                    }
                    el!.scrollTop = el!.scrollTop + speed / 60;
                    markReadingActive();
                    autoScrollRafRef.current = requestAnimationFrame(step);
                };
                autoScrollRafRef.current = requestAnimationFrame(step);
            }
        }

        return () => stopAll();
    }, [
        autoScroll,
        readingMode,
        isDomRender,
        currentPage,
        totalPages,
        tocOverlayOpen,
        modeOverlayOpen,
        scrollSpeed,
        goToPage,
        markReadingActive,
        rendererRef,
        verticalScrollRef,
        mainViewRef,
        domContainerRef,
    ]);

    const wasAutoScrollingRef = useRef(false);
    useAppLifecycle({
        onBackground: () => {
            if (autoScroll) {
                wasAutoScrollingRef.current = true;
                setAutoScroll(false);
            }
        },
        onForeground: () => {
            if (wasAutoScrollingRef.current) {
                wasAutoScrollingRef.current = false;
                setAutoScroll(true);
            }
        },
    });

    return { autoScroll, setAutoScroll };
};

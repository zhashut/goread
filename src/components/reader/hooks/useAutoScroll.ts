import { useState, useRef, useEffect } from "react";
import {
    AUTO_PAGE_INTERVAL_MS,
    DEFAULT_SCROLL_SPEED_PX_PER_SEC,
} from "../../../constants/config";
import { EpubRenderer } from "../../../services/formats/epub/EpubRenderer";
import { MarkdownRenderer } from "../../../services/formats/markdown/MarkdownRenderer";
import { useReaderState } from "./useReaderState";
import { useNavigation } from "./useNavigation";
import { IBookRenderer } from "../../../services/formats";

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
            autoScrollTimerRef.current = window.setInterval(async () => {
                if (currentPage >= totalPages) {
                    stopAll();
                    setAutoScroll(false);
                    return;
                }
                await goToPage(currentPage + 1);
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
                    if (r && r instanceof MarkdownRenderer) {
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

    // 监听应用生命周期：后台时暂停自动滚动，前台时恢复
    const wasAutoScrollingRef = useRef(false);
    useEffect(() => {
        const handleBackground = () => {
            if (autoScroll) {
                wasAutoScrollingRef.current = true;
                setAutoScroll(false);
            }
        };

        const handleForeground = () => {
            if (wasAutoScrollingRef.current) {
                wasAutoScrollingRef.current = false;
                setAutoScroll(true);
            }
        };

        const handleVisibilityChange = () => {
            if (document.hidden) {
                handleBackground();
            } else {
                handleForeground();
            }
        };

        document.addEventListener("visibilitychange", handleVisibilityChange);

        return () => {
            document.removeEventListener("visibilitychange", handleVisibilityChange);
        };
    }, [autoScroll]);

    return { autoScroll, setAutoScroll };
};

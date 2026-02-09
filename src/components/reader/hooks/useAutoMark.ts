import { useRef, useEffect } from "react";
import { IBook } from "../../../types";
import { statsService, log, logError } from "../../../services";
import { IBookRenderer } from "../../../services/formats";

type AutoMarkProps = {
    book: IBook | null;
    isExternal: boolean;
    currentPage: number;
    totalPages: number;
    isDomRender: boolean;
    contentReady: boolean;
    rendererRef: React.MutableRefObject<IBookRenderer | null>;
    setBook: React.Dispatch<React.SetStateAction<IBook | null>>;
    readingMode: "horizontal" | "vertical";
    latestPreciseProgressRef?: React.MutableRefObject<number | null>;
};

/**
 * 自动标记已读逻辑 Hook
 * 当用户到达最后一页时自动将书籍标记为已读
 */
export const useAutoMark = ({
    book,
    isExternal,
    currentPage,
    totalPages,
    isDomRender,
    contentReady,
    rendererRef,
    setBook,
    readingMode,
    latestPreciseProgressRef,
}: AutoMarkProps) => {
    const lastAutoMarkPageRef = useRef<number | null>(null);

    useEffect(() => {
        if (isExternal || !book || totalPages <= 0) return;
        const renderer = rendererRef.current as any;
        // 渲染器未就绪时跳过，等下次 effect 重新执行
        if (!renderer) return;

        const format = renderer?.format as string | undefined;
        const isTxt = format === "txt";

        if (isTxt && readingMode === 'vertical') {
            // TXT 纵向模式：需要通过滚动事件监听来检测触底
            // 因为 latestPreciseProgressRef.current 的变化不会触发 useEffect 重新执行
            const container = renderer?.getScrollContainer?.() as HTMLElement | null;
            if (!container) return;

            const checkAutoMark = () => {
                if (book.status === 1) return; // 已标记则跳过

                const preciseProgress = latestPreciseProgressRef?.current ?? currentPage;
                // TXT 精确进度是 1-based，达到最后一页底部时接近 totalPages + 0.999
                const progressRatio = totalPages <= 1
                    ? (preciseProgress - 1)
                    : (preciseProgress - 1) / Math.max(1, totalPages - 1);

                if (progressRatio < 0.98) return;

                // 检查是否滚到底部（始终检查，不跳过）
                const maxScroll = container.scrollHeight - container.clientHeight;
                // 无论内容是否超过一屏，都要求滚动位置达到底部附近
                // 对于不足一屏的内容，maxScroll <= 2，此时 scrollTop 应接近 maxScroll
                const atBottom = maxScroll <= 2
                    ? container.scrollTop >= maxScroll  // 不足一屏时，需滚动到最大位置
                    : container.scrollTop >= maxScroll - 50;  // 超过一屏时，留 50px 容差
                if (!atBottom) return;

                // 防止重复标记
                if (lastAutoMarkPageRef.current === currentPage) return;
                lastAutoMarkPageRef.current = currentPage;

                (async () => {
                    try {
                        log(`[useAutoMark] TXT 纵向模式进度 100%，自动标记为已读`);
                        setBook(prev => prev ? { ...prev, status: 1 } : null);
                        await statsService.markBookFinished(book.id);
                    } catch (e) {
                        await logError('自动标记已读失败', { error: String(e), bookId: book.id });
                    }
                })();
            };

            // 只在滚动时检测，不在初始化时检测（避免误触发）
            container.addEventListener('scroll', checkAutoMark);
            return () => {
                container.removeEventListener('scroll', checkAutoMark);
            };
        }

        if (currentPage < totalPages) {
            lastAutoMarkPageRef.current = null;
            return;
        }

        // TXT 纵向模式由上面的滚动监听处理，这里跳过避免重复或误触发
        if (isTxt && readingMode === 'vertical') {
            return;
        }

        if (currentPage >= totalPages && book.status !== 1 && lastAutoMarkPageRef.current !== currentPage) {
            const isTxtHorizontal = isTxt && readingMode === "horizontal";

            const autoMark = async () => {
                try {
                    if (!isTxt) {
                        const hasRecords = await statsService.hasReadingSessions(book.id);
                        if (!hasRecords) {
                            log(`[useAutoMark] 书籍 ${book.id} 无阅读记录，跳过自动标记`);
                            return;
                        }
                    }

                    log(`[useAutoMark] 进度 100%，自动标记为已读`);
                    setBook(prev => prev ? { ...prev, status: 1 } : null);
                    await statsService.markBookFinished(book.id);
                } catch (e) {
                    await logError('自动标记已读失败', { error: String(e), bookId: book.id });
                }
            };

            const checkAndMark = () => {
                const r = rendererRef.current as any;
                if (!r || !r.getScrollContainer) return;

                const scrollContainer = r.getScrollContainer();
                if (!scrollContainer) return;

                if (scrollContainer.scrollHeight > scrollContainer.clientHeight) {
                    const atBottom =
                        scrollContainer.scrollTop + scrollContainer.clientHeight >=
                        scrollContainer.scrollHeight - 50;
                    if (!atBottom) return;
                }

                if (lastAutoMarkPageRef.current !== currentPage) {
                    lastAutoMarkPageRef.current = currentPage;
                    autoMark();
                }
            };

            if (isTxtHorizontal) {
                lastAutoMarkPageRef.current = currentPage;
                autoMark();
                return;
            }

            if (isDomRender) {
                if (!contentReady) return;

                checkAndMark();

                const r = rendererRef.current as any;
                if (r && r.getScrollContainer) {
                    const scrollContainer = r.getScrollContainer();
                    if (scrollContainer) {
                        const onScroll = () => checkAndMark();
                        scrollContainer.addEventListener('scroll', onScroll);
                        return () => {
                            scrollContainer.removeEventListener('scroll', onScroll);
                        };
                    }
                }
            } else {
                // 非 DOM 渲染模式（如 PDF/图片），直接标记（因为是分页的，进入最后一页即视为完成）
                lastAutoMarkPageRef.current = currentPage;
                autoMark();
            }
        }
    }, [currentPage, totalPages, book, contentReady, isDomRender, isExternal, rendererRef, setBook, readingMode, latestPreciseProgressRef]);
};

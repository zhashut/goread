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
}: AutoMarkProps) => {
    const lastAutoMarkPageRef = useRef<number | null>(null);

    useEffect(() => {
        if (isExternal || !book || totalPages <= 0) return;

        if (currentPage < totalPages) {
            lastAutoMarkPageRef.current = null;
            return;
        }

        if (currentPage >= totalPages && book.status !== 1 && lastAutoMarkPageRef.current !== currentPage) {
            const renderer = rendererRef.current as any;
            const format = renderer?.format as string | undefined;
            const isTxt = format === "txt";
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
    }, [currentPage, totalPages, book, contentReady, isDomRender, isExternal, rendererRef, setBook]);
};

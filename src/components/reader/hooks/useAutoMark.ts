import { useRef, useEffect } from "react";
import { IBook } from "../../../types";
import { statsService, log } from "../../../services";
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
}: AutoMarkProps) => {
    const lastAutoMarkPageRef = useRef<number | null>(null);

    useEffect(() => {
        if (isExternal || !book || totalPages <= 0) return;

        // 离开最后一页时，重置自动标记记录
        if (currentPage < totalPages) {
            lastAutoMarkPageRef.current = null;
            return;
        }

        // 只有当：到了最后一页、书籍状态未完成、在当前页还没有自动标记过，才执行自动标记
        if (currentPage >= totalPages && book.status !== 1 && lastAutoMarkPageRef.current !== currentPage) {

            // 针对 DOM 渲染模式（如 Markdown）的额外检查
            if (isDomRender) {
                if (!contentReady) return;

                const renderer = rendererRef.current;
                if (renderer && (renderer as any).getScrollContainer) {
                    const scrollContainer = (renderer as any).getScrollContainer();
                    if (scrollContainer) {
                        if (scrollContainer.scrollHeight > scrollContainer.clientHeight) {
                            const atBottom = scrollContainer.scrollTop + scrollContainer.clientHeight >= scrollContainer.scrollHeight - 50;
                            if (!atBottom) return;
                        } else {
                            return;
                        }
                    } else {
                        return;
                    }
                }
            }

            lastAutoMarkPageRef.current = currentPage;

            const autoMark = async () => {
                try {
                    const hasRecords = await statsService.hasReadingSessions(book.id);
                    if (!hasRecords) {
                        log(`[useAutoMark] 书籍 ${book.id} 无阅读记录，跳过自动标记`);
                        return;
                    }

                    log(`[useAutoMark] 进度 100%，自动标记为已读`);
                    setBook(prev => prev ? { ...prev, status: 1 } : null);
                    await statsService.markBookFinished(book.id);
                } catch (e) {
                    console.error("自动标记已读失败", e);
                }
            };
            autoMark();
        }
    }, [currentPage, totalPages, book, contentReady, isDomRender, isExternal, rendererRef, setBook]);
};

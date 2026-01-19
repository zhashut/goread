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

            const checkAndMark = () => {
                const renderer = rendererRef.current;
                if (!renderer || !(renderer as any).getScrollContainer) return;

                const scrollContainer = (renderer as any).getScrollContainer();
                if (!scrollContainer) return;

                // 如果内容高度超过视口高度，检查滚动位置
                if (scrollContainer.scrollHeight > scrollContainer.clientHeight) {
                    const atBottom = scrollContainer.scrollTop + scrollContainer.clientHeight >= scrollContainer.scrollHeight - 50;
                    if (!atBottom) return;
                }
                // 如果内容高度小于等于视口高度，说明内容完全可见，视为已到达底部

                // 到达底部，执行标记
                if (lastAutoMarkPageRef.current !== currentPage) { // 防止重复触发
                    lastAutoMarkPageRef.current = currentPage;
                    autoMark();
                }
            };

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
                    await logError('自动标记已读失败', { error: String(e), bookId: book.id });
                }
            };

            // 针对 DOM 渲染模式（如 Markdown/EPUB）
            if (isDomRender) {
                if (!contentReady) return;
                
                // 立即检查一次
                checkAndMark();

                // 添加滚动监听
                const renderer = rendererRef.current;
                if (renderer && (renderer as any).getScrollContainer) {
                    const scrollContainer = (renderer as any).getScrollContainer();
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

import { useEffect } from "react";
import { IBook } from "../../../types";

type ModeSwitchProps = {
    book: IBook | null;
    isExternal: boolean;
    totalPages: number;
    readingMode: "horizontal" | "vertical";
    modeVersionRef: React.MutableRefObject<number>;
    renderedPagesRef: React.MutableRefObject<Set<number>>;
    renderQueueRef: React.MutableRefObject<Map<number, Promise<void>>>;
    setVerticalLazyReady: (ready: boolean) => void;
    setContentReady: (ready: boolean) => void;
};

/**
 * 模式切换处理 Hook
 * 负责在阅读模式切换时清理渲染缓存，防止 ImageBitmap 失效导致渲染失败
 */
export const useModeSwitch = ({
    book,
    isExternal,
    totalPages,
    readingMode,
    modeVersionRef,
    renderedPagesRef,
    renderQueueRef,
    setVerticalLazyReady,
    setContentReady,
}: ModeSwitchProps) => {
    useEffect(() => {
        if ((!book && !isExternal) || totalPages === 0) return;

        // 清理渲染标记
        renderedPagesRef.current.clear();
        modeVersionRef.current += 1;
        renderQueueRef.current.clear();
        setVerticalLazyReady(false);
        setContentReady(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [readingMode]);
};

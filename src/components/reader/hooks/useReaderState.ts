import { useState, useRef, useEffect } from "react";
import { IBook } from "../../../types";

/**
 * 管理阅读器核心状态的 Hook
 * 包含：当前书籍、页码、总页数、加载状态、外部文件信息、DOM 渲染模式标记等
 */
export const useReaderState = (params: {
    bookId?: string;
    initialIsExternal: boolean;
}) => {
    const [book, setBook] = useState<IBook | null>(null);
    const [externalTitle, setExternalTitle] = useState<string>("");
    const [externalPath, setExternalPath] = useState<string | null>(null);
    const [currentPage, setCurrentPage] = useState(1);
    const [totalPages, setTotalPages] = useState(1);
    const [loading, setLoading] = useState(true);
    const [isDomRender, setIsDomRender] = useState(false);
    const [contentReady, setContentReady] = useState(false); // DOM 内容是否渲染完成

    // Refs 用于解决闭包陷阱或跟踪变化
    const bookIdRef = useRef<string | undefined>(params.bookId);
    const currentPageRef = useRef<number>(1);
    const savedPageAtOpenRef = useRef<number>(1);
    const domRestoreDoneRef = useRef(false);

    // 同步 Ref
    useEffect(() => {
        currentPageRef.current = currentPage;
    }, [currentPage]);

    useEffect(() => {
        // 使用 precise_progress（浮点数）恢复精确位置，若不存在则回退到 current_page
        savedPageAtOpenRef.current = book?.precise_progress ?? book?.current_page ?? 1;
    }, [book?.id]);

    // 计算是否为外部模式
    const isExternal = params.initialIsExternal || !!externalPath;

    return {
        book,
        setBook,
        externalTitle,
        setExternalTitle,
        externalPath,
        setExternalPath,
        currentPage,
        setCurrentPage,
        totalPages,
        setTotalPages,
        loading,
        setLoading,
        isDomRender,
        setIsDomRender,
        contentReady,
        setContentReady,
        bookIdRef,
        currentPageRef,
        savedPageAtOpenRef,
        domRestoreDoneRef,
        isExternal,
    };
};

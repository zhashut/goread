import { useEffect } from "react";

/**
 * 页码同步 Hook  
 * 负责将 currentPage state 同步到 currentPageRef
 */
export const usePageSync = (
    currentPage: number,
    currentPageRef: React.MutableRefObject<number>
) => {
    useEffect(() => {
        currentPageRef.current = currentPage;
    }, [currentPage, currentPageRef]);
};

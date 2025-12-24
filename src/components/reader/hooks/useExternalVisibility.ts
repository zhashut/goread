import { useEffect } from "react";
import { useAppNav } from "../../../router/useAppNav";

/**
 * 外部文件可见性 Hook
 * 负责在应用进入后台时导航回书架（仅限外部临时文件）
 */
export const useExternalVisibility = (isExternal: boolean) => {
    const nav = useAppNav();

    useEffect(() => {
        if (!isExternal) return;

        const handleVisibilityChange = () => {
            if (document.hidden) {
                nav.toBookshelf("recent", { replace: true, resetStack: true });
            }
        };

        document.addEventListener("visibilitychange", handleVisibilityChange);
        return () => {
            document.removeEventListener("visibilitychange", handleVisibilityChange);
        };
    }, [isExternal, nav]);
};

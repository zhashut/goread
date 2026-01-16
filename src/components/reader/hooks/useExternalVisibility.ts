import { useEffect } from "react";
import { useAppNav } from "../../../router/useAppNav";
import { useAppLifecycle } from "../../../hooks/useAppLifecycle";

/**
 * 外部文件可见性 Hook
 * 负责在应用进入后台时导航回书架（仅限外部临时文件）
 */
export const useExternalVisibility = (isExternal: boolean) => {
    const nav = useAppNav();

    useEffect(() => {
        if (!isExternal) return;
        return () => {
        };
    }, [isExternal, nav]);

    useAppLifecycle({
        onBackground: () => {
            if (!isExternal) return;
            nav.toBookshelf("recent", { replace: true, resetStack: true });
        },
    });
};

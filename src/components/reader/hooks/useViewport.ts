import { useEffect } from "react";
import { applyScalable, resetZoom, applyNonScalable } from "../../../utils/viewport";

/**
 * 视口缩放 Hook
 * 负责在阅读器加载时应用可缩放视口，卸载时恢复
 */
export const useViewport = () => {
    useEffect(() => {
        applyScalable();
        return () => {
            resetZoom();
            applyNonScalable();
        };
    }, []);
};

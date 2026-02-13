import { useEffect } from "react";
import { applyNonScalable, resetZoom } from "../../../utils/viewport";

/**
 * 视口管理 Hook
 * 阅读器中禁用浏览器原生缩放，缩放由 usePinchZoom 通过 CSS Transform 实现
 */
export const useViewport = () => {
    useEffect(() => {
        applyNonScalable();
        return () => {
            resetZoom();
        };
    }, []);
};

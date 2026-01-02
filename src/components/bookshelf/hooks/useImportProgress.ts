import { useState, useEffect, useCallback } from "react";
import { useAppNav } from "../../../router/useAppNav";

/**
 * 管理导入进度的 Hook
 * 负责导入事件监听、进度状态管理
 */
export const useImportProgress = (onDone: () => void) => {
    const nav = useAppNav();

    const [importOpen, setImportOpen] = useState(false);
    const [importTotal, setImportTotal] = useState(0);
    const [importCurrent, setImportCurrent] = useState(0);
    const [importTitle, setImportTitle] = useState("");

    // 监听导入事件：开始 / 进度 / 完成 / 取消
    useEffect(() => {
        const onStart = (e: any) => {
            const detail = e?.detail || {};
            setImportTotal(detail.total || 0);
            setImportCurrent(0);
            setImportTitle(detail.title || "");
            setImportOpen(true);
            nav.finishImportFlow();
        };
        const onProgress = (e: any) => {
            const detail = e?.detail || {};
            setImportCurrent(detail.current || 0);
            if (detail.title) setImportTitle(detail.title);
        };
        const onDoneHandler = (_e: any) => {
            // 立即关闭进度抽屉，无人工延时
            setImportOpen(false);
            setImportTitle("");
            setImportTotal(0);
            setImportCurrent(0);
            onDone();
        };
        window.addEventListener("goread:import:start", onStart as any);
        window.addEventListener("goread:import:progress", onProgress as any);
        window.addEventListener("goread:import:done", onDoneHandler as any);
        return () => {
            window.removeEventListener("goread:import:start", onStart as any);
            window.removeEventListener("goread:import:progress", onProgress as any);
            window.removeEventListener("goread:import:done", onDoneHandler as any);
        };
    }, [nav, onDone]);

    const stopImport = useCallback(() => {
        // 通知正在导入的流程取消
        const evt = new CustomEvent("goread:import:cancel");
        window.dispatchEvent(evt);
        setImportOpen(false);
    }, []);

    return {
        importOpen,
        setImportOpen,
        importTotal,
        importCurrent,
        importTitle,
        stopImport,
    };
};

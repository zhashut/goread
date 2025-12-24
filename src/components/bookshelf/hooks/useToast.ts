import { useState, useCallback } from "react";

/**
 * 管理 Toast 提示的 Hook
 * 负责 Toast 消息的显示和清除
 */
export const useToast = () => {
    const [toastMsg, setToastMsg] = useState("");

    const showToast = useCallback((msg: string) => {
        setToastMsg(msg);
    }, []);

    const clearToast = useCallback(() => {
        setToastMsg("");
    }, []);

    return {
        toastMsg,
        setToastMsg,
        showToast,
        clearToast,
    };
};

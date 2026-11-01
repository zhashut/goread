import React, { useEffect, useState } from "react";
import { Toast } from "./Toast";
import { GLOBAL_TOAST_EVENT } from "../utils/globalToast";

/**
 * 全局 Toast 宿主组件
 *
 * 功能：挂载于常驻布局 MainLayout（所有路由含 /reader 均渲染），监听全局
 * Toast 事件（GLOBAL_TOAST_EVENT）并以应用统一风格展示提示；用于替代无法
 * 访问局部 Toast 状态的模块（如阅读器 useBookLoader）中的原生 alert
 */
export const GlobalToastHost: React.FC = () => {
    const [message, setMessage] = useState("");

    useEffect(() => {
        /**
         * 处理全局 Toast 事件，记录待展示文案
         * 参数：e 携带 detail.message 的 CustomEvent
         */
        const handleToast = (e: Event) => {
            const msg =
                (e as CustomEvent<{ message?: string }>).detail?.message || "";
            if (msg) setMessage(msg);
        };
        window.addEventListener(GLOBAL_TOAST_EVENT, handleToast);
        return () =>
            window.removeEventListener(GLOBAL_TOAST_EVENT, handleToast);
    }, []);

    return <Toast message={message} onClose={() => setMessage("")} />;
};

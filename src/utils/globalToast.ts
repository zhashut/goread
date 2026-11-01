/**
 * 全局 Toast 事件名
 *
 * 采用 window CustomEvent 全局通信模式（与 GlobalBottomBar 的
 * GLOBAL_NAV_VISIBLE_EVENT / GLOBAL_NAV_BOOKSHELF_EVENT 同风格），
 * 供无法访问局部 Toast 状态的模块（如阅读器 useBookLoader）触发
 * 应用统一风格的底部提示
 */
export const GLOBAL_TOAST_EVENT = "goread:toast";

/**
 * 派发全局 Toast 提示事件
 *
 * 功能：通过 window CustomEvent 通知常驻布局中的 GlobalToastHost 展示一条
 * 应用统一风格的 Toast（底部半透明黑底圆角条，2 秒自动消失）
 * 参数：message 要展示的提示文案，为空字符串时不派发
 * 返回值：无
 */
export const showGlobalToast = (message: string): void => {
    if (!message) return;
    window.dispatchEvent(
        new CustomEvent(GLOBAL_TOAST_EVENT, { detail: { message } })
    );
};

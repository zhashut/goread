import { useEffect, useRef, useCallback } from "react";

interface UseOverlayBackHandlerOptions {
  /**
   * 覆盖层的唯一标识，用于区分不同的覆盖层
   */
  overlayId: string;
  /**
   * 覆盖层是否打开
   */
  isOpen: boolean;
  /**
   * 关闭覆盖层的回调
   */
  onClose: () => void;
  /**
   * 是否在打开时添加历史记录（默认为 true）
   * 设为 false 时不会 pushState，仅监听 popstate
   */
  pushHistory?: boolean;
}

/**
 * 处理覆盖层（菜单、弹窗等）的侧滑返回手势
 * 
 * 功能：
 * 1. 在覆盖层打开时向历史栈 pushState
 * 2. 监听 popstate 事件，在侧滑返回时关闭覆盖层
 * 3. 确保关闭后不留栈记录
 */
export const useOverlayBackHandler = (options: UseOverlayBackHandlerOptions) => {
  const { overlayId, isOpen, onClose, pushHistory = true } = options;
  
  // 标记是否正在通过 popstate 关闭，防止重复 back()
  const isClosingByPop = useRef(false);
  // 标记是否已经 pushState，防止重复 push
  const hasPushed = useRef(false);
  // 标记是否跳过清理（用于导航场景，避免 back() 撤销导航）
  const skipCleanup = useRef(false);

  useEffect(() => {
    if (!isOpen) {
      // 重置状态
      isClosingByPop.current = false;
      hasPushed.current = false;
      skipCleanup.current = false;
      return;
    }

    // 打开时 pushState
    if (pushHistory && !hasPushed.current) {
      const currentState = window.history.state;
      const newState = 
        typeof currentState === "object" && currentState !== null
          ? { ...currentState, overlay: overlayId }
          : { overlay: overlayId };
      window.history.pushState(newState, "");
      hasPushed.current = true;
    }

    // 监听 popstate
    const handlePopState = (e: PopStateEvent) => {
      // 检查是否是从当前覆盖层状态返回
      // 如果回退后的 state 仍然包含当前 overlayId，说明不应该关闭
      if (e.state?.overlay === overlayId) return;
      
      isClosingByPop.current = true;
      onClose();
    };

    window.addEventListener("popstate", handlePopState);

    return () => {
      window.removeEventListener("popstate", handlePopState);
      // 如果不是通过 popstate 关闭的（比如点击外部、调用 onClose），
      // 且已经 pushState，且不跳过清理，需要 back() 清理历史栈
      if (pushHistory && hasPushed.current && !isClosingByPop.current && !skipCleanup.current) {
        window.history.back();
      }
    };
  }, [isOpen, overlayId, onClose, pushHistory]);

  // 提供一个安全的关闭方法，会自动处理历史栈
  const safeClose = useCallback(() => {
    if (isOpen && pushHistory && hasPushed.current) {
      // 通过 back() 关闭，会触发 popstate -> onClose
      window.history.back();
    } else {
      onClose();
    }
  }, [isOpen, pushHistory, onClose]);

  /**
   * 关闭覆盖层并准备导航
   * 用于菜单项点击后需要跳转页面的场景
   * 仅标记跳过清理，具体的历史栈处理（如 replace）由导航操作负责
   */
  const closeForNavigation = useCallback(() => {
    if (pushHistory && hasPushed.current) {
      // 标记已处理，防止 cleanup 再次 back()
      hasPushed.current = false;
    }
    skipCleanup.current = true;
    onClose();
  }, [onClose, pushHistory]);

  return { safeClose, closeForNavigation };
};

import { useState, useEffect, useCallback, useRef } from 'react';
import { UNDO_JUMP_VISIBLE_DURATION_MS } from '../../../constants/config';

export interface UndoJumpState {
  active: boolean;
  fromProgress: number;   // 精确进度（浮点数）
  toPage: number;         // 目标页码（保持整数用于 UI 显示）
  expireAt: number;
}

export interface UseUndoJumpProps {
  navigator: {
    goToPage: (page: number) => Promise<void> | void;
  };
}

export const useUndoJump = ({ navigator }: UseUndoJumpProps) => {
  const [undoJumpState, setUndoJumpState] = useState<UndoJumpState | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearUndo = useCallback(() => {
    setUndoJumpState(null);
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const handleJump = useCallback((fromProgress: number, toPage: number, forceRecord?: boolean) => {
    // 若跳转目标页与当前页相同（整数部分）且非强制记录，则忽略
    if (!forceRecord && Math.floor(fromProgress) === toPage) return;

    // 清理旧的定时器
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }

    const expireAt = Date.now() + UNDO_JUMP_VISIBLE_DURATION_MS;
    
    setUndoJumpState({
      active: true,
      fromProgress,   // 保存精确进度
      toPage,
      expireAt,
    });

    // 启动定时器，到期自动失效
    timerRef.current = setTimeout(() => {
        setUndoJumpState(null);
        timerRef.current = null;
    }, UNDO_JUMP_VISIBLE_DURATION_MS);
  }, []);

  const performUndo = useCallback(() => {
    if (undoJumpState && undoJumpState.active) {
      navigator.goToPage(undoJumpState.fromProgress);  // 传递精确进度
      clearUndo();
    }
  }, [undoJumpState, navigator, clearUndo]);

  // 组件卸载时清理定时器
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  return {
    undoJumpState,
    handleJump,
    performUndo,
    clearUndo
  };
};

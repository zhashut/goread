import { useState, useEffect, useCallback, useRef } from 'react';
import { UNDO_JUMP_VISIBLE_DURATION_MS } from '../../../constants/config';

interface UndoJumpState {
  active: boolean;
  fromPage: number;
  toPage: number;
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

  const handleJump = useCallback((fromPage: number, toPage: number) => {
    // 若跳转目标页与当前页相同，则忽略
    if (fromPage === toPage) return;

    // 清理旧的定时器
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }

    const expireAt = Date.now() + UNDO_JUMP_VISIBLE_DURATION_MS;
    
    setUndoJumpState({
      active: true,
      fromPage,
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
      navigator.goToPage(undoJumpState.fromPage);
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

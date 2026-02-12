import { useState, useRef, useCallback } from 'react';

interface UseInlineEditOptions {
  /** 当前显示名 */
  value: string;
  /** 提交回调（仅在名称有变化时触发） */
  onSubmit: (newValue: string) => void;
}

/**
 * 内联编辑 Hook
 * 管理编辑态切换、blur/enter 提交、空名回退
 */
export function useInlineEdit({ value, onSubmit }: UseInlineEditOptions) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  // 防止 blur 和 enter 重复提交
  const submittedRef = useRef(false);

  const startEdit = useCallback(() => {
    setEditValue(value);
    setIsEditing(true);
    submittedRef.current = false;
    // 延迟聚焦，等 input 渲染完成
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [value]);

  const doSubmit = useCallback(() => {
    if (submittedRef.current) return;
    submittedRef.current = true;

    const trimmed = editValue.trim();
    setIsEditing(false);

    // 空名或未变化则不提交
    if (!trimmed || trimmed === value) return;
    onSubmit(trimmed);
  }, [editValue, value, onSubmit]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      doSubmit();
    } else if (e.key === 'Escape') {
      submittedRef.current = true;
      setIsEditing(false);
    }
  }, [doSubmit]);

  const handleBlur = useCallback(() => {
    doSubmit();
  }, [doSubmit]);

  return {
    isEditing,
    editValue,
    setEditValue,
    inputRef,
    startEdit,
    handleKeyDown,
    handleBlur,
  };
}

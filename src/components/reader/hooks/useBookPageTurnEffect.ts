import { useState, useCallback } from "react";
import type { IBook, PageTurnEffect } from "../../../types";
import { bookService } from "../../../services";

interface UseBookPageTurnEffectParams {
  book: IBook | null;
  isExternal: boolean;
  setBook: React.Dispatch<React.SetStateAction<IBook | null>>;
}

/**
 * 管理书籍级别翻页动画效果的 Hook（T33，按书记忆）
 * - 普通书籍：读取 book.page_turn_effect（缺省默认 slide），切换时持久化到后端并同步 book 状态，无需重开书即时生效
 * - 外部文件：无书籍 id，使用组件内临时状态（不持久化），默认 slide
 */
export const useBookPageTurnEffect = ({
  book,
  isExternal,
  setBook,
}: UseBookPageTurnEffectParams) => {
  // 外部文件的临时翻页效果（不持久化）
  const [externalPageTurnEffect, setExternalPageTurnEffect] =
    useState<PageTurnEffect>("slide");

  /**
   * 计算当前生效的翻页动画效果
   * - 返回值：'slide'（平移）/'cover'（覆盖）/'none'（无动画），书籍未配置时默认 'slide'
   */
  const pageTurnEffect: PageTurnEffect = isExternal
    ? externalPageTurnEffect
    : (book?.page_turn_effect ?? "slide");

  /**
   * 更新翻页动画效果：外部文件仅更新临时状态；普通书籍持久化到后端并同步 book 状态
   * - 参数 effect：目标翻页效果
   * - 返回：Promise；写入失败时打印错误并保持原效果
   */
  const setPageTurnEffect = useCallback(
    async (effect: PageTurnEffect) => {
      if (isExternal) {
        setExternalPageTurnEffect(effect);
        return;
      }
      if (!book || !book.id) return;
      try {
        await bookService.updateBookPageTurnEffect(book.id, effect);
        setBook((prev) => {
          if (!prev || prev.id !== book.id) return prev;
          return { ...prev, page_turn_effect: effect };
        });
      } catch (error) {
        console.error(
          "[useBookPageTurnEffect] Failed to update page turn effect:",
          error
        );
      }
    },
    [book, isExternal, setBook]
  );

  return {
    pageTurnEffect,
    setPageTurnEffect,
  };
};

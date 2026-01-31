import { useMemo } from "react";
import { getBookFormat } from "../../../services/formats";
import { IBook } from "../../../types";

/**
 * 这是一个辅助 Hook，用于根据书籍信息或外部文件路径判断书籍格式
 * 提取自 Reader.tsx 以简化主组件逻辑
 */
export const useBookFormatHelper = (
  book: IBook | null | undefined,
  isExternal: boolean,
  externalPath: string | undefined
) => {
  const bookFilePath = useMemo(() => {
    return (isExternal ? externalPath : book?.file_path) || null;
  }, [isExternal, externalPath, book?.file_path]);

  const isEpubDom = useMemo(() => {
    if (!bookFilePath) return false;
    return getBookFormat(bookFilePath) === "epub";
  }, [bookFilePath]);

  const isMobi = useMemo(() => {
    if (!bookFilePath) return false;
    return getBookFormat(bookFilePath) === "mobi";
  }, [bookFilePath]);

  const isMarkdown = useMemo(() => {
    if (!bookFilePath) return false;
    return getBookFormat(bookFilePath) === "markdown";
  }, [bookFilePath]);

  const isHtml = useMemo(() => {
    if (!bookFilePath) return false;
    return getBookFormat(bookFilePath) === "html";
  }, [bookFilePath]);

  return {
    bookFilePath,
    isEpubDom,
    isMobi,
    isMarkdown,
    isHtml,
  };
};

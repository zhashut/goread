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

  const format = useMemo(() => {
    if (!bookFilePath) return null;
    return getBookFormat(bookFilePath);
  }, [bookFilePath]);

  const isEpubDom = useMemo(() => {
    if (!format) return false;
    return format === "epub";
  }, [format]);

  const isMobi = useMemo(() => {
    if (!format) return false;
    return format === "mobi";
  }, [format]);

  const isMarkdown = useMemo(() => {
    if (!format) return false;
    return format === "markdown";
  }, [format]);

  const isHtml = useMemo(() => {
    if (!format) return false;
    return format === "html";
  }, [format]);

  const isTxt = useMemo(() => {
    if (!format) return false;
    return format === "txt";
  }, [format]);

  return {
    bookFilePath,
    format,
    isEpubDom,
    isMobi,
    isMarkdown,
    isHtml,
    isTxt,
  };
};

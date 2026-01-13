import { useState, useEffect, useRef, useCallback } from "react";
import { IBook } from "../../../types";
import { bookService } from "../../../services";
import { IBookRenderer } from "../../../services/formats";
import { EpubRenderer } from "../../../services/formats/epub/EpubRenderer";

type ReadingMode = "horizontal" | "vertical";

interface UseBookReadingModeOptions {
  book: IBook | null;
  isExternal: boolean;
  rendererRef: React.MutableRefObject<IBookRenderer | null>;
}

/**
 * 管理书籍级别阅读模式的 Hook
 * 负责读取/保存书籍的阅读模式配置，以及同步到渲染器
 */
export const useBookReadingMode = ({
  book,
  isExternal,
  rendererRef,
}: UseBookReadingModeOptions) => {
  // 外部文件的临时阅读模式（不持久化）
  const [externalReadingMode, setExternalReadingMode] = useState<ReadingMode>("vertical");
  
  // 用于追踪是否需要同步到渲染器
  const prevModeRef = useRef<ReadingMode | null>(null);

  // 计算当前书籍的有效阅读模式
  const getEffectiveReadingMode = useCallback((): ReadingMode => {
    if (isExternal) {
      // 外部文件使用临时状态
      return externalReadingMode;
    }
    
    if (book?.reading_mode) {
      // 书籍有配置时使用书籍配置
      return book.reading_mode;
    }
    
    // 默认使用纵向模式
    return "vertical";
  }, [book?.reading_mode, isExternal, externalReadingMode]);

  const readingMode = getEffectiveReadingMode();

  // 更新阅读模式
  const setReadingMode = useCallback(
    async (mode: ReadingMode) => {
      if (isExternal) {
        // 外部文件只更新临时状态，不持久化
        setExternalReadingMode(mode);
        return;
      }

      if (!book?.id) {
        return;
      }

      try {
        // 调用后端接口更新阅读模式
        await bookService.updateBookReadingMode(book.id, mode);
        
        // 注意：这里不直接更新 book 对象，依赖外部调用方更新 book 状态
        // 以保持数据流的一致性
      } catch (error) {
        console.error("[useBookReadingMode] Failed to update reading mode:", error);
      }
    },
    [book?.id, isExternal]
  );

  // 当阅读模式变化时，同步到 EPUB 渲染器
  useEffect(() => {
    // 跳过首次渲染或模式未变化的情况
    if (prevModeRef.current === readingMode) {
      return;
    }

    const renderer = rendererRef.current;
    if (renderer && renderer instanceof EpubRenderer) {
      renderer.setReadingMode(readingMode).catch(() => {});
    }

    prevModeRef.current = readingMode;
  }, [readingMode, rendererRef]);

  return {
    readingMode,
    setReadingMode,
  };
};

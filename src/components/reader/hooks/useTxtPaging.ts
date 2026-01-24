import { useEffect, useRef } from 'react';
import { TxtRenderer } from '../../../services/formats/txt/TxtRenderer';
import { IBookRenderer, RenderOptions } from '../../../services/formats';
import { bookService } from '../../../services';
import { useReaderState } from './useReaderState';

/**
 * TXT 专用分页 Hook
 * 负责 TXT 格式的虚拟分页与进度管理
 * 支持横向和纵向两种阅读模式
 */
export type TxtPagingProps = {
  readerState: ReturnType<typeof useReaderState>;
  rendererRef: React.MutableRefObject<IBookRenderer | null>;
  domContainerRef: React.RefObject<HTMLDivElement>;
  options?: RenderOptions;
  readingMode?: 'horizontal' | 'vertical';
};

export const useTxtPaging = ({
  readerState,
  rendererRef,
  domContainerRef,
  options,
  readingMode = 'horizontal',
}: TxtPagingProps) => {
  const {
    book,
    loading,
    isExternal,
    totalPages,
    currentPage,
    setTotalPages,
    setCurrentPage,
    savedPageAtOpenRef,
    setContentReady,
    latestPreciseProgressRef,
  } = readerState;

  // 防止重复初始化
  const initializedRef = useRef(false);
  // 上一次页码
  const lastPageRef = useRef(currentPage);
  // 上一次阅读模式
  const lastModeRef = useRef(readingMode);
  const lastSavedPreciseRef = useRef<number | null>(null);
  const lastSaveTimeRef = useRef<number>(0);
  const migratedProgressRef = useRef(false);

  // 判断是否为 TXT 渲染器
  const isTxtRenderer = (r: IBookRenderer | null): r is TxtRenderer => {
    return r !== null && r.format === 'txt';
  };

  // 阅读模式切换时重置初始化状态
  useEffect(() => {
    if (lastModeRef.current !== readingMode) {
      lastModeRef.current = readingMode;
      initializedRef.current = false;
    }
  }, [readingMode]);

  // 分页初始化
  useEffect(() => {
    if (loading || (!book && !isExternal)) return;

    const renderer = rendererRef.current;
    if (!isTxtRenderer(renderer)) return;

    const container = domContainerRef.current;
    if (!container) return;

    // 等待容器尺寸就绪
    if (container.clientWidth <= 0 || container.clientHeight <= 0) {
      const checkId = setInterval(() => {
        if (container.clientWidth > 0 && container.clientHeight > 0) {
          clearInterval(checkId);
          initPagination();
        }
      }, 100);
      return () => clearInterval(checkId);
    }

    initPagination();

    async function initPagination() {
      if (initializedRef.current) return;
      initializedRef.current = true;

      const txtRenderer = renderer as TxtRenderer;

      try {
        await txtRenderer.ensurePagination(container!, options);

        const unifiedTotalPages = txtRenderer.getPageCount();
        if (unifiedTotalPages > 1 && unifiedTotalPages !== totalPages) {
          setTotalPages(unifiedTotalPages);
          if (!isExternal && book) {
            bookService.updateBookTotalPages(book.id, unifiedTotalPages).catch(() => {});
          }
        }

        const resolveProgress = (raw: number): number => {
          const total = unifiedTotalPages > 0 ? unifiedTotalPages : 1;
          let value = raw;

          if (!isExternal && book && !migratedProgressRef.current) {
            const oldTotal = book.total_pages || 1;
            if (oldTotal > 0 && oldTotal !== total) {
              const denom = Math.max(1, oldTotal - 1);
              const mapped = 1 + ((raw - 1) * (total - 1)) / denom;
              value = mapped;
              migratedProgressRef.current = true;
            }
          }

          if (value < 1) value = 1;
          if (value > total) value = total;
          return value;
        };

        const rawProgress =
          latestPreciseProgressRef.current ?? savedPageAtOpenRef.current ?? 1;
        const preciseProgress = resolveProgress(rawProgress);
        savedPageAtOpenRef.current = preciseProgress;

        if (readingMode === 'vertical') {
          await txtRenderer.renderFullContent(container!, options);

          const viewportHeight = container!.clientHeight;
          if (viewportHeight > 0) {
            txtRenderer.scrollToVirtualPage(preciseProgress, viewportHeight);
          }
          const pageInt = Math.floor(preciseProgress);
          setCurrentPage(pageInt);
          lastPageRef.current = pageInt;
          if (latestPreciseProgressRef) {
            latestPreciseProgressRef.current = preciseProgress;
          }
        } else {
          const targetPage = Math.min(
            Math.max(1, Math.floor(preciseProgress)),
            unifiedTotalPages > 0 ? unifiedTotalPages : 1
          );

          await txtRenderer.renderPage(targetPage, container!, options);
          setCurrentPage(targetPage);
          lastPageRef.current = targetPage;
          if (latestPreciseProgressRef) {
            latestPreciseProgressRef.current = preciseProgress;
          }
        }
        setContentReady(true);
      } catch (err) {
        console.error('[useTxtPaging] initPagination failed', err);
      }
    }
  }, [loading, book?.id, isExternal, readingMode]);

  // 页码变化监听：跳转到目标页并持久化进度
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!isTxtRenderer(renderer)) return;
    if (currentPage === lastPageRef.current) return;

    const container = domContainerRef.current;
    if (!container) return;

    lastPageRef.current = currentPage;

    if (readingMode === 'vertical') {
      const viewportHeight = container.clientHeight;
      renderer.scrollToVirtualPage(currentPage, viewportHeight);
    } else {
      renderer.goToPage(currentPage).catch(() => {});
    }

    if (latestPreciseProgressRef) {
      latestPreciseProgressRef.current = currentPage;
    }

    if (!isExternal && book && readingMode !== 'vertical') {
      bookService.updateBookProgress(book.id, currentPage).catch(() => {});
    }
  }, [currentPage, book?.id, isExternal, readingMode]);

  // 纵向模式滚动监听：更新虚拟页码
  useEffect(() => {
    if (readingMode !== 'vertical') return;
    if (loading || (!book && !isExternal)) return;

    const renderer = rendererRef.current;
    if (!isTxtRenderer(renderer)) return;

    const container = domContainerRef.current;
    if (!container) return;

    let rafId: number | null = null;

    const handleScroll = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        const viewportHeight = container.clientHeight;
        if (viewportHeight <= 0) return;

        const scrollTop = container.scrollTop;
        const scrollHeight = container.scrollHeight;
        const maxScrollTop = Math.max(0, scrollHeight - viewportHeight);

        let virtualTotalPages =
          totalPages > 0 ? totalPages : renderer.getPageCount();
        if (virtualTotalPages <= 0) {
          virtualTotalPages = 1;
        }

        let precisePage = 1;
        if (maxScrollTop > 0 && virtualTotalPages > 1) {
          const ratio = scrollTop / maxScrollTop;
          const clampedRatio = Math.max(0, Math.min(1, ratio));
          precisePage = 1 + clampedRatio * (virtualTotalPages - 1);
        } else {
          precisePage = 1;
        }

        const pageInt = Math.floor(precisePage);
        if (pageInt !== lastPageRef.current) {
          lastPageRef.current = pageInt;
          setCurrentPage(pageInt);
        }

        if (latestPreciseProgressRef) {
          latestPreciseProgressRef.current = precisePage;
        }

        if (!isExternal && book) {
          const now = Date.now();
          const lastPrecise = lastSavedPreciseRef.current;
          const lastTime = lastSaveTimeRef.current;

          let shouldSave = false;
          if (lastPrecise === null) {
            shouldSave = true;
          } else if (Math.abs(precisePage - lastPrecise) >= 0.1) {
            shouldSave = true;
          } else if (now - lastTime >= 3000) {
            shouldSave = true;
          }

          if (shouldSave) {
            lastSavedPreciseRef.current = precisePage;
            lastSaveTimeRef.current = now;
            bookService.updateBookProgress(book.id, precisePage).catch(() => {});
          }
        }
      });
    };

    container.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      container.removeEventListener('scroll', handleScroll);
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
    };
  }, [readingMode, loading, book?.id, isExternal, totalPages]);

  useEffect(() => {
    if (loading || (!book && !isExternal)) return;

    const renderer = rendererRef.current;
    if (!isTxtRenderer(renderer)) return;
    if (!initializedRef.current) return;

    const container = domContainerRef.current;
    if (!container) return;

    const txtRenderer = renderer;

    const rerender = async () => {
      try {
        if (readingMode === 'vertical') {
          await txtRenderer.renderFullContent(container, options);

          const viewportHeight = container.clientHeight;
          if (viewportHeight <= 0) return;

          const total = txtRenderer.getPageCount() || 1;
          let precisePage =
            latestPreciseProgressRef.current ?? savedPageAtOpenRef.current ?? 1;

          if (precisePage < 1) precisePage = 1;
          if (precisePage > total) precisePage = total;

          txtRenderer.scrollToVirtualPage(precisePage, viewportHeight);

          const pageInt = Math.floor(precisePage);
          setCurrentPage(pageInt);
          if (latestPreciseProgressRef) {
            latestPreciseProgressRef.current = precisePage;
          }
        } else {
          const total = txtRenderer.getPageCount() || 1;
          let targetPage = currentPage || 1;
          if (targetPage < 1) targetPage = 1;
          if (targetPage > total) targetPage = total;

          await txtRenderer.renderPage(targetPage, container, options);
          setCurrentPage(targetPage);
          if (latestPreciseProgressRef) {
            latestPreciseProgressRef.current = targetPage;
          }
        }
      } catch {
      }
    };

    rerender();
  }, [options?.theme, options?.pageGap, readingMode, book?.id, isExternal]);

  // 清理：书籍切换时重置初始化状态
  useEffect(() => {
    return () => {
      initializedRef.current = false;
      lastSavedPreciseRef.current = null;
      lastSaveTimeRef.current = 0;
    };
  }, [book?.id]);
};

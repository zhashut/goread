import { useEffect, useRef } from 'react';
import { TxtRenderer } from '../../../services/formats/txt/TxtRenderer';
import { IBookRenderer, RenderOptions, TocItem } from '../../../services/formats';
import { bookService } from '../../../services';
import { useReaderState } from './useReaderState';
import { TocNode } from '../types';
import { findActiveNodeSignature } from './useToc';

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
  /** 目录更新回调，分页完成后触发 */
  setToc?: (toc: TocNode[]) => void;
  /** 目录数据，用于计算当前章节高亮 */
  toc?: TocNode[];
  /** 设置当前激活章节签名 */
  setActiveNodeSignature?: (sig: string | undefined) => void;
};

export const useTxtPaging = ({
  readerState,
  rendererRef,
  domContainerRef,
  options,
  readingMode = 'horizontal',
  setToc,
  toc,
  setActiveNodeSignature,
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

  // TXT 格式目录章节高亮：当页码或目录变化时更新激活章节
  useEffect(() => {
    // 仅对 TXT 格式生效，避免影响其他格式的目录高亮逻辑
    const renderer = rendererRef.current;
    if (!isTxtRenderer(renderer)) return;
    
    if (!setActiveNodeSignature || !toc || toc.length === 0) return;
    const sig = findActiveNodeSignature(currentPage, 1.0, true, toc);
    setActiveNodeSignature(sig || undefined);
  }, [currentPage, toc, setActiveNodeSignature, rendererRef]);

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

      // 注册目录更新回调，分页完成后将字符偏移量转换为真实页码
      if (setToc) {
        txtRenderer.onTocUpdated = (updatedToc: TocItem[]) => {
          const toTocNode = (items: TocItem[]): TocNode[] => {
            return items.map((item) => ({
              title: item.title,
              page: typeof item.location === 'number' ? item.location : undefined,
              children: item.children ? toTocNode(item.children) : [],
              expanded: false,
            }));
          };
          setToc(toTocNode(updatedToc));
        };
      }

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
          const pageInt = Math.floor(preciseProgress);
          
          // 先更新 ref，避免 setCurrentPage 触发页码变化监听时产生二次滚动
          lastPageRef.current = pageInt;
          if (latestPreciseProgressRef) {
            latestPreciseProgressRef.current = preciseProgress;
          }
          
          // 再设置页码和滚动
          setCurrentPage(pageInt);
          if (viewportHeight > 0) {
            txtRenderer.scrollToVirtualPage(preciseProgress, viewportHeight);
          }
        } else {
          const targetPage = Math.min(
            Math.max(1, Math.floor(preciseProgress)),
            unifiedTotalPages > 0 ? unifiedTotalPages : 1
          );

          // 先更新 ref，避免 setCurrentPage 触发页码变化监听时产生二次渲染
          lastPageRef.current = targetPage;
          if (latestPreciseProgressRef) {
            latestPreciseProgressRef.current = preciseProgress;
          }
          
          await txtRenderer.renderPage(targetPage, container!, options);
          setCurrentPage(targetPage);
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
      // 纵向模式：优先使用精确进度（如果整数部分匹配）
      const viewportHeight = container.clientHeight;
      const preciseProgress = latestPreciseProgressRef?.current ?? currentPage;
      const preciseIntPage = Math.floor(preciseProgress);
      
      if (preciseIntPage === currentPage) {
        // 整数部分匹配，使用精确进度恢复位置
        renderer.scrollToVirtualPage(preciseProgress, viewportHeight);
      } else {
        // 整数部分不匹配，说明是新的页面跳转，使用整数页码
        renderer.scrollToVirtualPage(currentPage, viewportHeight);
      }
    } else {
      renderer.goToPage(currentPage).catch(() => {});
    }

    // 页码跳转时更新精确进度
    // 如果是外部整数页码跳转，检查当前是否在同一页，保留原精确进度
    if (latestPreciseProgressRef) {
      const existingProgress = latestPreciseProgressRef.current ?? currentPage;
      const existingIntPage = Math.floor(existingProgress);
      if (existingIntPage !== currentPage) {
        // 跳转到不同页，重置为整数页码
        latestPreciseProgressRef.current = currentPage;
      }
      // 同一页内则保留现有精确进度
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

        // 触底检测：如果滚动到底部，直接设为最后一页
        const isAtBottom = maxScrollTop > 0 && scrollTop >= maxScrollTop - 2; // 2px 容差
        if (isAtBottom) {
          const total = totalPages > 0 ? totalPages : renderer.getPageCount();
          const precisePage = total;
          renderer.updatePreciseProgress(precisePage);

          if (precisePage !== lastPageRef.current) {
            lastPageRef.current = precisePage;
            setCurrentPage(precisePage);
          }

          if (latestPreciseProgressRef) {
            latestPreciseProgressRef.current = precisePage;
          }

          if (!isExternal && book) {
            const now = Date.now();
            const lastPrecise = lastSavedPreciseRef.current;
            const lastTime = lastSaveTimeRef.current;
            if (lastPrecise === null || Math.abs(precisePage - lastPrecise) >= 0.1 || now - lastTime >= 3000) {
              lastSavedPreciseRef.current = precisePage;
              lastSaveTimeRef.current = now;
              bookService.updateBookProgress(book.id, precisePage).catch(() => {});
            }
          }
          return;
        }

        // 基于 pageWrapper 锚点计算精确进度
        const pageWrappers = container.querySelectorAll('[data-page-index]');
        let currentPageIndex = 0;
        let offsetRatio = 0;
        let foundWrapper = false;

        for (const wrapper of pageWrappers) {
          const el = wrapper as HTMLElement;
          const wrapperTop = el.offsetTop;
          const wrapperHeight = el.scrollHeight;
          const wrapperBottom = wrapperTop + wrapperHeight;

          // 判断滚动位置是否在这个 wrapper 内
          if (scrollTop >= wrapperTop && scrollTop < wrapperBottom) {
            currentPageIndex = parseInt(el.getAttribute('data-page-index') || '0', 10);
            // 计算页内偏移比例
            if (wrapperHeight > 0) {
              offsetRatio = (scrollTop - wrapperTop) / wrapperHeight;
              offsetRatio = Math.max(0, Math.min(1, offsetRatio));
            }
            foundWrapper = true;
            break;
          }
        }

        // 如果没找到对应的 wrapper，使用降级计算
        let precisePage = 1;
        if (foundWrapper) {
          // 精确进度 = 页码(1-based) + 页内偏移
          precisePage = (currentPageIndex + 1) + offsetRatio;
        } else {
          // 降级：使用原有的全局比例计算
          const scrollHeight = container.scrollHeight;
          const maxScrollTop = Math.max(0, scrollHeight - viewportHeight);
          let virtualTotalPages =
            totalPages > 0 ? totalPages : renderer.getPageCount();
          if (virtualTotalPages <= 0) {
            virtualTotalPages = 1;
          }
          if (maxScrollTop > 0 && virtualTotalPages > 1) {
            const ratio = scrollTop / maxScrollTop;
            const clampedRatio = Math.max(0, Math.min(1, ratio));
            precisePage = 1 + clampedRatio * (virtualTotalPages - 1);
          }
        }

        // 同步更新渲染器内部精确进度
        renderer.updatePreciseProgress(precisePage);

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

          const pageInt = Math.floor(precisePage);
          
          // 先更新 ref，避免 setCurrentPage 触发页码变化监听时产生二次滚动
          lastPageRef.current = pageInt;
          if (latestPreciseProgressRef) {
            latestPreciseProgressRef.current = precisePage;
          }
          
          setCurrentPage(pageInt);
          txtRenderer.scrollToVirtualPage(precisePage, viewportHeight);
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

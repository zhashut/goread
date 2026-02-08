import { useEffect, useRef } from 'react';
import { TxtRenderer } from '../../../services/formats/txt/TxtRenderer';
import { IBookRenderer, RenderOptions, TocItem } from '../../../services/formats';
import { bookService, log } from '../../../services';
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
  const lastScrollTopRef = useRef<number>(0);
  const isAutoSwitchingChapterRef = useRef(false);
  const lastAutoSwitchTsRef = useRef<number>(0);
  const lastPreloadTsRef = useRef<number>(0);
  const lastPreloadTargetRef = useRef<number | null>(null);

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
      const chapterMode = txtRenderer.isChapterMode();

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
        const resolveProgress = (raw: number): number => {
          const total = totalPages > 0 ? totalPages : 1;
          let value = raw;

          if (!isExternal && book && !migratedProgressRef.current) {
            const oldTotal = book.total_pages || 1;
            const shouldMapLegacy = oldTotal > 1 && oldTotal !== total && raw > total + 0.0001;
            if (shouldMapLegacy) {
              const denom = Math.max(1, oldTotal - 1);
              const mapped = 1 + ((raw - 1) * (total - 1)) / denom;
              value = mapped;
              migratedProgressRef.current = true;
            }
          }

          if (chapterMode) {
            if (value < 1) value = 1;
            const max = total + 0.999999;
            if (value > max) value = max;

            if (!isExternal && book && book.status !== 1 && total > 1) {
              const oldTotal = book.total_pages || 1;
              const atLegacyEnd = oldTotal > 1 && raw >= oldTotal - 0.0001;
              if (atLegacyEnd) {
                value = Math.min(value, (total - 1) + 0.9999);
              }
            }
          } else {
            if (value < 1) value = 1;
            if (value > total) value = total;
          }
          return value;
        };

        const rawProgress =
          latestPreciseProgressRef.current ?? savedPageAtOpenRef.current ?? 1;
        let preciseProgress = resolveProgress(rawProgress);

        if (chapterMode) {
          const chapterCount = Math.max(1, txtRenderer.getChapterCount());
          const targetChapterIndex = Math.min(
            Math.max(0, Math.floor(preciseProgress) - 1),
            chapterCount - 1
          );
          await txtRenderer.goToChapter(targetChapterIndex);
        }

        await txtRenderer.ensurePagination(container!, options);
        const unifiedTotalPages = txtRenderer.getPageCount();

        if (chapterMode && readingMode !== 'vertical') {
          const chapterCount = Math.max(1, txtRenderer.getChapterCount());
          const chapterInt = Math.min(
            Math.max(1, Math.floor(preciseProgress)),
            chapterCount
          );
          preciseProgress = chapterInt;
        }

        savedPageAtOpenRef.current = preciseProgress;
        txtRenderer.updatePreciseProgress(preciseProgress);

        try {
          log("[useTxtPaging] initPagination", "info", {
            bookId: book?.id,
            isExternal,
            readingMode,
            unifiedTotalPages,
            totalPagesFromState: totalPages,
            chapterCount: txtRenderer.getChapterCount(),
            rawProgress,
            preciseProgress,
          }).catch(() => { });
        } catch {
        }

        if (readingMode === 'vertical') {
          await txtRenderer.renderFullContent(container!, options);

          const viewportHeight = container!.clientHeight;
          const pageInt = chapterMode
            ? Math.min(Math.max(1, Math.floor(preciseProgress)), Math.max(1, txtRenderer.getChapterCount()))
            : Math.floor(preciseProgress);
          
          // 先更新 ref，避免 setCurrentPage 触发页码变化监听时产生二次滚动
          lastPageRef.current = pageInt;
          if (latestPreciseProgressRef) {
            latestPreciseProgressRef.current = preciseProgress;
          }
          
          // 再设置页码和滚动
          setCurrentPage(pageInt);
          if (viewportHeight > 0) {
            if (chapterMode) {
              const virtualPrecise = txtRenderer.convertChapterPreciseToVirtualPrecise(preciseProgress);
              txtRenderer.scrollToVirtualPage(virtualPrecise, viewportHeight);
            } else {
              txtRenderer.scrollToVirtualPage(preciseProgress, viewportHeight);
            }
          }
        } else {
          const targetPage = chapterMode
            ? 1
            : Math.min(
                Math.max(1, Math.floor(preciseProgress)),
                unifiedTotalPages > 0 ? unifiedTotalPages : 1
              );

          // 先更新 ref，避免 setCurrentPage 触发页码变化监听时产生二次渲染
          lastPageRef.current = chapterMode ? Math.floor(preciseProgress) : targetPage;
          if (latestPreciseProgressRef) {
            latestPreciseProgressRef.current = preciseProgress;
          }
          
          await txtRenderer.renderPage(targetPage, container!, options);
          setCurrentPage(chapterMode ? Math.floor(preciseProgress) : targetPage);
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
    const chapterMode = renderer.isChapterMode();

    if (readingMode === 'vertical') {
      if (chapterMode) {
        const chapterCount = Math.max(1, renderer.getChapterCount());
        const targetChapterIndex = Math.min(
          Math.max(0, currentPage - 1),
          chapterCount - 1
        );
        renderer
          .goToChapter(targetChapterIndex)
          .then(() => {
            const viewportHeight = container.clientHeight;
            const preciseProgress = latestPreciseProgressRef?.current ?? currentPage;
            const virtualPrecise = renderer.convertChapterPreciseToVirtualPrecise(preciseProgress);
            renderer.scrollToVirtualPage(virtualPrecise, viewportHeight);
            lastScrollTopRef.current = container.scrollTop;
          })
          .catch(() => { });
      }

      // 纵向模式：优先使用精确进度（如果整数部分匹配）
      const viewportHeight = container.clientHeight;
      const preciseProgress = latestPreciseProgressRef?.current ?? currentPage;
      const preciseIntPage = Math.floor(preciseProgress);
      
      if (preciseIntPage === currentPage) {
        // 整数部分匹配，使用精确进度恢复位置
        if (!chapterMode) {
          renderer.scrollToVirtualPage(preciseProgress, viewportHeight);
        }
      } else {
        // 整数部分不匹配，说明是新的页面跳转，使用整数页码
        if (!chapterMode) {
          renderer.scrollToVirtualPage(currentPage, viewportHeight);
        }
      }
    } else {
      if (chapterMode) {
        const chapterCount = Math.max(1, renderer.getChapterCount());
        const targetChapterIndex = Math.min(
          Math.max(0, currentPage - 1),
          chapterCount - 1
        );
        renderer.goToChapter(targetChapterIndex).catch(() => { });
      } else {
        renderer.goToPage(currentPage).catch(() => { });
      }
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
      bookService
        .updateBookProgress(book.id, latestPreciseProgressRef?.current ?? currentPage)
        .catch(() => { });
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
    const chapterMode = renderer.isChapterMode();

    const handleScroll = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        const viewportHeight = container.clientHeight;
        if (viewportHeight <= 0) return;

        const scrollTop = container.scrollTop;
        const scrollHeight = container.scrollHeight;
        const maxScrollTop = Math.max(0, scrollHeight - viewportHeight);
        const wasScrollTop = lastScrollTopRef.current;
        lastScrollTopRef.current = scrollTop;

        // 触底检测：如果滚动到底部，直接设为最后一页
        const isAtBottom = maxScrollTop > 0 && scrollTop >= maxScrollTop - 2; // 2px 容差
        if (isAtBottom) {
          if (chapterMode) {
            const chapterCount = Math.max(1, renderer.getChapterCount());
            const currentChapterIndex = renderer.getCurrentChapterIndex();
            const canGoNext = currentChapterIndex < chapterCount - 1;
            const isScrollingDown = scrollTop > wasScrollTop;
            const now = Date.now();
            const canAutoSwitch =
              canGoNext &&
              isScrollingDown &&
              !isAutoSwitchingChapterRef.current &&
              now - lastAutoSwitchTsRef.current > 450;

            if (canAutoSwitch) {
              isAutoSwitchingChapterRef.current = true;
              lastAutoSwitchTsRef.current = now;
              void (async () => {
                try {
                  const nextChapterIndex = currentChapterIndex + 1;
                  await renderer.goToChapter(nextChapterIndex);
                  container.scrollTop = 0;

                  const nextChapterPage = nextChapterIndex + 1;
                  lastPageRef.current = nextChapterPage;
                  setCurrentPage(nextChapterPage);
                  if (latestPreciseProgressRef) {
                    latestPreciseProgressRef.current = nextChapterPage;
                  }

                  if (!isExternal && book) {
                    lastSavedPreciseRef.current = nextChapterPage;
                    lastSaveTimeRef.current = Date.now();
                    bookService.updateBookProgress(book.id, nextChapterPage).catch(() => { });
                  }
                } finally {
                  isAutoSwitchingChapterRef.current = false;
                }
              })();
              return;
            }

            const chapterPage = renderer.getCurrentChapterIndex() + 1;
            const preciseProgress = chapterPage + 0.9999;
            const pageInt = Math.floor(preciseProgress);
            if (pageInt !== lastPageRef.current) {
              lastPageRef.current = pageInt;
              setCurrentPage(pageInt);
            }
            if (latestPreciseProgressRef) {
              latestPreciseProgressRef.current = preciseProgress;
            }
          } else {
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
          }

          if (!isExternal && book) {
            const now = Date.now();
            const lastPrecise = lastSavedPreciseRef.current;
            const lastTime = lastSaveTimeRef.current;
            const valueToSave = chapterMode
              ? (latestPreciseProgressRef?.current ?? (renderer.getCurrentChapterIndex() + 1))
              : (latestPreciseProgressRef?.current ?? currentPage);
            if (lastPrecise === null || Math.abs(valueToSave - lastPrecise) >= 0.1 || now - lastTime >= 3000) {
              lastSavedPreciseRef.current = valueToSave;
              lastSaveTimeRef.current = now;
              bookService.updateBookProgress(book.id, valueToSave).catch(() => { });
            }
          }
          return;
        }

        const isAtTop = scrollTop <= 2;
        if (isAtTop && chapterMode) {
          const currentChapterIndex = renderer.getCurrentChapterIndex();
          const canGoPrev = currentChapterIndex > 0;
          const isScrollingUp = scrollTop < wasScrollTop;
          const now = Date.now();
          const canAutoSwitch =
            canGoPrev &&
            isScrollingUp &&
            !isAutoSwitchingChapterRef.current &&
            now - lastAutoSwitchTsRef.current > 450;

          if (canAutoSwitch) {
            isAutoSwitchingChapterRef.current = true;
            lastAutoSwitchTsRef.current = now;
            void (async () => {
              try {
                const prevChapterIndex = currentChapterIndex - 1;
                await renderer.goToChapter(prevChapterIndex);

                const safePadding = 12;
                const targetScrollTop = Math.max(
                  0,
                  container.scrollHeight - viewportHeight - safePadding
                );
                container.scrollTop = targetScrollTop;
                lastScrollTopRef.current = targetScrollTop;

                const prevChapterPage = prevChapterIndex + 1;
                lastPageRef.current = prevChapterPage;
                setCurrentPage(prevChapterPage);
                if (latestPreciseProgressRef) {
                  latestPreciseProgressRef.current = prevChapterPage + 0.9999;
                }

                if (!isExternal && book) {
                  const valueToSave =
                    latestPreciseProgressRef?.current ?? prevChapterPage;
                  lastSavedPreciseRef.current = valueToSave;
                  lastSaveTimeRef.current = Date.now();
                  bookService.updateBookProgress(book.id, valueToSave).catch(() => { });
                }
              } finally {
                isAutoSwitchingChapterRef.current = false;
              }
            })();
            return;
          }
        }

        const virtualPrecise = renderer.getVirtualPreciseByScrollTop(scrollTop);
        const virtualTotalPages = Math.max(1, renderer.getPageCount());
        const ratio =
          virtualTotalPages <= 1
            ? 0
            : Math.max(0, Math.min(1, (virtualPrecise - 1) / (virtualTotalPages - 1)));

        if (chapterMode) {
          const now = Date.now();
          const chapterCount = Math.max(1, renderer.getChapterCount());
          const currentChapterIndex = renderer.getCurrentChapterIndex();
          let targetIndex: number | null = null;
          if (ratio >= 0.8 && currentChapterIndex < chapterCount - 1) {
            targetIndex = currentChapterIndex + 1;
          } else if (ratio <= 0.2 && currentChapterIndex > 0) {
            targetIndex = currentChapterIndex - 1;
          }
          if (
            targetIndex !== null &&
            now - lastPreloadTsRef.current >= 800 &&
            lastPreloadTargetRef.current !== targetIndex
          ) {
            lastPreloadTsRef.current = now;
            lastPreloadTargetRef.current = targetIndex;
            renderer.preloadAdjacentChapters(targetIndex).catch(() => { });
          }

          const chapterPage = renderer.getCurrentChapterIndex() + 1;
          const chapterPrecise = renderer.convertVirtualPreciseToChapterPrecise(virtualPrecise);
          renderer.updatePreciseProgress(chapterPrecise);

          if (chapterPage !== lastPageRef.current) {
            lastPageRef.current = chapterPage;
            setCurrentPage(chapterPage);
          }

          if (latestPreciseProgressRef) {
            latestPreciseProgressRef.current = chapterPrecise;
          }
        } else {
          renderer.updatePreciseProgress(virtualPrecise);

          const pageInt = Math.floor(virtualPrecise);
          if (pageInt !== lastPageRef.current) {
            lastPageRef.current = pageInt;
            setCurrentPage(pageInt);
          }

          if (latestPreciseProgressRef) {
            latestPreciseProgressRef.current = virtualPrecise;
          }
        }

        if (!isExternal && book) {
          const now = Date.now();
          const lastPrecise = lastSavedPreciseRef.current;
          const lastTime = lastSaveTimeRef.current;
          const progressToSave =
            latestPreciseProgressRef?.current ?? renderer.getPreciseProgress();

          let shouldSave = false;
          if (lastPrecise === null) {
            shouldSave = true;
          } else if (Math.abs(progressToSave - lastPrecise) >= 0.1) {
            shouldSave = true;
          } else if (now - lastTime >= 3000) {
            shouldSave = true;
          }

          if (shouldSave) {
            lastSavedPreciseRef.current = progressToSave;
            lastSaveTimeRef.current = now;
            bookService
              .updateBookProgress(book.id, progressToSave)
              .catch(() => { });
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
        const chapterMode = txtRenderer.isChapterMode();
        if (readingMode === 'vertical') {
          let preciseProgress =
            latestPreciseProgressRef.current ?? savedPageAtOpenRef.current ?? 1;

          if (chapterMode) {
            const chapterCount = Math.max(1, txtRenderer.getChapterCount());
            if (preciseProgress < 1) preciseProgress = 1;
            const max = chapterCount + 0.999999;
            if (preciseProgress > max) preciseProgress = max;

            const chapterInt = Math.min(
              Math.max(1, Math.floor(preciseProgress)),
              chapterCount
            );
            const targetChapterIndex = chapterInt - 1;
            if (txtRenderer.getCurrentChapterIndex() !== targetChapterIndex) {
              await txtRenderer.goToChapter(targetChapterIndex);
            }
          }

          await txtRenderer.renderFullContent(container, options);

          const viewportHeight = container.clientHeight;
          if (viewportHeight <= 0) return;

          if (chapterMode) {
            const chapterCount = Math.max(1, txtRenderer.getChapterCount());
            const chapterInt = Math.min(
              Math.max(1, Math.floor(preciseProgress)),
              chapterCount
            );

            lastPageRef.current = chapterInt;
            if (latestPreciseProgressRef) {
              latestPreciseProgressRef.current = preciseProgress;
            }

            setCurrentPage(chapterInt);

            const virtualPrecise = txtRenderer.convertChapterPreciseToVirtualPrecise(preciseProgress);
            txtRenderer.scrollToVirtualPage(virtualPrecise, viewportHeight);
          } else {
            const total = txtRenderer.getPageCount() || 1;
            let precisePage = preciseProgress;

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
          }
        } else {
          if (chapterMode) {
            const chapterCount = Math.max(1, txtRenderer.getChapterCount());
            let chapterInt = currentPage || 1;
            if (chapterInt < 1) chapterInt = 1;
            if (chapterInt > chapterCount) chapterInt = chapterCount;

            const targetChapterIndex = chapterInt - 1;
            if (txtRenderer.getCurrentChapterIndex() !== targetChapterIndex) {
              await txtRenderer.goToChapter(targetChapterIndex);
            }

            await txtRenderer.renderPage(1, container, options);
            setCurrentPage(chapterInt);
            if (latestPreciseProgressRef) {
              latestPreciseProgressRef.current = chapterInt;
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

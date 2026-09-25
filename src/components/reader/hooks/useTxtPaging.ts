import { useEffect, useRef } from 'react';
import { TxtRenderer } from '../../../services/formats/txt/TxtRenderer';
import { TXT_CHAPTER_OFFSET_MAX, TXT_PROGRESS_MAX_DELTA } from '../../../services/formats/txt/constants';
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
  onAfterRerender?: () => void;
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
  onAfterRerender,
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
  // 分页版本号守卫：检测异步精确分页替换，跳过中间帧的页码计算
  const lastPagesVersionRef = useRef(0);
  // 标记页码变化是否来自滚动，避免页码 effect 反向滚动导致二次跳变
  const fromScrollRef = useRef(false);

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

      // 显式同步渲染模式：模式切换后 _isVerticalMode 可能是旧值，
      // 且同章切模式时 goToChapter early return 不渲染，会导致后续定位误走旧模式分支
      if (typeof txtRenderer.switchMode === 'function') {
        txtRenderer.switchMode(
          readingMode === 'vertical' ? 'vertical' : 'horizontal'
        );
      }
      // 应用当前渲染参数（字号/主题/页距）并使分页失效，
      // 确保后续分页计算与渲染使用最新参数（横向路径必须）
      if (typeof txtRenderer.applyRenderOptions === 'function') {
        txtRenderer.applyRenderOptions(options);
      }

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

      // 注册渲染器程序化翻页回调（TTS 跟读自动翻页、恢复朗读位置等）：
      // 这些路径直接驱动渲染器翻页，不经过 React 页码状态；横向章节模式下
      // 章内翻页不改变 currentPage（currentPage = 章节序号），若不同步进度，
      // 退出阅读后会丢失朗读自动翻页产生的进度（回到朗读开始处）
      txtRenderer.onPageChange = (progress: number) => {
        // goToPage 只在横向路径被调用，此处为防御：纵向模式不处理
        if (readingMode === 'vertical') return;

        const precise =
          isFinite(progress) && progress > 0
            ? progress
            : savedPageAtOpenRef.current ?? 1;
        const pageInt = Math.max(1, Math.floor(precise));

        // 先写 ref 再改 state：
        // 1) 持久化拿到的是精确进度（章节模式下为章节精确进度）
        // 2) 同步 lastPageRef 使页码 effect 直接返回，避免反向重定位重渲染
        //    打断刚由 TTS 应用的高亮定位
        if (latestPreciseProgressRef) {
          latestPreciseProgressRef.current = precise;
        }
        lastPageRef.current = pageInt;
        setCurrentPage(pageInt);

        if (!isExternal && book) {
          bookService.updateBookProgress(book.id, precise).catch(() => { });
        }
      };

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
            const max = total + TXT_PROGRESS_MAX_DELTA;
            if (value > max) value = max;

            if (!isExternal && book && book.status !== 1 && total > 1) {
              const oldTotal = book.total_pages || 1;
              const atLegacyEnd = oldTotal > 1 && raw >= oldTotal - 0.0001;
              if (atLegacyEnd) {
                value = Math.min(value, (total - 1) + TXT_CHAPTER_OFFSET_MAX);
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
          // 显式传入目标模式：模式切换后 _isVerticalMode 可能是旧值，
          // 不传会导致横向被误渲染为整章滚动
          await txtRenderer.goToChapter(
            targetChapterIndex,
            readingMode === 'vertical' ? 'vertical' : 'horizontal'
          );
        }

        await txtRenderer.ensurePagination(container!, options);
        const unifiedTotalPages = txtRenderer.getPageCount();

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
              // 字符偏移精确恢复（替代虚拟页换算，消除窗口映射退化误差）
              await txtRenderer.jumpToCharOffset(
                txtRenderer.getCharOffsetFromProgress(preciseProgress)
              );
            } else {
              txtRenderer.scrollToVirtualPage(preciseProgress, viewportHeight);
            }
          }

          // 内容不足一屏时自动追加下一章，避免无法触发滚动追加
          if (chapterMode && typeof txtRenderer.appendNextChapter === 'function') {
            const maxScroll = container!.scrollHeight - container!.clientHeight;
            if (maxScroll <= 2) {
              try {
                await txtRenderer.appendNextChapter();
              } catch { }
            }
          }

          // 同步滚动基准：上面的定位是程序化定位，不是用户滚动，
          // 否则随后的滚动事件会被误判为「向上滚动」而在用户未到顶部时提前前插上一章
          lastScrollTopRef.current = container!.scrollTop;
        } else {
          if (chapterMode) {
            // 横向章节模式：按章节精确进度定位到章内页，保证与纵向进度一致
            const chapterCount = Math.max(1, txtRenderer.getChapterCount());
            const chapterInt = Math.min(
              Math.max(1, Math.floor(preciseProgress)),
              chapterCount
            );

            // 先更新 ref，避免 setCurrentPage 触发页码变化监听时产生二次渲染
            lastPageRef.current = chapterInt;
            if (latestPreciseProgressRef) {
              latestPreciseProgressRef.current = preciseProgress;
            }

            // 横向：章节精确进度 → 字符偏移 → 页（字符偏移语义，跨章/页数安全）
            await txtRenderer.jumpToCharOffset(
              txtRenderer.getCharOffsetFromProgress(preciseProgress)
            );
            setCurrentPage(chapterInt);
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
        }
        setContentReady(true);
        onAfterRerender?.();
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
      // 来自 scroll handler 的页码更新，不需要反向滚动
      if (fromScrollRef.current) {
        fromScrollRef.current = false;
        // 仍然需要持久化进度
        if (!isExternal && book) {
          bookService
            .updateBookProgress(book.id, latestPreciseProgressRef?.current ?? currentPage)
            .catch(() => { });
        }
        return;
      }

      if (chapterMode) {
        const chapterCount = Math.max(1, renderer.getChapterCount());
        const targetChapterIndex = Math.min(
          Math.max(0, currentPage - 1),
          chapterCount - 1
        );
        // 如果目标章节已经在连续滚动加载的范围内，不需要重新加载
        const minLoadedIndex = typeof renderer.getMinLoadedChapterIndex === 'function'
          ? renderer.getMinLoadedChapterIndex()
          : renderer.getCurrentChapterIndex();
        const maxLoadedIndex = typeof renderer.getMaxLoadedChapterIndex === 'function'
          ? renderer.getMaxLoadedChapterIndex()
          : renderer.getCurrentChapterIndex();
        const isAlreadyLoaded = targetChapterIndex >= minLoadedIndex
          && targetChapterIndex <= maxLoadedIndex;
        if (!isAlreadyLoaded) {
          renderer
            .goToChapter(targetChapterIndex, 'vertical')
            .then(async () => {
              const viewportHeight = container.clientHeight;
              const preciseProgress = latestPreciseProgressRef?.current ?? currentPage;
              // 字符偏移精确定位（替代虚拟页换算）
              if (typeof renderer.jumpToCharOffset === 'function') {
                await renderer.jumpToCharOffset(
                  renderer.getCharOffsetFromProgress(preciseProgress)
                );
              } else {
                const virtualPrecise = renderer.convertChapterPreciseToVirtualPrecise(preciseProgress);
                renderer.scrollToVirtualPage(virtualPrecise, viewportHeight);
              }
              lastScrollTopRef.current = container.scrollTop;
            })
            .catch(() => { });
        }
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
        // 横向章节模式：跨章跳转按精确进度定位章内页
        // （普通跨章 offset=0 → 章首页；章首向前翻页时调用方写入章末进度 → 上一章末页）
        if (typeof renderer.jumpToCharOffset === 'function') {
          const precise = latestPreciseProgressRef?.current ?? currentPage;
          renderer
            .jumpToCharOffset(renderer.getCharOffsetFromProgress(precise))
            .catch(() => { });
        } else if (typeof renderer.goToChapterPageAtProgress === 'function') {
          const precise = latestPreciseProgressRef?.current ?? currentPage;
          renderer.goToChapterPageAtProgress(targetChapterIndex, precise).catch(() => { });
        } else if (typeof renderer.goToChapterPage === 'function') {
          renderer.goToChapterPage(targetChapterIndex, 1).catch(() => { });
        } else {
          renderer.goToChapter(targetChapterIndex, 'horizontal').catch(() => { });
        }
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

        // 章节模式：预追加检测（提前触发，避免触底时阻塞）
        if (chapterMode && !isAutoSwitchingChapterRef.current) {
          const now = Date.now();
          const isScrollingDown = scrollTop > wasScrollTop;
          const isScrollingUp = scrollTop < wasScrollTop;

          // 距离底部不足半屏时预追加下一章
          const nearBottomThreshold = viewportHeight * 0.5;
          const isNearBottom = maxScrollTop > 0 && scrollTop >= maxScrollTop - nearBottomThreshold;
          if (isNearBottom && isScrollingDown) {
            const maxLoadedIndex = typeof renderer.getMaxLoadedChapterIndex === 'function'
              ? renderer.getMaxLoadedChapterIndex()
              : renderer.getCurrentChapterIndex();
            const chapterCount = Math.max(1, renderer.getChapterCount());
            const canGoNext = maxLoadedIndex < chapterCount - 1;

            if (canGoNext && now - lastAutoSwitchTsRef.current > 300) {
              isAutoSwitchingChapterRef.current = true;
              lastAutoSwitchTsRef.current = now;
              void (async () => {
                try {
                  if (typeof renderer.appendNextChapter === 'function') {
                    await renderer.appendNextChapter();
                    // 不再循环追加短章节，下一帧的 scroll 事件会自然再次触发
                  } else {
                    const nextChapterIndex = maxLoadedIndex + 1;
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
                  }
                } finally {
                  isAutoSwitchingChapterRef.current = false;
                }
              })();
            }
          }

          // 提前半屏触发前插（与下方预追加阈值对称）：加载期间用户仍有可滚动余量，
          // 加载完成时上一章已就位，滑到顶部时不需要再补一次滑动
          const nearTopThreshold = viewportHeight * 0.5;
          const isNearTop = scrollTop <= nearTopThreshold;
          if (isNearTop && isScrollingUp) {
            const minLoadedIndex = typeof renderer.getMinLoadedChapterIndex === 'function'
              ? renderer.getMinLoadedChapterIndex()
              : renderer.getCurrentChapterIndex();
            const canGoPrev = minLoadedIndex > 0;

            if (canGoPrev && now - lastAutoSwitchTsRef.current > 300) {
              isAutoSwitchingChapterRef.current = true;
              lastAutoSwitchTsRef.current = now;
              void (async () => {
                try {
                  if (typeof renderer.prependPrevChapter === 'function') {
                    const prepended = await renderer.prependPrevChapter();
                    if (prepended) {
                      lastScrollTopRef.current = container.scrollTop;
                    }
                  } else {
                    const prevChapterIndex = minLoadedIndex - 1;
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
                      latestPreciseProgressRef.current = prevChapterPage + TXT_CHAPTER_OFFSET_MAX;
                    }

                    if (!isExternal && book) {
                      const valueToSave =
                        latestPreciseProgressRef?.current ?? prevChapterPage;
                      lastSavedPreciseRef.current = valueToSave;
                      lastSaveTimeRef.current = Date.now();
                      bookService.updateBookProgress(book.id, valueToSave).catch(() => { });
                    }
                  }
                } finally {
                  isAutoSwitchingChapterRef.current = false;
                }
              })();
            }
          }
        }

        // 分页版本号守卫：精确分页异步替换后跳过本帧页码计算，避免跳变
        const currentPagesVersion = renderer.getPagesVersion();
        if (currentPagesVersion !== lastPagesVersionRef.current) {
          lastPagesVersionRef.current = currentPagesVersion;
          return;
        }

        // 章节追加/前插期间 DOM 和 pageMap 不一致，跳过页码计算
        if (isAutoSwitchingChapterRef.current) {
          return;
        }

        const virtualPrecise = renderer.getVirtualPreciseByScrollTop(scrollTop);
        // 章节模式优先用字符偏移精确进度（视口顶部段落 → 全书字符偏移 → 章节进度），
        // 消除 wrapper 高度比例近似的误差；无段落标注时回退到虚拟页换算
        const charOffset = renderer.getCharOffsetFromViewport();

        if (chapterMode) {
          const now = Date.now();
          const chapterCount = Math.max(1, renderer.getChapterCount());
          const chapterPrecise =
            charOffset !== null
              ? renderer.getProgressFromCharOffset(charOffset)
              : renderer.convertVirtualPreciseToChapterPrecise(virtualPrecise);
          const currentChapterIndex = renderer.getCurrentChapterIndex();
          // 预加载启发式：按章节进度比例（字符偏移精确）判断接近章节边界
          const ratio =
            chapterCount <= 1
              ? 0
              : Math.max(0, Math.min(1, (chapterPrecise - 1) / (chapterCount - 1)));
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

          const chapterPage = Math.floor(chapterPrecise);
          renderer.updatePreciseProgress(chapterPrecise);

          if (chapterPage !== lastPageRef.current) {
            lastPageRef.current = chapterPage;
            fromScrollRef.current = true;
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
            fromScrollRef.current = true;
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
          } else if (Math.abs(progressToSave - lastPrecise) >= 0.02) {
            shouldSave = true;
          } else if (now - lastTime >= 100) {
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
      if (!isExternal && book) {
        let progressToSave =
          latestPreciseProgressRef?.current ?? renderer.getPreciseProgress();
        if (renderer.isVerticalMode()) {
          const viewportHeight = container.clientHeight;
          if (viewportHeight > 0) {
            const chapterModeCurrent = renderer.isChapterMode();
            // 字符偏移精确进度优先（视口顶部段落 → 全书字符偏移 → 章节进度）
            const charOffset = renderer.getCharOffsetFromViewport();
            if (charOffset !== null) {
              progressToSave = chapterModeCurrent
                ? renderer.getProgressFromCharOffset(charOffset)
                : charOffset;
            } else {
              const scrollTop = container.scrollTop;
              const virtualPrecise = renderer.getVirtualPreciseByScrollTop(scrollTop);
              progressToSave = chapterModeCurrent
                ? renderer.convertVirtualPreciseToChapterPrecise(virtualPrecise)
                : virtualPrecise;
            }
            if (latestPreciseProgressRef) {
              latestPreciseProgressRef.current = progressToSave;
            }
            renderer.updatePreciseProgress(progressToSave);
          }
        }
        if (progressToSave && lastSavedPreciseRef.current !== progressToSave) {
          bookService.updateBookProgress(book.id, progressToSave).catch(() => { });
        }
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
      console.log('[useTxtPaging] rerender', {
        fontSize: options?.fontSize,
        theme: options?.theme,
        pageGap: options?.pageGap,
        readingMode,
      });
      try {
        const chapterMode = txtRenderer.isChapterMode();
        // 应用新渲染参数（字号/主题/页距）并失效分页；
        // 同步渲染模式（模式切换时 init 已同步，此处兜底）
        if (typeof txtRenderer.applyRenderOptions === 'function') {
          txtRenderer.applyRenderOptions(options);
        } else {
          txtRenderer.invalidatePagination();
        }
        if (typeof txtRenderer.switchMode === 'function') {
          txtRenderer.switchMode(
            readingMode === 'vertical' ? 'vertical' : 'horizontal'
          );
        }
        if (readingMode === 'vertical') {
          let preciseProgress =
            latestPreciseProgressRef.current ?? savedPageAtOpenRef.current ?? 1;

          if (chapterMode) {
            const chapterCount = Math.max(1, txtRenderer.getChapterCount());
            if (preciseProgress < 1) preciseProgress = 1;
            const max = chapterCount + TXT_PROGRESS_MAX_DELTA;
            if (preciseProgress > max) preciseProgress = max;

            // 不调用 goToChapter，避免清空连续滚动已追加的章节内容
            // renderFullContent 会使用当前 _content（可能包含多章拼接内容）重新渲染
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

            // 字符偏移精确定位（重排后位置保持，替代虚拟页换算）
            await txtRenderer.jumpToCharOffset(
              txtRenderer.getCharOffsetFromProgress(preciseProgress)
            );

            // 同步滚动基准：程序化定位不算用户滚动，避免滚动事件误判方向
            lastScrollTopRef.current = container.scrollTop;
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
            let preciseProgress =
              latestPreciseProgressRef.current ??
              savedPageAtOpenRef.current ??
              (currentPage || 1);
            if (preciseProgress < 1) preciseProgress = 1;
            const max = chapterCount + TXT_PROGRESS_MAX_DELTA;
            if (preciseProgress > max) preciseProgress = max;

            const chapterInt = Math.min(
              Math.max(1, Math.floor(preciseProgress)),
              chapterCount
            );

            // 横向：按精确进度定位章内页（字符偏移语义），字号/主题变化重排后位置保持
            await txtRenderer.jumpToCharOffset(
              txtRenderer.getCharOffsetFromProgress(preciseProgress)
            );
            setCurrentPage(chapterInt);
            if (latestPreciseProgressRef) {
              latestPreciseProgressRef.current = preciseProgress;
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
        onAfterRerender?.();
      } catch (err) {
        // 横向重排链路（applyRenderOptions→jumpToCharOffset→_calculatePages→renderPage）
        // 任一环节抛异常都会导致字号/主题不生效，必须记录日志以便定位
        console.error('[useTxtPaging] rerender failed', err);
      }
    };

    rerender();
  }, [options?.theme, options?.pageGap, options?.fontSize, readingMode, book?.id, isExternal, onAfterRerender]);

  // 清理：书籍切换时重置初始化状态
  useEffect(() => {
    return () => {
      initializedRef.current = false;
      lastSavedPreciseRef.current = null;
      lastSaveTimeRef.current = 0;
    };
  }, [book?.id]);
};

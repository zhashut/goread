import React, { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { TopBar } from "./reader/TopBar";
import { BottomBar } from "./reader/BottomBar";
import { TocOverlay } from "./reader/TocOverlay";
import { ModeOverlay } from "./reader/ModeOverlay";
import { MoreDrawer } from "./reader/MoreDrawer";
import { PageDivider } from "./reader/PageDivider";
import { Toast } from "./Toast";
import { Loading } from "./Loading";
import { ExternalFileOpenPayload } from "../types";
import { IBookRenderer } from "../services/formats";
import { EpubRenderer } from "../services/formats/epub/EpubRenderer";
import { TxtRenderer } from "../services/formats/txt/TxtRenderer";
import { captureBookmarkPosition } from "./reader/utils/bookmarkPosition";
import { parseChapterTitle } from "./reader/utils/chapterTitle";
import { getPlaceholderCanvasSize } from "../utils/canvasPlaceholder";
import { getReaderPageBackground, getReaderPaperShadow } from "../constants/readerTheme";
import { useAppNav } from "../router/useAppNav";


// Hooks
import {
  useReaderState,
  useReaderSettings,
  useReadingSession,
  useToc,
  useBookmarks,
  useBookLoader,
  usePageRenderer,
  useVerticalScroll,
  useNavigation,
  useAutoScroll,
  useDomRenderer,
  useInitReader,
  useResizeHandler,
  useAutoMark,
  useModeSwitch,
  useViewport,
  useExternalVisibility,
  usePageSync,
  useReaderTheme,
  useUndoJump,
  useBookReadingMode,
  useBookPageTurnEffect,
  useTxtPaging,
  useBookFormatHelper,
  useReaderClick,
  usePageTurnGesture,
  usePageTurnSlide,
  usePageTurnCover,
  useBookPageDivider,
  useDividerVisibility,
  useTocSort,
  useContentPinchZoom,
  useReaderTTS,
  useBookFontSize,
  useReaderStatusBar,
  useReaderViewportInset,
} from "./reader/hooks";

import { UndoJumpIcon } from "./covers/UndoJumpIcon";

/** 顶部页码气泡 / 撤回跳转按钮相对顶部安全区的偏移（控制栏自身高度约 72px） */
const READER_CHROME_TOP_OFFSET = 72;


export const Reader: React.FC = () => {
  const { t: tCommon } = useTranslation("common");
  const nav = useAppNav();
  const { bookId } = useParams<{ bookId: string }>();
  const location = useLocation();

  // 初始外部文件状态
  const locState = (location.state || {}) as {
    externalFile?: ExternalFileOpenPayload;
  };
  const externalFile = locState.externalFile;
  const initialIsExternal = !!externalFile;

  // 1. 核心状态
  const readerState = useReaderState({ bookId, initialIsExternal });
  const {
    book,
    setBook,
    loading,
    contentReady,
    currentPage,
    totalPages,
    isExternal,
    externalTitle,
    externalPath,
    isDomRender,
  } = readerState;

  // 5. Refs (需要在 settings 之前定义)
  const rendererRef = useRef<IBookRenderer | null>(null);
  const modeVersionRef = useRef<number>(0);
  const epubRenderedRef = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mainViewRef = useRef<HTMLDivElement>(null);
  // 覆盖翻页克隆层挂载点（T32）：宿主仅作容器，子节点由 usePageTurnCover 命令式增删
  const coverLayerHostRef = useRef<HTMLDivElement>(null);
  const verticalScrollRef = useRef<HTMLDivElement>(null);
  // PDF 纵向模式下真正被缩放的容器（页面内容包裹层）
  const zoomContentRef = useRef<HTMLDivElement>(null);
  const verticalCanvasRefs = useRef<Map<number, HTMLCanvasElement>>(new Map());

  // 2. 设置与会话 (传递 rendererRef 以支持 EPUB 同步)
  const { settings } = useReaderSettings(rendererRef);

  // 书籍级阅读模式管理
  const { readingMode, setReadingMode: setBookReadingMode } = useBookReadingMode({
    book,
    isExternal,
    rendererRef,
  });

  // 书籍级翻页动画效果管理（T33 按书记忆）：slide=平移 / cover=覆盖 / none=无动画，缺省 slide
  const { pageTurnEffect, setPageTurnEffect } = useBookPageTurnEffect({
    book,
    isExternal,
    setBook,
  });

  const {
    effectiveTheme,
    settingsWithTheme,
    isThemeSupported,
    bookThemeForUi,
    handleChangeBookTheme,
  } = useReaderTheme({
    book,
    isExternal,
    externalPath,
    settings,
    setBook,
  });

  const { format, isEpubDom, isMobi, isMarkdown, isHtml, isTxt } =
    useBookFormatHelper(book, isExternal, externalPath || undefined);

  const isPdf = format === "pdf";
  const fontSizeSupported = isEpubDom || isMobi || isTxt;

  const fontSizeData = useBookFontSize({
    book,
    isExternal,
    supported: fontSizeSupported,
    setBook,
  });

  const { markReadingActive } = useReadingSession(book, isExternal);

  // 视口缩放
  useViewport();

  // 外部文件可见性处理
  useExternalVisibility(isExternal);


  // 3. UI 状态
  const [uiVisible, setUiVisible] = useState(false);
  const [tocOverlayOpen, setTocOverlayOpen] = useState(false);
  const [modeOverlayOpen, setModeOverlayOpen] = useState(false);
  const [moreDrawerOpen, setMoreDrawerOpen] = useState(false);
  // Seek State
  const [isSeeking, setIsSeeking] = useState(false);
  const [seekPage, setSeekPage] = useState<number | null>(null);

  // 状态栏控制：仅在阅读页内生效，离开时恢复应用默认
  // 目录/模式/更多这些深色浮层会盖住状态栏区域，此时不需要色条、图标用浅色；
  // 顶部/底部工具栏已改为与页面同色，不再视作深色浮层
  const darkChromeOnStatusBar = tocOverlayOpen || modeOverlayOpen || moreDrawerOpen;
  // 阅读页配色：全屏统一用主题页面底色（正文页、画布四周、让位带都是它），
  // 页面边界靠纸张投影（纸色与底色同色时，投影/描边是唯一的区分手段）
  const pageBackgroundColor = getReaderPageBackground(isThemeSupported ? effectiveTheme : "light");
  const paperShadow = getReaderPaperShadow(effectiveTheme);

  const readerStatusBar = useReaderStatusBar({
    showStatusBar: settings.showStatusBar,
    // 让位带底色 = 页面底色，图标明暗由实际颜色推断
    bandBackgroundColor: pageBackgroundColor,
    darkChromeVisible: darkChromeOnStatusBar,
  });

  // 内容视口的顶部让位：仅由「系统状态栏可见」决定，
  // 否则控制栏显示/隐藏时 padding 变化会让正文上下跳动
  const viewportInset = useReaderViewportInset(settings.showStatusBar);
  // 顶部浮层（页码气泡 / 撤回跳转）只在控制栏可见时渲染，恒定需要避开状态栏
  const chromeInset = useReaderViewportInset(true);

  // 4. 数据 Hooks (TOC, Bookmarks)
  const tocData = useToc(currentPage, readingMode, isDomRender);

  // TTS 听书（依赖 tocData 取当前章节名，用于媒体通知动态文案）
  const {
    listenSupported,
    isListening,
    handleToggleListen,
    stopListenAndRestore,
    listenToastMsg,
    clearListenToast,
    notifyTtsDocumentUpdated,
  } = useReaderTTS({
    rendererRef,
    isEpubDom,
    isMobi,
    isTxt,
    onReadingActivity: !isExternal ? markReadingActive : undefined,
    // 媒体通知标题/副标题/封面（仅 Android 原生通知使用）
    notificationTitle: (isExternal ? externalTitle : book?.title) || undefined,
    notificationSubtitle: parseChapterTitle(tocData.activeNodeSignature) ?? undefined,
    notificationBookId: !isExternal ? book?.id : undefined,
  });

  const bookmarkData = useBookmarks(book, isExternal);
  const { hideDivider, setHideDivider } = useBookPageDivider(book);
  const tocSort = useTocSort(tocData.toc, book);
  const renderOptions = {
    ...settingsWithTheme,
    hideDivider,
    ...(fontSizeSupported ? { fontSize: fontSizeData.fontSize } : {}),
  };

  // 6. 核心逻辑 Hooks
  // 页面渲染器
  const pageRenderer = usePageRenderer({
    rendererRef,
    bookIdRef: readerState.bookIdRef,
    modeVersionRef,
    canvasRef,
    mainViewRef,
    isExternal,
    externalPath,
    book,
    settings: renderOptions,
    readingMode,
    totalPages,
  });

  // 书籍加载器
  useBookLoader(
    { bookId, isExternal, externalFile, readingMode },
    readerState,
    { rendererRef, modeVersionRef, epubRenderedRef },
    tocData,
    bookmarkData,
    { resetCache: pageRenderer.forceClearCache }
  );

  // DOM 渲染器（Markdown 等格式使用，TXT 由 useTxtPaging 单独处理）
  const domRenderer = useDomRenderer({
    readerState,
    refs: { rendererRef },
    actions: {
      markReadingActive,
      setActiveNodeSignature: tocData.setActiveNodeSignature
    },
    data: { readingMode, toc: tocData.toc, activeNodeSignature: tocData.activeNodeSignature, isExternal }
  });

  // TXT 专用分页链路
  useTxtPaging({
    readerState,
    rendererRef,
    domContainerRef: domRenderer.domContainerRef,
    options: renderOptions,
    readingMode,
    setToc: tocData.setToc,
    toc: tocData.toc,
    setActiveNodeSignature: tocData.setActiveNodeSignature,
    onAfterRerender: notifyTtsDocumentUpdated,
    markReadingActive,
  });


  const verticalScroll = useVerticalScroll({
    readerState,
    refs: { verticalCanvasRefs, verticalScrollRef, mainViewRef, renderedPagesRef: pageRenderer.renderedPagesRef },
    actions: {
      renderPageToTarget: pageRenderer.renderPageToTarget,
      setActiveNodeSignature: tocData.setActiveNodeSignature,
      getSmartPredictor: pageRenderer.getSmartPredictor,
      markReadingActive
    },
    data: { readingMode, toc: tocData.toc, isSeeking, setSeekPage, setIsSeeking }
  });

  // 初始化渲染
  useInitReader({
    readerState,
    refs: {
      rendererRef,
      domContainerRef: domRenderer.domContainerRef,
      canvasRef,
      verticalCanvasRefs,
      renderedPagesRef: pageRenderer.renderedPagesRef,
      epubRenderedRef,
      domRestoreDoneRef: domRenderer.domRestoreDoneRef,
    },
    actions: {
      waitForContainer: domRenderer.waitForContainer,
      renderPage: pageRenderer.renderPage,
      renderPageToTarget: pageRenderer.renderPageToTarget,
      setVerticalLazyReady: verticalScroll.setVerticalLazyReady,
      setActiveNodeSignature: tocData.setActiveNodeSignature,
      setToc: tocData.setToc,
      markReadingActive,
      notifyTtsDocumentUpdated,
    },
    data: { readingMode, settings: renderOptions, toc: tocData.toc }
  });

  // 模式切换缓存清理
  useModeSwitch({
    book,
    isExternal,
    totalPages,
    readingMode,
    modeVersionRef,
    renderedPagesRef: pageRenderer.renderedPagesRef,
    renderQueueRef: pageRenderer.renderQueueRef,
    setVerticalLazyReady: verticalScroll.setVerticalLazyReady,
    setContentReady: readerState.setContentReady,
  });

  // 页码同步
  usePageSync(currentPage, readerState.currentPageRef);

  // 分隔线可见性动态更新
  useDividerVisibility({
    rendererRef,
    hideDivider,
    isDomRender,
    loading,
  });

  // 自动标记已读
  useAutoMark({
    book,
    isExternal,
    currentPage,
    totalPages,
    isDomRender,
    contentReady: readerState.contentReady,
    rendererRef,
    setBook: readerState.setBook,
    readingMode,
    latestPreciseProgressRef: readerState.latestPreciseProgressRef,
  });



  // 导航
  const navigation = useNavigation({
    readerState,
    pageRenderer,
    tocData: { toc: tocData.toc, activeNodeSignature: tocData.activeNodeSignature },
    refs: { verticalCanvasRefs, rendererRef },
    data: {
      readingMode,
      isExternal,
      markReadingActive,
    }
  });

  const undoJump = useUndoJump({
    navigator: { goToPage: navigation.goToPage }
  });

  // 自动滚动
  const autoScrollData = useAutoScroll({
    readerState,
    navigation,
    refs: {
      rendererRef,
      verticalScrollRef,
      mainViewRef,
      domContainerRef: domRenderer.domContainerRef
    },
    data: {
      readingMode,
      tocOverlayOpen,
      modeOverlayOpen,
      scrollSpeed: settingsWithTheme.scrollSpeed,
      markReadingActive
    }
  });

  // 窗口调整
  useResizeHandler({
    data: { readingMode, currentPage },
    actions: {
      forceClearCache: pageRenderer.forceClearCache,
      renderPage: pageRenderer.renderPage,
      setVerticalLazyReady: verticalScroll.setVerticalLazyReady,
      renderedPagesRef: pageRenderer.renderedPagesRef
    }
  });

  const getZoomContentElement = useCallback(() => {
    if (readingMode === "horizontal") return canvasRef.current;
    // 纵向模式必须缩放“内容包裹层”：它将内容撑满整篇文档高度，
    // 若直接缩放滚动列，超出滚动列高度的部分会被裁剪，拖动时只能看到黑屏
    return zoomContentRef.current;
  }, [readingMode]);

  /**
   * 缩放平移不会触发原生滚动，IntersectionObserver 也就无法感知进入可视区域的页面，
   * 因此这里在每次变换提交后手动补齐：
   * 只补渲染与视口相交且尚未渲染的页面（不渲染视口上方的页面，避免其尺寸变化导致画面跳动）
   */
  const renderPendingVisiblePagesRef = useRef<() => void>(() => {});
  const handleTransformCommit = useCallback(() => {
    renderPendingVisiblePagesRef.current();
  }, []);

  const zoom = useContentPinchZoom({
    enabled:
      isPdf &&
      !loading &&
      !isSeeking &&
      !tocOverlayOpen &&
      !modeOverlayOpen &&
      !moreDrawerOpen,
    viewportRef: mainViewRef,
    getContentElement: getZoomContentElement,
    minScale: 1,
    maxScale: 4,
    tapMoveThresholdPx: 6,
    onTransformCommit: handleTransformCommit,
  });

  const renderPendingVisiblePages = useCallback(() => {
    if (!isPdf || readingMode !== "vertical") return;
    const viewportEl = mainViewRef.current;
    if (!viewportEl) return;

    const vpRect = viewportEl.getBoundingClientRect();
    const { renderedPagesRef, renderQueueRef, renderPageToTarget } = pageRenderer;
    const pending: Promise<void>[] = [];

    verticalCanvasRefs.current.forEach((canvasEl, pageNum) => {
      if (!canvasEl) return;
      if (renderedPagesRef.current.has(pageNum)) return;
      if (renderQueueRef.current.has(pageNum)) return;

      const rect = canvasEl.getBoundingClientRect();
      // 完全位于视口上方的页面暂不渲染：渲染会改变其高度，导致当前画面位置跳动
      if (rect.bottom <= vpRect.top) return;
      if (rect.top >= vpRect.bottom) return;

      pending.push(renderPageToTarget(pageNum, canvasEl));
    });

    if (pending.length > 0) {
      // 页面渲染完成后高度会变化，需要重新夹取平移量，避免底部露出背景
      Promise.all(pending).then(() => zoom.reclamp()).catch(() => {});
    }
  }, [isPdf, pageRenderer, readingMode, zoom.reclamp]);

  // 通过 ref 转发，避免 zoom 与回调之间的循环依赖
  renderPendingVisiblePagesRef.current = renderPendingVisiblePages;

  useEffect(() => {
    if (tocOverlayOpen || modeOverlayOpen || moreDrawerOpen) {
      zoom.reset();
      // 重新进入菜单后，跳转来源已过期：清除挂起的「撤回跳转」，
      // 避免关闭菜单后悬浮条再次出现（打开菜单仅视觉隐藏、状态仍 active 的旧行为）
      undoJump.clearUndo();
    }
  }, [moreDrawerOpen, modeOverlayOpen, tocOverlayOpen, zoom.reset, undoJump.clearUndo]);

  useEffect(() => {
    zoom.reset();
  }, [bookId, isDomRender, readingMode, isPdf, zoom.reset]);

  // 翻页边界判定（T31/T32 引擎共用）：
  // TXT 横向章节模式下 currentPage/totalPages 是「章级」序号，用它判页级边界会把
  // 末章内所有栏误判为书末（拖拽/点击/键盘下一页永远回弹）、首章内所有栏误判为书首；
  // 改为查询渲染器的章内真实边界。其余格式 currentPage 为页级，维持原判定。
  // 注意语义差异：hasNextPageInChapter 是「章内」边界，章末返回 false 是正常语义，
  // 但引擎把 canTurn=false 理解为「书末」直接回弹——因此这里必须补上「还有相邻章节」
  // 的判定，章末（非末章）放行交给 commitTurn：navigation.nextPage 里
  // goToNextPageInChapter 返回 false 后自然走 goToPage 跨章（prev 对称走上一章末页）
  const canTurnPage = (direction: "next" | "prev"): boolean => {
    const renderer = rendererRef.current;
    if (
      readingMode === "horizontal" &&
      renderer instanceof TxtRenderer &&
      renderer.isChapterMode?.()
    ) {
      return direction === "next"
        ? renderer.hasNextPageInChapter() ||
            renderer.getCurrentChapterIndex() < renderer.getChapterCount() - 1
        : renderer.hasPrevPageInChapter() ||
            renderer.getCurrentChapterIndex() > 0;
    }
    return direction === "next"
      ? currentPage < totalPages - 0.0001
      : currentPage > 1.0001;
  };

  // 平移翻页动画控制器（T31 slide 效果）：
  // 承接手势层拖拽事件流做跟手/settle 补间/回弹，并为分区点击/键盘翻页提供补间动画路径；
  // EPUB 多栏走容器平移（补间到 ∓视口宽后提交翻页并归零，视觉无跳变），
  // PDF/TXT 单页模型走「滑出露底色 → 瞬切 → 对侧滑入」两段式近似
  const pageTurnSlide = usePageTurnSlide({
    enabled: readingMode === "horizontal",
    // transform 宿主：PDF 横向为画布（其 JSX style 不含 transform，无缩放冲突），
    // 其余横向格式为 DOM 渲染容器（EPUB 多栏滚动容器 / TXT 单页均在其内）
    getHostElement: () =>
      readingMode === "horizontal" && !isDomRender
        ? canvasRef.current
        : domRenderer.domContainerRef.current,
    getViewportWidth: () => mainViewRef.current?.clientWidth || window.innerWidth,
    // EPUB 为多栏连续内容（CSS 多栏 + scrollLeft），其余格式按单页重渲染模型处理
    isSinglePage: () => !isEpubDom,
    canTurn: canTurnPage,
    commitTurn: (direction) => {
      if (direction === "next") navigation.nextPage();
      else navigation.prevPage();
    },
  });

  // 统一翻页手势层（T30）：触摸拖拽事件流 + settle 判定 + 键盘导航；
  // T31/T32 起 settle 翻页/回弹的视觉动作由活跃翻页动画引擎承接（默认 cover，可切回 slide）
  // 覆盖翻页动画控制器（T32）：层叠视口克隆方案，接口与 pageTurnSlide 对齐。
  // 克隆覆盖上下文：仅 EPUB 多栏章内翻页可克隆（相邻栏内容真实存在同章 DOM 中）；
  // 跨章边界返回 null 退化为两段式（先 settle 滑出再切章，防克隆破相）；
  // PDF/TXT 单页模型天然无相邻页内容，直接走两段式位图滑动
  const pageTurnCover = usePageTurnCover({
    enabled: readingMode === "horizontal",
    // 两段式降级路径的 transform 宿主：与 slide 同源
    getHostElement: () =>
      readingMode === "horizontal" && !isDomRender
        ? canvasRef.current
        : domRenderer.domContainerRef.current,
    getViewportWidth: () => mainViewRef.current?.clientWidth || window.innerWidth,
    getOverlayRoot: () => coverLayerHostRef.current,
    getCloneContext: (direction) => {
      if (!isEpubDom) return null;
      const container = domRenderer.domContainerRef.current;
      if (!container || container.clientWidth <= 0) return null;
      const step = container.clientWidth;
      const left = container.scrollLeft;
      const maxIndex = Math.ceil((container.scrollWidth - container.clientWidth) / step);
      const idx = Math.round(left / step);
      // 书首无上一栏 / 章尾无下一栏：克隆取不到相邻内容，退化为两段式
      if (direction === "next") {
        if (idx + 1 >= maxIndex) return null;
        return {
          source: container,
          topScrollLeft: left + step,
          underScrollLeft: null,
          background: pageBackgroundColor,
        };
      }
      if (idx - 1 < 0) return null;
      // prev：顶层为当前栏快照（滑出层），底层为上一栏快照（被露出的目标页）
      return {
        source: container,
        topScrollLeft: left,
        underScrollLeft: left - step,
        background: pageBackgroundColor,
      };
    },
    canTurn: canTurnPage,
    commitTurn: (direction) => {
      if (direction === "next") navigation.nextPage();
      else navigation.prevPage();
    },
  });

  // T33 翻页效果三选一驱动：slide/cover 走对应动画引擎，none=瞬时翻页（现状行为显式化，无动画无锁定）
  const usePageTurnEngine = pageTurnEffect !== "none";
  const activePageTurn = pageTurnEffect === "cover" ? pageTurnCover : pageTurnSlide;

  const pageTurnGesture = usePageTurnGesture({
    viewportRef: mainViewRef,
    // 缩放态（PDF）禁用翻页手势：单指拖动让位给 zoom 平移，与点击翻页的禁用策略一致
    enabled:
      readingMode === "horizontal" && !loading && !(isPdf && zoom.isZoomed),
    isBlocked: () =>
      tocOverlayOpen ||
      modeOverlayOpen ||
      moreDrawerOpen ||
      isSeeking ||
      !contentReady,
    getSelectionHost: () => mainViewRef.current,
    getViewportWidth: () => mainViewRef.current?.clientWidth || window.innerWidth,
    // 键盘与 settle 翻页统一走活跃动画引擎路径（动画中自动跳帧合并）；
    // none 效果无动画：settle 通过后直接瞬时翻页；
    // settle 通过时手势层先调本回调（跟手态被引擎忽略），随后 onDragEnd 驱动补间
    onTurnPrev: () => {
      if (isPdf && zoom.isZoomed) return;
      if (!usePageTurnEngine) {
        navigation.prevPage();
        return;
      }
      activePageTurn.turn("prev");
    },
    onTurnNext: () => {
      if (isPdf && zoom.isZoomed) return;
      if (!usePageTurnEngine) {
        navigation.nextPage();
        return;
      }
      activePageTurn.turn("next");
    },
    // 鼠标拖拽仅在不可选文本的渲染面启用（PDF 横向画布），缩放态让位给平移手势
    enableMouseDrag: isPdf && readingMode === "horizontal" && !zoom.isZoomed,
    // T31：拖拽事件流接入动画控制器（跟手 transform / settle 补间 / 回弹）；
    // none 效果无动画：拖拽事件流不接引擎（isLocked 恒 false，settle 翻页由 onTurnPrev/Next 直通）
    isLocked: () => (usePageTurnEngine ? activePageTurn.isLocked() : false),
    onDragStart: (direction) => {
      if (usePageTurnEngine) activePageTurn.dragStart(direction);
    },
    onDragMove: (deltaX) => {
      if (usePageTurnEngine) activePageTurn.dragMove(deltaX);
    },
    onDragEnd: (result) => {
      if (usePageTurnEngine) activePageTurn.dragEnd(result);
    },
  });

  // EPUB 横向：由统一手势层接管触摸拖拽后，禁用渲染层内部触摸翻页流，避免双重翻页；
  // 渲染器实例随书籍加载重建（loading 变化）或模式切换，均需同步接管标志
  useEffect(() => {
    const renderer = rendererRef.current;
    if (renderer instanceof EpubRenderer) {
      renderer.setTouchGestureTakeover(readingMode === "horizontal");
    }
  }, [readingMode, bookId, loading, isExternal, isDomRender]);

  const { handleMainViewClick } = useReaderClick({
    readingMode,
    clickTurnPage: settings.clickTurnPage && !(isPdf && zoom.isZoomed),
    // T31/T32：分区点击翻页走活跃动画引擎路径（动画中自动跳帧合并）；none 效果直通瞬时翻页
    onPrevPage: () => {
      if (isPdf && zoom.isZoomed) return;
      if (!usePageTurnEngine) {
        navigation.prevPage();
        return;
      }
      activePageTurn.turn("prev");
    },
    onNextPage: () => {
      if (isPdf && zoom.isZoomed) return;
      if (!usePageTurnEngine) {
        navigation.nextPage();
        return;
      }
      activePageTurn.turn("next");
    },
    autoScroll: autoScrollData.autoScroll,
    setAutoScroll: autoScrollData.setAutoScroll,
    toggleUi: () => {
      if (isPdf && zoom.shouldSuppressClick()) return;
      setUiVisible((v) => !v);
    },
    // T30：拖拽手势后点击抑制 + 选中文本态点击消解（点击仅取消选择，不翻页）
    shouldSuppressClick: pageTurnGesture.shouldSuppressClick,
    getSelectionHost: () => mainViewRef.current,
  });

  const showContentLoadingOverlay =
    isEpubDom && !contentReady && !loading;

  // 加载状态
  if (loading) {
    return (
      <Loading
        visible
        overlay={false}
        text={tCommon('loading')}
        showSpinner={false}
        className="reader-fullheight"
        textStyle={{ fontSize: 16 }}
      />
    );
  }



  return (
    <div
      className="reader-fullheight reader-viewport"
      style={{
        display: "flex",
        position: "relative",
        flexDirection: "column",
        // 根容器底色 = 页面底色：状态栏/挖孔让位带（视口 padding 区，含横屏左右）与正文页同色
        backgroundColor: pageBackgroundColor,
        // 顶部状态栏让位：高度以 CSS 变量交给 .reader-viewport 的 padding-top 处理，
        // 组件不再手写 padding（盒模型约束集中在 CSS 里声明）
        ...viewportInset.viewportStyle,
      }}
    >
      {/* 状态栏区域色条：与根容器同色，仅用于压住首页 boxShadow 向上溢出的阴影 */}
      {readerStatusBar.showStatusBarStrip && (
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: viewportInset.topInset,
            backgroundColor: pageBackgroundColor,
            // 置于内容之上，避免首页 boxShadow 溢出到色条上
            zIndex: 1,
            pointerEvents: "none",
          }}
        />
      )}
      {/* 主体区域 */}
      <div
        style={{
          flex: 1,
          display: "flex",
          overflow: "hidden",
        }}
      >
        <div
          onClick={handleMainViewClick}
          {...(isPdf ? zoom.bind : {})}
          className="no-scrollbar"
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            overflow: (isPdf && zoom.isZoomed) || tocOverlayOpen || modeOverlayOpen || (isEpubDom && readingMode === "horizontal") ? "hidden" : "auto",
            padding: 0,
            position: "relative",
            // 画布四周/页间空隙与正文页同色（全屏统一底色），页边界由纸张投影保证
            backgroundColor: pageBackgroundColor,
          }}
          ref={mainViewRef}
        >
          {/* DOM 渲染模式（Markdown、EPUB 等格式） */}
          {isDomRender ? (
            <div
              ref={domRenderer.domContainerRef}
              className="no-scrollbar"
              style={{
                ...(
                  isEpubDom
                    ? {
                        position: "absolute" as const,
                        top: 0,
                        left: 0,
                        right: 0,
                        bottom: 0,
                      }
                    : {
                        width: "100%",
                        height: "100%",
                      }
                ),
                overflowY: (isEpubDom || isTxt) && readingMode === "horizontal" ? "hidden" : "auto",
                touchAction: (isEpubDom || isTxt) && readingMode === "horizontal" ? "pan-y" : "auto",
                // TXT 保持透明（内容自带底色）；其余 DOM 格式用页面底色，
                // 与 Shadow DOM 内的内容底色及让位带保持一致（避免深色/护眼主题下出现色差）
                backgroundColor: isTxt ? "transparent" : pageBackgroundColor,
                pointerEvents: "auto",
              }}
            />
          ) : readingMode === "horizontal" ? (
            <canvas
              ref={canvasRef}
              width={800}
              height={1000}
              style={{
                width: "100%",
                height: "auto",
                boxShadow: paperShadow,
                // 画布即“纸”：底色用纸色，翻页重建画布时不会闪出台面色
                backgroundColor: pageBackgroundColor,
                ...(isPdf ? zoom.contentStyle : {}),
              }}
            />
          ) : (
            <div
              style={{
                width: "100%",
                maxHeight: "100%",
                overflowY: isPdf && zoom.isZoomed ? "hidden" : "auto",
                // 缩放时禁用原生滚动，统一由 transform 平移处理
                touchAction: isPdf ? (zoom.isZoomed ? "none" : "pan-y") : undefined,
              }}
              className="no-scrollbar"
              ref={verticalScrollRef}
            >
              {/* 缩放作用在内容包裹层上，保证拖动时展示的是真实内容而不是被裁剪的滚动列 */}
              <div ref={zoomContentRef} style={isPdf ? zoom.contentStyle : undefined}>
                {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => {
                  const pageGap = settingsWithTheme.pageGap ?? 4;
                  const dividerBandHeight = pageGap * 2 + 1;
                  return (
                    <React.Fragment key={`${bookId}-${p}`}>
                      {p > 1 && (
                        <PageDivider
                          height={dividerBandHeight}
                          color={effectiveTheme === "dark" ? "#ffffff" : "#000000"}
                          hidden={hideDivider}
                        />
                      )}
                      <canvas
                        data-page={p}
                        ref={(el) => {
                          if (!el) return;
                          verticalCanvasRefs.current.set(p, el);
                          // 仅在占位阶段设置初始尺寸：
                          // 设置 canvas 的 width/height 属性会清空画面，已渲染的页面不能再动
                          if (el.dataset.placeholder === "0") return;
                          el.dataset.placeholder = "0";
                          const size = getPlaceholderCanvasSize(
                            rendererRef.current?.getPageSize?.(p)
                          );
                          el.width = size.width;
                          el.height = size.height;
                        }}
                        style={{
                          width: "100%",
                          minHeight: "600px",
                          display: "block",
                          margin: "0 auto",
                          boxShadow: paperShadow,
                          // 尚未渲染的页也用纸色占位，避免深灰占位块闪烁
                          backgroundColor: pageBackgroundColor,
                        }}
                      />
                    </React.Fragment>
                  );
                })}
              </div>
            </div>
          )}

          {/* T32 覆盖翻页克隆层挂载点：宿主仅作容器（React 不管理其子节点），
              子层由 usePageTurnCover 命令式增删；pointer-events 关闭保证不拦截交互 */}
          <div
            ref={coverLayerHostRef}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              overflow: "hidden",
              pointerEvents: "none",
              zIndex: 30,
            }}
          />
        </div>
      </div>

      {showContentLoadingOverlay && (
        <Loading
          visible
          text={tCommon('loading')}
          showSpinner={false}
          textStyle={{ fontSize: 16 }}
          overlayColor={pageBackgroundColor}
          zIndex={999}
          overlayStyle={{ position: 'absolute', inset: 0 }}
        />
      )}

      <TopBar
        visible={(uiVisible || isSeeking) && !moreDrawerOpen && !tocOverlayOpen && !modeOverlayOpen}
        theme={effectiveTheme}
        bookTitle={isExternal ? externalTitle : book?.title}
        isFinished={isExternal ? undefined : book?.status === 1}
        onToggleFinish={isExternal ? undefined : navigation.toggleFinish}
        onBack={() => {
          if (isExternal) {
            nav.toBookshelf('recent', { replace: true, resetStack: true });
          } else {
            if (window.history.length > 1) {
              nav.goBack();
            } else {
              nav.toBookshelf('recent', { replace: true });
            }
          }
        }}
      />

      {/* 顶部页码气泡：仅控制栏可见时渲染，故恒定让位顶部安全区 */}
      {(uiVisible || isSeeking) && !moreDrawerOpen && !tocOverlayOpen && !modeOverlayOpen && (
        <div
          style={{
            position: "fixed",
            top: chromeInset.topOffset(READER_CHROME_TOP_OFFSET),
            // 左右避让物理遮挡：Android 上 env() 不可靠，统一用原生注入的安全区变量
            left: "calc(var(--display-cutout-inset-left, 0px) + 12px)",
            display: "block",
            pointerEvents: "none",
            zIndex: 11,
          }}
        >
          <div
            style={{
              padding: "6px 12px",
              borderRadius: "18px",
              backgroundColor: "rgba(0,0,0,0.75)",
              color: "#fff",
              fontSize: "12px",
              boxShadow: "0 2px 6px rgba(0,0,0,0.25)",
            }}
          >
            {Math.floor(isSeeking && seekPage !== null ? seekPage : currentPage)} / {totalPages}
          </div>
        </div>
      )}

      {/* 撤回跳转按钮：同样只在控制栏可见时渲染 */}
      {(uiVisible || isSeeking) && !moreDrawerOpen && !tocOverlayOpen && !modeOverlayOpen && undoJump.undoJumpState?.active &&
        <div
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            undoJump.performUndo();
          }}
          style={{
            position: "fixed",
            top: chromeInset.topOffset(READER_CHROME_TOP_OFFSET),
            right: "calc(var(--display-cutout-inset-right, 0px) + 12px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "6px",
            zIndex: 11,
            padding: "0 14px",
            height: "32px",
            borderRadius: "16px",
            backgroundColor: "rgba(40, 40, 40, 0.9)",
            color: "rgba(255, 255, 255, 0.95)",
            fontSize: "12px",
            boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
            backdropFilter: "blur(4px)",
            cursor: "pointer",
            userSelect: "none",
            // 简单进入动画
            animation: "fadeSlideIn 0.35s cubic-bezier(0.34, 1.56, 0.64, 1)",
          }}
        >
          <UndoJumpIcon size={14} />
          <span>撤回跳转</span>
          <style>{`
            @keyframes fadeSlideIn {
              from { opacity: 0; transform: translateX(15px); }
              to { opacity: 1; transform: translateX(0); }
            }
          `}</style>
        </div>
      }

      <TocOverlay
        visible={tocOverlayOpen}
        toc={tocData.toc}
        sortedToc={tocSort.sortedToc}
        bookmarks={isExternal ? [] : bookmarkData.bookmarks}
        activeSignature={tocData.activeNodeSignature}
        sortMode={tocSort.sortMode}
        isReversed={tocSort.isReversed}
        onClose={() => {
          setTocOverlayOpen(false);
          setUiVisible(false);
        }}
        onGoToPage={(page, anchor) => {
          const isEpub = isEpubDom;
          
          // 所有格式都尝试获取精确进度，用于撤回跳转功能
          let fromProgress = currentPage;
          if (rendererRef.current) {
            const renderer = rendererRef.current as any;
            if (typeof renderer.getPreciseProgress === 'function') {
              fromProgress = renderer.getPreciseProgress() ?? currentPage;
            }
          }
          
          // 计算目标位置：优先使用 page 参数，否则使用当前页（anchor 跳转后会自动更新）
          const targetPage = typeof page === 'number' ? page : currentPage;
          
          if (anchor && isDomRender && rendererRef.current) {
            // 锚点跳转强制记录撤回状态（即使页码相同，滚动位置也会改变）
            undoJump.handleJump(fromProgress, targetPage, true);
            if (isEpub) {
              if (isEpubDom && readingMode === 'vertical' && !loading) {
                readerState.setContentReady(false);
              }
              (rendererRef.current as any).goToHref?.(anchor);
            } else {
              (rendererRef.current as any).scrollToAnchor?.(anchor);
            }
          } else if (typeof page === 'number') {
            undoJump.handleJump(fromProgress, page);
            navigation.goToPage(page);
          }
          setTocOverlayOpen(false);
          setUiVisible(false);
        }}
        onDeleteBookmark={isExternal ? () => Promise.resolve(false) : bookmarkData.deleteBookmark}
        setToc={tocData.setToc}
        onSortModeChange={tocSort.setSortMode}
        onToggleReverse={tocSort.toggleReverse}
      />

      <ModeOverlay
        visible={modeOverlayOpen}
        readingMode={readingMode}
        horizontalDisabled={isMobi || isMarkdown || isHtml}
        onClose={() => {
          setModeOverlayOpen(false);
          setUiVisible(false);
        }}
        onChangeMode={async (mode) => {
          if (mode === readingMode) {
            setModeOverlayOpen(false);
            setUiVisible(false);
            return;
          }

          if (listenSupported) {
            // 朗读中切换模式：先把朗读位置写回阅读器，再停止，保证进度连续
            await stopListenAndRestore();
          }

          // 更新书籍级阅读模式配置
          await setBookReadingMode(mode);
          // 同步更新本地 book 状态以触发 UI 更新
          if (!isExternal && book) {
            setBook({ ...book, reading_mode: mode });
          }
          setModeOverlayOpen(false);
          setUiVisible(false);
        }}
      />

      <BottomBar
        visible={(uiVisible || isSeeking) && !tocOverlayOpen && !modeOverlayOpen && !moreDrawerOpen}
        currentPage={currentPage}
        totalPages={totalPages}
        isSeeking={isSeeking}
        seekPage={seekPage}
        readingMode={readingMode}
        autoScroll={autoScrollData.autoScroll}
        tocOverlayOpen={tocOverlayOpen}
        modeOverlayOpen={modeOverlayOpen}
        moreDrawerOpen={moreDrawerOpen}
        theme={effectiveTheme}
        themeSupported={!isExternal && typeof bookThemeForUi !== "undefined" && isThemeSupported}
        onToggleTheme={() => {
          if (isExternal) return;
          const nextTheme: "light" | "dark" = effectiveTheme === "dark" ? "light" : "dark";
          handleChangeBookTheme(nextTheme);
        }}
        listenSupported={listenSupported}
        isListening={isListening}
        onToggleListen={handleToggleListen}
        fontSizeSupported={fontSizeSupported}
        fontSize={fontSizeData.fontSize}
        onIncreaseFontSize={fontSizeData.increase}
        onDecreaseFontSize={fontSizeData.decrease}
        onSetFontSizeByRatio={fontSizeData.setByRatio}
        onSeekStart={() => {
          setIsSeeking(true);
          verticalScroll.lastSeekTsRef.current = Date.now();
        }}
        onSeekChange={(v) => {
          setSeekPage(v);
          verticalScroll.lastSeekTsRef.current = Date.now();
        }}
        onSeekEnd={async (v) => {
          // 所有格式统一获取精确进度，用于撤回跳转功能
          let fromProgress = currentPage;
          if (rendererRef.current) {
            const renderer = rendererRef.current as any;
            if (typeof renderer.getPreciseProgress === 'function') {
              fromProgress = renderer.getPreciseProgress() ?? currentPage;
            }
          }
          undoJump.handleJump(fromProgress, v);
          setSeekPage(null);
          setIsSeeking(false);
          verticalScroll.lastSeekTsRef.current = 0;
          await navigation.goToPage(v);
        }}
        onPrevChapter={navigation.prevChapter}
        onNextChapter={navigation.nextChapter}
        onToggleToc={() => setTocOverlayOpen(true)}
        onToggleMode={() => setModeOverlayOpen(true)}
        onToggleAutoScroll={() => {
          if (!autoScrollData.autoScroll) {
            autoScrollData.setAutoScroll(true);
            setUiVisible(false);
          } else {
            autoScrollData.setAutoScroll(false);
          }
        }}
        onAddBookmark={isExternal ? () => { } : async () => {
          const position = captureBookmarkPosition(rendererRef.current, currentPage);
          const chapterTitle = parseChapterTitle(tocData.activeNodeSignature);
          await bookmarkData.addBookmark(
            position.pageNumber,
            chapterTitle ?? undefined,
            position.preciseProgress
          );
          setUiVisible(false);
        }}
        onOpenMore={() => setMoreDrawerOpen(true)}
      />

      <MoreDrawer
        visible={moreDrawerOpen}
        onClose={() => {
          setMoreDrawerOpen(false);
          setUiVisible(false);
        }}
        onSettings={() => {
          setMoreDrawerOpen(false);
          nav.toSettings();
        }}
        hideDivider={hideDivider}
        onToggleHideDivider={() => setHideDivider(!hideDivider)}
        readingMode={readingMode}
        pageTurnEffect={pageTurnEffect}
        onSetPageTurnEffect={setPageTurnEffect}
        theme={effectiveTheme}
        onChangeTheme={handleChangeBookTheme}
      />

      {/* 全局 Toast 提示 */}
      {bookmarkData.bookmarkToastVisible && (
        <Toast
          message={bookmarkData.bookmarkToastText}
          onClose={() => bookmarkData.setBookmarkToastVisible(false)}
        />
      )}
      {/* 听书状态切换提示 */}
      {listenToastMsg && (
        <Toast
          message={listenToastMsg}
          duration={1000}
          onClose={clearListenToast}
          style={{ top: '50%', bottom: 'auto', transform: 'translate(-50%, -50%)' }}
        />
      )}

      {fontSizeData.toastMsg && (
        <Toast
          message={fontSizeData.toastMsg}
          duration={1000}
          onClose={fontSizeData.clearToast}
          style={{ top: '50%', bottom: 'auto', transform: 'translate(-50%, -50%)' }}
        />
      )}
    </div>
  );
};

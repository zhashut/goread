import React, { useRef, useState } from "react";
import { useParams, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { TopBar } from "./reader/TopBar";
import { BottomBar } from "./reader/BottomBar";
import { TocOverlay } from "./reader/TocOverlay";
import { ModeOverlay } from "./reader/ModeOverlay";
import { MoreDrawer } from "./reader/MoreDrawer";
import { PageDivider } from "./reader/PageDivider";
import { CropOverlay } from "./reader/CropOverlay";
import { Toast } from "./Toast";
import { Loading } from "./Loading";
import { ExternalFileOpenPayload } from "../types";
import { IBookRenderer, getBookFormat } from "../services/formats";
import {
  TOAST_DURATION_LONG_MS,
  TOAST_DURATION_ERROR_MS,
} from "../constants/config";
import { getSafeAreaInsets } from "../utils/layout";
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
  useVolumeNavigation,
  useDomRenderer,
  useInitReader,
  useCapture,
  useResizeHandler,
  useAutoMark,
  useModeSwitch,
  useViewport,
  useExternalVisibility,
  usePageSync,
  useReaderTheme,
  useUndoJump,
  useBookReadingMode,
  useTxtPaging,
  useBookFormatHelper,
  useReaderClick,
  useBookPageDivider,
  useDividerVisibility,
} from "./reader/hooks";

import { UndoJumpIcon } from "./covers/UndoJumpIcon";


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
  const verticalScrollRef = useRef<HTMLDivElement>(null);
  const verticalCanvasRefs = useRef<Map<number, HTMLCanvasElement>>(new Map());

  // 2. 设置与会话 (传递 rendererRef 以支持 EPUB 同步)
  const { settings } = useReaderSettings(rendererRef);

  // 书籍级阅读模式管理
  const { readingMode, setReadingMode: setBookReadingMode } = useBookReadingMode({
    book,
    isExternal,
    rendererRef,
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

  const { isEpubDom, isMobi, isMarkdown, isHtml, isTxt } =
    useBookFormatHelper(book, isExternal, externalPath || undefined);

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

  // 4. 数据 Hooks (TOC, Bookmarks)
  const tocData = useToc(currentPage, readingMode, isDomRender);
  const bookmarkData = useBookmarks(book, isExternal);
  const { hideDivider, setHideDivider } = useBookPageDivider(book);

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
    settings: { ...settingsWithTheme, hideDivider },
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
    options: { ...settingsWithTheme, hideDivider },
    readingMode,
    setToc: tocData.setToc,
    toc: tocData.toc,
    setActiveNodeSignature: tocData.setActiveNodeSignature,
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
      markReadingActive
    },
    data: { readingMode, settings: { ...settingsWithTheme, hideDivider }, toc: tocData.toc }
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
    tocData,
    refs: { verticalCanvasRefs, rendererRef },
    data: { readingMode, isExternal, markReadingActive }
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

  // 音量键翻页
  useVolumeNavigation(!!settingsWithTheme.volumeKeyTurnPage, {
    nextPage: navigation.nextPage,
    prevPage: navigation.prevPage
  });

  // 截图
  const capture = useCapture({
    readerState,
    refs: {
      dataset: {
        domContainerRef: domRenderer.domContainerRef,
        canvasRef,
        verticalScrollRef,
        verticalCanvasRefs
      }
    },
    data: { readingMode, settings: settingsWithTheme },
    actions: {
      setUiVisible,
      setMoreDrawerOpen,
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

  const { handleMainViewClick } = useReaderClick({
    readingMode,
    clickTurnPage: settings.clickTurnPage,
    onPrevPage: navigation.prevPage,
    onNextPage: navigation.nextPage,
    autoScroll: autoScrollData.autoScroll,
    setAutoScroll: autoScrollData.setAutoScroll,
    toggleUi: () => setUiVisible((v) => !v),
  });

  const showModeSwitchLoading =
    isEpubDom && readingMode === "horizontal" && !contentReady && !loading;

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
      className="reader-fullheight"
      style={{
        display: "flex",
        position: "relative",
        flexDirection: "column",
        backgroundColor: effectiveTheme === 'dark' ? "#000000" : "#2c2c2c",
        paddingTop: settingsWithTheme.showStatusBar ? getSafeAreaInsets().top : 0,
      }}
    >
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
          className="no-scrollbar"
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            overflow: tocOverlayOpen || modeOverlayOpen ? "hidden" : "auto",
            padding: 0,
            position: "relative",
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
                overflowY: isEpubDom && readingMode === "horizontal" ? "hidden" : "auto",
                backgroundColor: isEpubDom
                  ? effectiveTheme === "dark"
                    ? "#000000"
                    : "#ffffff"
                  : effectiveTheme === "dark"
                  ? "#000000"
                  : "#1a1a1a",
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
                boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
                backgroundColor: loading ? (effectiveTheme === 'dark' ? "#000000" : "#2a2a2a") : "transparent",
              }}
            />
          ) : (
            <div
              style={{ width: "100%", maxHeight: "100%", overflowY: "auto" }}
              className="no-scrollbar"
              ref={verticalScrollRef}
            >
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
                        if (el) {
                          verticalCanvasRefs.current.set(p, el);
                          if (el.height === 0) {
                            el.height = 800;
                          }
                        }
                      }}
                      style={{
                        width: "100%",
                        minHeight: "600px",
                        display: "block",
                        margin: "0 auto",
                        boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
                        backgroundColor: effectiveTheme === 'dark' ? "#000000" : "#2a2a2a",
                      }}
                    />
                  </React.Fragment>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {showModeSwitchLoading && (
        <Loading
          visible
          text={tCommon('loading')}
          showSpinner={false}
          textStyle={{ fontSize: 16 }}
          overlayColor={effectiveTheme === 'dark' ? "#000000" : "#ffffff"}
          zIndex={999}
          overlayStyle={{ position: 'absolute', inset: 0 }}
        />
      )}

      <TopBar
        visible={(uiVisible || isSeeking) && !moreDrawerOpen && !tocOverlayOpen && !modeOverlayOpen}
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

      {/* 顶部页码气泡 */}
      {(uiVisible || isSeeking) && !moreDrawerOpen && !tocOverlayOpen && !modeOverlayOpen &&
        (() => {
          const toolbarVisible = uiVisible || isSeeking;
          const baseOffsetPx = toolbarVisible ? 72 : 14;
          const safeAreaTop = getSafeAreaInsets().top;
          const shouldIncludeSafeArea = toolbarVisible || settings.showStatusBar;
          const topStyle = shouldIncludeSafeArea
            ? `calc(${safeAreaTop} + ${baseOffsetPx}px)`
            : `${baseOffsetPx}px`;
          return (
            <div
              style={{
                position: "fixed",
                top: topStyle,
                left: "calc(env(safe-area-inset-left) + 12px)",
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
          );
        })()}

      {/* 撤回跳转按钮 */}
      {(uiVisible || isSeeking) && !moreDrawerOpen && !tocOverlayOpen && !modeOverlayOpen && undoJump.undoJumpState?.active &&
        (() => {
          const toolbarVisible = uiVisible || isSeeking;
          const baseOffsetPx = toolbarVisible ? 72 : 14;
          const safeAreaTop = getSafeAreaInsets().top;
          const shouldIncludeSafeArea = toolbarVisible || settings.showStatusBar;
          const topStyle = shouldIncludeSafeArea
            ? `calc(${safeAreaTop} + ${baseOffsetPx}px)`
            : `${baseOffsetPx}px`;

          return (
            <div
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                undoJump.performUndo();
              }}
              style={{
                position: "fixed",
                top: topStyle,
                right: "calc(env(safe-area-inset-right) + 12px)",
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
          );
        })()}

      <TocOverlay
        visible={tocOverlayOpen}
        toc={tocData.toc}
        bookmarks={isExternal ? [] : bookmarkData.bookmarks}
        activeSignature={tocData.activeNodeSignature}
        onClose={() => {
          setTocOverlayOpen(false);
          setUiVisible(false);
        }}
        onGoToPage={(page, anchor) => {
          const isEpub = book?.file_path && getBookFormat(book.file_path) === 'epub';
          
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
      />

      <ModeOverlay
        visible={modeOverlayOpen}
        readingMode={readingMode}
        horizontalDisabled={isMobi || isMarkdown || isHtml || isTxt}
        onClose={() => {
          setModeOverlayOpen(false);
          setUiVisible(false);
        }}
        onChangeMode={async (mode) => {
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
          await bookmarkData.addBookmark(currentPage);
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
        onCapture={capture.handleCapture}
        onSettings={() => {
          setMoreDrawerOpen(false);
          nav.toSettings();
        }}
        hideDivider={hideDivider}
        onToggleHideDivider={() => setHideDivider(!hideDivider)}
      />

      <CropOverlay
        visible={capture.cropMode}
        capturedImage={capture.capturedImage}
        onClose={() => {
          capture.closeCrop();
        }}
        onSaveSuccess={() => {
          bookmarkData.showToast(tCommon('saveSuccess'), TOAST_DURATION_LONG_MS);
        }}
        onSaveError={(msg: string) => {
          const cleanMsg = msg.replace(/^Error:\s*/i, '');
          bookmarkData.showToast(tCommon('saveFailedWithReason', { reason: cleanMsg }), TOAST_DURATION_ERROR_MS);
        }}
      />

      {/* 全局 Toast 提示 */}
      {bookmarkData.bookmarkToastVisible && (
        <Toast
          message={bookmarkData.bookmarkToastText}
          onClose={() => bookmarkData.setBookmarkToastVisible(false)}
        />
      )}
    </div>
  );
};

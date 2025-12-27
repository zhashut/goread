import React, { useRef, useState, useMemo } from "react";
import { useParams, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { TopBar } from "./reader/TopBar";
import { BottomBar } from "./reader/BottomBar";
import { TocOverlay } from "./reader/TocOverlay";
import { ModeOverlay } from "./reader/ModeOverlay";
import { MoreDrawer } from "./reader/MoreDrawer";
import { CropOverlay } from "./reader/CropOverlay";
import { Toast } from "./Toast";
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
} from "./reader/hooks";


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
  const { settings, updateSettings } = useReaderSettings(rendererRef);
  const readingMode = settings.readingMode || "horizontal";

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

  const isEpubDom = useMemo(() => {
    const path = isExternal ? externalPath : book?.file_path || null;
    if (!path) return false;
    return getBookFormat(path) === "epub";
  }, [isExternal, externalPath, book?.file_path]);

  useReadingSession(book, isExternal);

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
    settings: settingsWithTheme,
    readingMode,
    totalPages,
  });

  // 书籍加载器
  useBookLoader(
    { bookId, isExternal, externalFile },
    readerState,
    { rendererRef, modeVersionRef, epubRenderedRef },
    tocData,
    bookmarkData,
    { resetCache: pageRenderer.forceClearCache }
  );

  // DOM 渲染器
  const domRenderer = useDomRenderer({
    readerState,
    refs: { rendererRef },
    actions: {
      markReadingActive: () => { },
      setActiveNodeSignature: tocData.setActiveNodeSignature
    },
    data: { readingMode, toc: tocData.toc, activeNodeSignature: tocData.activeNodeSignature, isExternal }
  });

  const verticalScroll = useVerticalScroll({
    readerState,
    refs: { verticalCanvasRefs, verticalScrollRef, mainViewRef, renderedPagesRef: pageRenderer.renderedPagesRef },
    actions: {
      renderPageToTarget: pageRenderer.renderPageToTarget,
      setActiveNodeSignature: tocData.setActiveNodeSignature,
      getSmartPredictor: pageRenderer.getSmartPredictor,
      markReadingActive: () => { }
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
      setToc: tocData.setToc
    },
    data: { readingMode, settings: settingsWithTheme, toc: tocData.toc }
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
  });



  // 导航
  const navigation = useNavigation({
    readerState,
    pageRenderer,
    tocData,
    refs: { verticalCanvasRefs, rendererRef },
    data: { readingMode, isExternal, markReadingActive: () => { } }
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
      markReadingActive: () => { }
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
      setMoreDrawerOpen
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

  // 加载状态
  if (loading) {
    return (
      <div
        className="reader-fullheight"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "16px",
          color: "#666",
        }}
      >
        {tCommon('loading')}
      </div>
    );
  }

  return (
    <div
      className="reader-fullheight"
      style={{
        display: "flex",
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
          onClick={(e) => {
            // 忽略交互性元素点击，避免拦截链接跳转或文本选择
            const target = e.target as HTMLElement;
            if (
              target.tagName === 'A' ||
              target.tagName === 'BUTTON' ||
              target.tagName === 'INPUT' ||
              target.tagName === 'TEXTAREA' ||
              target.isContentEditable ||
              target.closest('a') ||
              target.closest('button')
            ) {
              return;
            }

            const rect = e.currentTarget.getBoundingClientRect();
            const x = e.clientX - rect.left;

            // 所有格式统一走 App 控件的点击翻页逻辑
            if (readingMode === "horizontal") {
              if (x < rect.width * 0.3) {
                if (settings.clickTurnPage) navigation.prevPage();
              } else if (x > rect.width * 0.7) {
                if (settings.clickTurnPage) navigation.nextPage();
              } else {
                // 中间点击：自动滚动时仅停止，不弹出扩展器；非自动滚动时切换UI显隐
                if (autoScrollData.autoScroll) {
                  autoScrollData.setAutoScroll(false);
                } else {
                  setUiVisible(v => !v);
                }
              }
            } else {
              // 纵向模式：自动滚动时仅停止，不弹出扩展器；非自动滚动时切换UI显隐
              if (autoScrollData.autoScroll) {
                autoScrollData.setAutoScroll(false);
              } else {
                setUiVisible(v => !v);
              }
            }
          }}
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
                overflowY: isEpubDom ? "hidden" : "auto",
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
                      <div
                        style={{
                          height: `${dividerBandHeight}px`,
                          backgroundColor: effectiveTheme === "dark" ? "#ffffff" : "#000000",
                          width: "100%",
                        }}
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
                {isSeeking && seekPage !== null ? seekPage : currentPage} / {totalPages}
              </div>
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
          if (anchor && isDomRender && rendererRef.current) {
            if (isEpub) {
              (rendererRef.current as any).goToHref?.(anchor);
            } else {
              (rendererRef.current as any).scrollToAnchor?.(anchor);
            }
          } else if (typeof page === 'number') {
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
        onClose={() => {
          setModeOverlayOpen(false);
          setUiVisible(false);
        }}
        onChangeMode={(mode) => {
          updateSettings({ readingMode: mode });
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
      />

      <CropOverlay
        visible={capture.cropMode}
        capturedImage={capture.capturedImage}
        onClose={() => {
          capture.setCropMode(false);
          capture.setCapturedImage(null);
          setUiVisible(false);
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

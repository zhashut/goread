import React, { useState, useEffect, useRef } from "react";
import { useParams } from "react-router-dom";
import { useAppNav } from "../router/useAppNav";
import { IBook, IBookmark } from "../types";
import {
  bookService,
  bookmarkService,
  statsService,
  getReaderSettings,
  saveReaderSettings,
  ReaderSettings,
} from "../services";
import {
  PageCacheManager,
} from "../utils/pdfOptimization";
import { getSafeAreaInsets } from "../utils/layout";
import {
  QUALITY_SCALE_MAP,
  AUTO_PAGE_INTERVAL_MS,
  DEFAULT_SCROLL_SPEED_PX_PER_SEC,
  PAGE_CACHE_SIZE,
  PAGE_CACHE_MEMORY_LIMIT_MB,
  RESIZE_DEBOUNCE_MS,
  TOAST_DURATION_SHORT_MS,
  TOAST_DURATION_LONG_MS,
  TOAST_DURATION_ERROR_MS,
  LAZY_LOAD_ROOT_MARGIN,
} from "../constants/config";
import { log } from "../services/index";
import { statusBarService } from "../services/statusBarService";
import { TopBar } from "./reader/TopBar";
import { BottomBar } from "./reader/BottomBar";
import { TocOverlay } from "./reader/TocOverlay";
import { ModeOverlay } from "./reader/ModeOverlay";
import { MoreDrawer } from "./reader/MoreDrawer";
import { CropOverlay } from "./reader/CropOverlay";
import { TocNode } from "./reader/types";
import { IBookRenderer, getBookFormat, createRenderer, isFormatSupported } from "../services/formats";
import { MarkdownRenderer } from "../services/formats/markdown/MarkdownRenderer";
import { EpubRenderer } from "../services/formats/epub/EpubRenderer";
import { logError } from "../services";
import html2canvas from "html2canvas";
import { applyScalable, resetZoom, applyNonScalable } from "../utils/viewport";

const findActiveNodeSignature = (
  current: number,
  progress: number,
  isPageFullyVisible: boolean,
  nodes: TocNode[]
): string | null => {
  // 1. 收集当前页的所有节点
  const nodesOnPage: { node: TocNode, level: number }[] = [];
  const traverse = (list: TocNode[], level: number) => {
    for (const node of list) {
      if (node.page === current) {
        nodesOnPage.push({ node, level });
      }
      if (node.children) traverse(node.children, level + 1);
    }
  };
  traverse(nodes, 0);

  if (nodesOnPage.length > 0) {
    if (isPageFullyVisible) {
      // 如果页面完全可见，选中该页最后一个节点（视为已阅读完该页内容）
      const target = nodesOnPage[nodesOnPage.length - 1];
      return `${target.node.title}|${target.node.page}|${target.level}`;
    }
    // 根据进度选择节点
    const index = Math.min(Math.floor(progress * nodesOnPage.length), nodesOnPage.length - 1);
    const target = nodesOnPage[index];
    return `${target.node.title}|${target.node.page}|${target.level}`;
  }

  // 2. 如果当前页无节点，查找当前页之前的最后一个节点
  let lastNode: { node: TocNode, level: number } | null = null;
  const traverseLast = (list: TocNode[], level: number) => {
    for (const node of list) {
        if (node.page && node.page < current) {
            lastNode = { node, level };
        }
        if (node.children) traverseLast(node.children, level + 1);
    }
  };
  traverseLast(nodes, 0);
  
  if (lastNode) {
      const n = lastNode as { node: TocNode, level: number };
      return `${n.node.title}|${n.node.page}|${n.level}`;
  }
  
  return null;
}

export const Reader: React.FC = () => {
  const { bookId } = useParams<{ bookId: string }>();
  const nav = useAppNav();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [book, setBook] = useState<IBook | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [bookmarks, setBookmarks] = useState<IBookmark[]>([]);
  const [toc, setToc] = useState<TocNode[]>([]);
  // UI 可见与进度滑动状态
  const [uiVisible, setUiVisible] = useState(false);
  const [isSeeking, setIsSeeking] = useState(false);
  const [seekPage, setSeekPage] = useState<number | null>(null);
  // 目录弹层开关
  const [tocOverlayOpen, setTocOverlayOpen] = useState(false);
  // 阅读方式：horizontal(横向分页) / vertical(纵向连续)
  const [readingMode, setReadingMode] = useState<"horizontal" | "vertical">(
    "horizontal"
  );
  // 是否使用 DOM 渲染（Markdown 等格式，非 Canvas 位图渲染）
  const [isDomRender, setIsDomRender] = useState(false);
  // DOM 渲染容器引用
  const domContainerRef = useRef<HTMLDivElement>(null);
  // 自动滚动：状态与计时器
  const [autoScroll, setAutoScroll] = useState(false);
  const autoScrollTimerRef = useRef<number | null>(null);
  const autoScrollRafRef = useRef<number | null>(null);
  // 阅读方式选择弹层
  const [modeOverlayOpen, setModeOverlayOpen] = useState(false);
  // 纵向阅读容器与懒加载渲染引用
  const mainViewRef = useRef<HTMLDivElement>(null);
  const verticalCanvasRefs = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const currentPageRef = useRef<number>(1);
  const modeVersionRef = useRef<number>(0);
  // 记录当前书籍 ID，用于检测快速切换书籍时的竞态条件
  const bookIdRef = useRef<string | undefined>(bookId);
  // 当前渲染器实例（通过接口统一管理）
  const rendererRef = useRef<IBookRenderer | null>(null);
  const lastSeekTsRef = useRef<number>(0);
  const renderedPagesRef = useRef<Set<number>>(new Set());
  const verticalScrollRef = useRef<HTMLDivElement>(null);
  const verticalScrollRafRef = useRef<number | null>(null);
  // 预加载防抖定时器
  const preloadTimerRef = useRef<any>(null);
  // 优化工具实例
  const pageCacheRef = useRef<PageCacheManager>(new PageCacheManager(PAGE_CACHE_SIZE, PAGE_CACHE_MEMORY_LIMIT_MB));
  // 预加载图片资源缓存（显式管理 ImageBitmap，确保 App 端缓存有效性）
  // 键格式: `${bookId}:${pageNum}`，确保不同书籍的缓存完全隔离
  const preloadedBitmapsRef = useRef<Map<string, ImageBitmap>>(new Map());
  // 预加载任务队列（Promise 复用，防止重复请求）
  // 键格式: `${bookId}:${pageNum}`
  const preloadingTasksRef = useRef<Map<string, Promise<ImageBitmap>>>(new Map());

  // 生成缓存键，将书籍 ID 和页码组合，避免不同书籍的页面混淆
  const makeCacheKey = (bookId: string, pageNum: number) => `${bookId}:${pageNum}`;
  const [verticalLazyReady, setVerticalLazyReady] = useState(false);
  // 书签提示气泡
  const [bookmarkToastVisible, setBookmarkToastVisible] = useState(false);
  const [bookmarkToastText, setBookmarkToastText] = useState("");
  // 设置：本地持久化
  const [settings, setSettings] = useState<ReaderSettings>(getReaderSettings());

  // 更多抽屉
  const [moreDrawerOpen, setMoreDrawerOpen] = useState(false);
  // 截图裁切
  const [cropMode, setCropMode] = useState(false);
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [activeNodeSignature, setActiveNodeSignature] = useState<string | undefined>(undefined);
   const domRestoreDoneRef = useRef(false);
   const savedPageAtOpenRef = useRef<number>(1);
   // 跟踪 EPUB 是否已完成首次渲染，避免模式切换时重复调用 renderPage
   const epubRenderedRef = useRef(false);
   // 内容是否渲染完成（用于触发自动标记检查）
   const [contentReady, setContentReady] = useState(false);
   
   // 阅读时长记录相关
   const sessionStartRef = useRef<number>(0);
   const lastSaveTimeRef = useRef<number>(0);
   const readingSessionIntervalRef = useRef<number | null>(null);

  // 当书籍切换时重置恢复标志
  useEffect(() => {
    domRestoreDoneRef.current = false;
    epubRenderedRef.current = false;
    setContentReady(false);
  }, [bookId]);

  useEffect(() => {
    savedPageAtOpenRef.current = (book?.current_page || 1);
  }, [book?.id]);

  useEffect(() => {
    applyScalable();
    return () => {
      resetZoom();
      applyNonScalable();
    };
  }, []);

  // 阅读时长记录逻辑
  useEffect(() => {
    if (!book?.id) return;
    
    const now = Date.now();
    sessionStartRef.current = now;
    lastSaveTimeRef.current = now;
    
    // 保存阅读会话到后端
    const saveSession = async () => {
      const currentTime = Date.now();
      const duration = Math.floor((currentTime - lastSaveTimeRef.current) / 1000);
      
      // 至少5秒才记录，避免误操作
      if (duration >= 5 && book?.id) {
        const today = new Date();
        const readDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        
        try {
          await statsService.saveReadingSession(
            book.id,
            duration,
            Math.floor(lastSaveTimeRef.current / 1000),
            readDate
          );
        } catch (e) {
          // 记录失败不阻断阅读
          console.warn('Failed to save reading session:', e);
        }
        
        lastSaveTimeRef.current = currentTime;
      }
    };
    
    // 每30秒自动保存一次
    readingSessionIntervalRef.current = window.setInterval(saveSession, 30000);
    
    // 页面切到后台时保存
    const handleVisibilityChange = () => {
      if (document.hidden) {
        saveSession();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    
    return () => {
      // 离开阅读器时保存
      saveSession();
      
      if (readingSessionIntervalRef.current) {
        clearInterval(readingSessionIntervalRef.current);
      }
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [book?.id]);

  // 自动标记已读逻辑
  const lastAutoMarkPageRef = useRef<number | null>(null);
  
  useEffect(() => {
    if (!book || totalPages <= 0) return;
    
    // 离开最后一页时，重置自动标记记录
    if (currentPage < totalPages) {
      lastAutoMarkPageRef.current = null;
      return;
    }
    
    // 只有当：
    // 1. 到了最后一页 (currentPage >= totalPages)
    // 2. 书籍状态未完成 (book.status !== 1)
    // 3. 在当前页还没有自动标记过 (lastAutoMarkPageRef.current !== currentPage)
    // 才执行自动标记
    if (currentPage >= totalPages && book.status !== 1 && lastAutoMarkPageRef.current !== currentPage) {
      
      // 针对 DOM 渲染模式（如 Markdown）的额外检查
      if (isDomRender) {
        // 如果 DOM 尚未渲染完成，不进行标记
        if (!contentReady) return;

        const renderer = rendererRef.current;
        // 检查是否为 Markdown 渲染器（或其他单页滚动渲染器）
        if (renderer && renderer instanceof MarkdownRenderer) {
          const scrollContainer = renderer.getScrollContainer();
          if (scrollContainer) {
            // 如果内容高度超过视口高度（有滚动条）
            if (scrollContainer.scrollHeight > scrollContainer.clientHeight) {
              // 检查是否滚动到底部 (容差 50px)
              const atBottom = scrollContainer.scrollTop + scrollContainer.clientHeight >= scrollContainer.scrollHeight - 50;
              if (!atBottom) {
                return;
              }
            } else {
              // 没有滚动条，内容很短，不自动标记
              return;
            }
          } else {
            // 容器还没准备好，保守起见不标记
            return;
          }
        }
      }

      lastAutoMarkPageRef.current = currentPage;
      
      const autoMark = async () => {
        try {
          // 检查是否有阅读记录，如果没有说明是首次打开，不应该自动标记
          const hasRecords = await statsService.hasReadingSessions(book.id);
          if (!hasRecords) {
            log(`[Reader] 书籍 ${book.id} 无阅读记录，跳过自动标记`);
            return;
          }
          
          log(`[Reader] 进度 100%，自动标记为已读`);
          // 乐观更新
          setBook(prev => prev ? { ...prev, status: 1 } : null);
          await statsService.markBookFinished(book.id);
        } catch (e) {
          console.error("自动标记已读失败", e);
        }
      };
      autoMark();
    }
  }, [currentPage, totalPages, book, contentReady]);

  const toggleFinish = async () => {
    if (!book) return;
    const newStatus = book.status === 1 ? 0 : 1;
    
    // 乐观更新 UI
    setBook(prev => prev ? { ...prev, status: newStatus } : null);
    
    try {
      if (newStatus === 1) {
        await statsService.markBookFinished(book.id);
      } else {
        await statsService.unmarkBookFinished(book.id);
      }
    } catch (e) {
      console.error("切换阅读状态失败", e);
      // 回滚
      setBook(prev => prev ? { ...prev, status: book.status } : null);
      alert("操作失败");
    }
  };

  const handleCapture = async () => {
    let dataUrl = "";
    try {
      const dpr = getCurrentScale();
      
      // DOM 渲染模式（Markdown 等格式）：使用 html2canvas 截图
      if (isDomRender) {
        if (domContainerRef.current) {
          const canvas = await html2canvas(domContainerRef.current, {
            scale: dpr,
            useCORS: true,
            backgroundColor: '#ffffff',
          });
          dataUrl = canvas.toDataURL("image/png");
        }
      } else if (readingMode === "horizontal") {
        if (canvasRef.current) {
          dataUrl = canvasRef.current.toDataURL("image/png");
        }
      } else {
        if (verticalScrollRef.current) {
          const container = verticalScrollRef.current;
          const width = container.clientWidth;
          const height = container.clientHeight;
          const canvas = document.createElement("canvas");
          // 使用 DPR 提升截图清晰度
          canvas.width = width * dpr;
          canvas.height = height * dpr;
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.fillStyle = "#2a2a2a";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            verticalCanvasRefs.current.forEach((vCanvas) => {
              const rect = vCanvas.getBoundingClientRect();
              const containerRect = container.getBoundingClientRect();
              const relativeTop = rect.top - containerRect.top;
              const relativeLeft = rect.left - containerRect.left;
              if (relativeTop < height && relativeTop + rect.height > 0) {
                 // 绘制时考虑 DPR 缩放
                 ctx.drawImage(
                   vCanvas, 
                   relativeLeft * dpr, 
                   relativeTop * dpr,
                   rect.width * dpr,
                   rect.height * dpr
                 );
              }
            });
            dataUrl = canvas.toDataURL("image/png");
          }
        }
      }
      if (dataUrl) {
        setCapturedImage(dataUrl);
        setCropMode(true);
        setMoreDrawerOpen(false);
        setUiVisible(false);
      }
    } catch (e) {
      console.error("Capture failed", e);
    }
  };

  // 获取当前渲染倍率 (Scale)
  // 结合设备像素密度 (DPR) 和用户设置的渲染质量
  const getCurrentScale = () => {
    const dpr = Math.max(1, Math.min(3, (window as any).devicePixelRatio || 1));
    const qualityScale = QUALITY_SCALE_MAP[settings.renderQuality || 'standard'] || 1.0;
    return dpr * qualityScale;
  };

  // 处理返回按钮 / 滑动手势
  useEffect(() => {
    // 清理可能的历史状态干扰
    // 空操作
  }, []);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === "reader_settings_v1") {
        setSettings(getReaderSettings());
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // 从设置恢复阅读方式；当设置中的阅读方式变化时同步到本地状态
  useEffect(() => {
    const mode = settings.readingMode || "horizontal";
    if (mode !== readingMode) {
      setReadingMode(mode);
    }
  }, [settings.readingMode]);

  // 当阅读模式变化时，更新 EPUB 渲染器的流式布局
  useEffect(() => {
    const renderer = rendererRef.current;
    if (renderer && renderer instanceof EpubRenderer) {
      renderer.setReadingMode(readingMode).catch(() => {});
    }
  }, [readingMode]);

  // 当页面间隙变化时，更新 EPUB 渲染器的分割线间距
  useEffect(() => {
    const renderer = rendererRef.current;
    if (renderer && renderer instanceof EpubRenderer) {
      renderer.updatePageGap(settings.pageGap);
    }
  }, [settings.pageGap]);

  useEffect(() => {
    // 更新书籍 ID 引用，并递增版本号以使进行中的异步任务失效
    bookIdRef.current = bookId;
    modeVersionRef.current += 1;
    
    // 切换书籍时，清理所有状态和缓存
    // 关闭旧渲染器
    if (rendererRef.current) {
      rendererRef.current.close();
      rendererRef.current = null;
    }
    epubRenderedRef.current = false;
    pageCacheRef.current.clear();
    // 清理预加载的 Bitmap 资源
    // 清理其他书籍的缓存（保留当前书籍的缓存以便复用）
    const currentPrefix = `${bookId}:`;
    for (const [key, bmp] of preloadedBitmapsRef.current.entries()) {
      if (!key.startsWith(currentPrefix)) {
        bmp.close && bmp.close();
        preloadedBitmapsRef.current.delete(key);
      }
    }
    for (const key of preloadingTasksRef.current.keys()) {
      if (!key.startsWith(currentPrefix)) {
        preloadingTasksRef.current.delete(key);
      }
    }
    
    renderedPagesRef.current.clear();
    verticalCanvasRefs.current.clear();
    if (preloadTimerRef.current) {
      clearTimeout(preloadTimerRef.current);
      preloadTimerRef.current = null;
    }
    setLoading(true);
    setCurrentPage(1);
    setTotalPages(1);
    
    loadBook();
    
    // 清理函数：组件卸载或切换书籍时清理缓存
    return () => {
      // 关闭渲染器
      if (rendererRef.current) {
        rendererRef.current.close();
        rendererRef.current = null;
      }
      pageCacheRef.current.clear();
      preloadedBitmapsRef.current.forEach(bmp => bmp.close && bmp.close());
      preloadedBitmapsRef.current.clear();
      preloadingTasksRef.current.clear();
      renderedPagesRef.current.clear();
      if (preloadTimerRef.current) {
        clearTimeout(preloadTimerRef.current);
      }
    };
  }, [bookId]);

  useEffect(() => {
    currentPageRef.current = currentPage;
    if (readingMode === "horizontal" && !isDomRender) {
      const sig = findActiveNodeSignature(currentPage, 1.0, true, toc);
      setActiveNodeSignature(sig || undefined);
    }
  }, [currentPage, readingMode, toc, isDomRender]);

  // 监听窗口大小变化（解决拉伸模糊问题，适配横向/纵向模式）
  useEffect(() => {
    let resizeTimer: number | null = null;
    const handleResize = () => {
      if (resizeTimer) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        log('[handleResize] 窗口大小改变，触发重绘以恢复清晰度');
        
        // 1. 清理所有缓存（确保下次渲染使用适配当前窗口尺寸的新分辨率图片）
        // 因为 resize 后宽度变了，旧的缓存图片尺寸不对，必须清除。
        pageCacheRef.current.clear();
        preloadedBitmapsRef.current.forEach((bmp) => bmp.close && bmp.close());
        preloadedBitmapsRef.current.clear();
        preloadingTasksRef.current.clear();
        
        // 2. 根据模式触发重绘
        if (readingMode === "horizontal") {
          // 横向模式：强制重绘当前页
          renderPage(currentPageRef.current, true);
        } else {
          // 纵向模式：清理渲染标记，并触发 IntersectionObserver 重新检测渲染
          renderedPagesRef.current.clear();
          // 通过重置 verticalLazyReady 状态来重启 Observer
          setVerticalLazyReady(false);
          setTimeout(() => setVerticalLazyReady(true), 50);
        }
      }, RESIZE_DEBOUNCE_MS); // 防抖，等待拖动结束
    };

    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      if (resizeTimer) window.clearTimeout(resizeTimer);
    };
  }, [readingMode]);

  // 统一的页面加载函数（支持 Promise 复用）
  const loadPageBitmap = async (pageNum: number): Promise<ImageBitmap> => {
    // 捕获当前书籍 ID，用于在异步操作期间检测书籍是否切换
    const capturedBookId = bookIdRef.current;
    // 书籍 ID 无效时不进行缓存操作
    if (!capturedBookId) {
      return Promise.reject(new Error('无效的书籍 ID'));
    }
    const cacheKey = makeCacheKey(capturedBookId, pageNum);
    
    // 1. 缓存命中
    if (preloadedBitmapsRef.current.has(cacheKey)) {
      return preloadedBitmapsRef.current.get(cacheKey)!;
    }
    // 2. 任务复用命中
    if (preloadingTasksRef.current.has(cacheKey)) {
      return preloadingTasksRef.current.get(cacheKey)!;
    }

    // 3. 发起新任务
    const task = (async () => {
      try {
        // 开始前检查书籍是否已切换
        if (bookIdRef.current !== capturedBookId) {
          return Promise.reject() as unknown as ImageBitmap;
        }
        
        // 检查渲染器是否就绪
        const renderer = rendererRef.current;
        if (!renderer) {
          return Promise.reject(new Error('渲染器未初始化')) as unknown as ImageBitmap;
        }
        if (!renderer.isReady && book?.file_path) {
          try { await renderer.loadDocument(book.file_path); } catch {}
        }
        
        const viewW = canvasRef.current?.parentElement?.clientWidth || mainViewRef.current?.clientWidth || 800;
        
        // 使用与 getCurrentScale 一致的逻辑获取 DPR
        const dpr = getCurrentScale();
        const containerWidth = Math.min(4096, Math.floor(viewW * dpr));

        const renderStartTime = performance.now();
        // 通过渲染器接口加载页面位图
        let bitmap: ImageBitmap;
        try {
          bitmap = await renderer.loadPageBitmap!(
            pageNum,
            containerWidth,
            settings.renderQuality || 'standard'
          );
        } catch (err) {
          const msg = String(err || '');
          if ((msg.includes('文档未加载') || msg.includes('PDF文档未加载')) && book?.file_path) {
            try { await renderer.loadDocument(book.file_path); } catch {}
            bitmap = await renderer.loadPageBitmap!(
              pageNum,
              containerWidth,
              settings.renderQuality || 'standard'
            );
          } else {
            throw err;
          }
        }
        const renderEndTime = performance.now();
        log(`[loadPageBitmap] 页面 ${pageNum} 渲染+解码耗时: ${Math.round(renderEndTime - renderStartTime)}ms`);
        
        // 缓存前最后检查：确保书籍未切换
        if (bookIdRef.current !== capturedBookId) {
          log(`[loadPageBitmap] 解码完成后书籍已切换，丢弃页面 ${pageNum}`);
          bitmap.close && bitmap.close();
          return Promise.reject() as unknown as ImageBitmap;
        }
        
        // 存入缓存
        preloadedBitmapsRef.current.set(cacheKey, bitmap);
        return bitmap;
      } finally {
        // 任务完成（无论成功失败），从队列移除
        preloadingTasksRef.current.delete(cacheKey);
      }
    })();

    preloadingTasksRef.current.set(cacheKey, task);
    return task;
  };

  const loadBook = async () => {
    try {
      setLoading(true);
      const books = await bookService.getAllBooks();
      const targetBook = books.find((b) => b.id === parseInt(bookId!));

      if (!targetBook) {
        alert("书籍不存在");
        nav.toBookshelf();
        return;
      }

      setBook(targetBook);
      setCurrentPage(targetBook.current_page);
      setTotalPages(targetBook.total_pages);
      
      // 检查并修正错误的已完成状态
      // 如果书籍被标记为已完成(status=1)，但没有任何阅读记录，说明是误标记，需要撤销
      if (targetBook.status === 1) {
        try {
          log(`[Reader] 检查书籍 ${targetBook.id} 的阅读记录，当前状态: ${targetBook.status}`);
          const hasRecords = await statsService.hasReadingSessions(targetBook.id);
          log(`[Reader] 书籍 ${targetBook.id} 是否有阅读记录: ${hasRecords}`);
          if (!hasRecords) {
            log(`[Reader] 书籍 ${targetBook.id} 被标记为已完成但无阅读记录，撤销标记`);
            await statsService.unmarkBookFinished(targetBook.id);
            // 更新本地状态
            targetBook.status = 0;
            targetBook.finished_at = null;
            setBook({ ...targetBook });
            log(`[Reader] 已撤销书籍 ${targetBook.id} 的已完成标记`);
          } else {
            log(`[Reader] 书籍 ${targetBook.id} 有阅读记录，保持已完成状态`);
          }
        } catch (e) {
          console.error("检查阅读记录失败", e);
          log(`[Reader] 检查阅读记录失败: ${e}`);
        }
      }
      
      // 打开即记录最近阅读时间（不依赖进度变化）
      try {
        await bookService.markBookOpened(targetBook.id);
        // 同时更新本地排序记录，确保该书排在最近列表首位
        try {
          const orderKey = "recent_books_order";
          const orderStr = localStorage.getItem(orderKey);
          let order: number[] = [];
          if (orderStr) {
            try {
              order = JSON.parse(orderStr);
            } catch {}
          }
          // 移除旧位置
          order = order.filter((id) => id !== targetBook.id);
          // 插入到头部
          order.unshift(targetBook.id);
          localStorage.setItem(orderKey, JSON.stringify(order));
        } catch (e) {
          console.warn("更新最近阅读顺序失败", e);
        }
      } catch (e) {
        console.warn("标记书籍已打开失败", e);
      }

      // 检查文件格式是否支持
      if (!isFormatSupported(targetBook.file_path)) {
        const format = getBookFormat(targetBook.file_path);
        alert(`暂不支持 ${format || '未知'} 格式`);
        nav.toBookshelf();
        return;
      }

      // 通过工厂函数创建对应格式的渲染器
      const renderer = createRenderer(targetBook.file_path);
      rendererRef.current = renderer;
      
      // 根据渲染器能力决定是否使用 DOM 渲染
      const useDomRender = renderer.capabilities.supportsDomRender && !renderer.capabilities.supportsBitmap;
      setIsDomRender(useDomRender);
      
      const bookInfo = await renderer.loadDocument(targetBook.file_path);
      const pageCount = Math.max(1, bookInfo.pageCount ?? targetBook.total_pages ?? 1);
      
      setTotalPages(pageCount);
      setLoading(false);

      // 后台加载目录和书签（不阻塞首屏显示）
      // 加载目录（Outline）——通过渲染器接口获取
      Promise.resolve().then(async () => {
        try {
          const tocItems = await renderer.getToc();
          // 转换为 TocNode 格式（保持 expanded 状态）
          const toTocNode = (items: typeof tocItems): TocNode[] => {
            return items.map((item) => ({
              title: item.title,
              page: typeof item.location === 'number' ? item.location : undefined,
              // 保留字符串类型的 location 作为 anchor（Markdown 等格式）
              anchor: typeof item.location === 'string' ? item.location : undefined,
              children: item.children ? toTocNode(item.children) : [],
              expanded: false,
            }));
          };
          const parsed = toTocNode(tocItems);
          if (parsed.length > 0) {
            setToc(parsed);
          } else {
            // 无目录时创建默认条目
            if (pageCount > 0) {
              setToc([{ title: targetBook.title || '目录', page: 1, children: [], expanded: true }]);
            } else {
              setToc([]);
            }
          }
        } catch (e) {
          try {
            await logError('pdf_get_outline failed', { error: String(e), filePath: targetBook.file_path });
          } catch {}
          setToc([]);
        }
      });

        // 加载书签
        Promise.resolve().then(async () => {
          try {
            const list = await bookmarkService.getBookmarks(targetBook.id);
            setBookmarks(Array.isArray(list) ? list : []);
          } catch (e) {
            console.warn("获取书签失败", e);
            setBookmarks([]);
          }
        });


    } catch (error) {
      await logError('加载书籍失败 failed', { error: String(error) });
      alert("加载书籍失败");
    }
  };

  

  const renderPage = async (pageNum: number, forceRender: boolean = false) => {
    if (!book || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const context = canvas.getContext("2d");
    if (!context) return;
    const localModeVer = modeVersionRef.current;
    // 捕获当前书籍 ID，用于检测渲染期间书籍是否切换
    const capturedBookId = bookIdRef.current;

    const existingRender = renderQueueRef.current.get(pageNum);
    if (existingRender) {
      try { await existingRender; } catch {}
      return;
    }

    const renderPromise = (async () => {
      try {
        // 使用当前设备的 DPR 作为 scale
        const scale = getCurrentScale();
        const pageCache = pageCacheRef.current;

        // 检查前端缓存（如果有缓存，立即显示，无黑屏）
        if (!forceRender) {
          const cached = pageCache.get(pageNum, scale);
          if (cached) {
            log(`[renderPage] 页面 ${pageNum} 从前端缓存加载`);
            canvas.width = cached.width;
            canvas.height = cached.height;
            if ((context as any).resetTransform) {
              (context as any).resetTransform();
            } else {
              context.setTransform(1, 0, 0, 1, 0, 0);
            }
            context.clearRect(0, 0, canvas.width, canvas.height);
            context.putImageData(cached.imageData, 0, 0);
            canvas.style.opacity = "1";
            canvas.style.backgroundColor = "transparent";
            // 即使命中缓存，也触发预加载（确保下一页准备好）
            preloadAdjacentPages(pageNum);
            return;
          }
        }

        // 立即触发下一页预加载（并行请求，不等待当前页渲染）
        // 这样可以确保在当前页渲染耗时期间，下一页的请求已经发给后端
        preloadAdjacentPages(pageNum);

        log(`[renderPage] 页面 ${pageNum} 开始渲染（前端无缓存）`);
        const startTime = performance.now();

        // 显示加载状态（灰色背景，避免黑屏）
        canvas.style.backgroundColor = "#2a2a2a";

        let standardImg: any = null;

        try {
          // 使用统一的加载函数，支持 Promise 复用
          standardImg = await loadPageBitmap(pageNum);
          
          // 渲染后从预加载缓存中移除（因为即将转为 ImageData 缓存到 pageCacheRef）
          // 注意：loadPageBitmap 会自动 set 到 preloadedBitmapsRef，这里取出后清理以释放内存
          if (capturedBookId) {
            const cacheKey = makeCacheKey(capturedBookId, pageNum);
            if (preloadedBitmapsRef.current.has(cacheKey)) {
              preloadedBitmapsRef.current.delete(cacheKey);
            }
          }
        } catch (error) {
          log(`[renderPage] 页面 ${pageNum} 加载失败: ${error}`, 'error');
          throw error;
        }

        if (pageNum !== currentPageRef.current) {
          return;
        }
        if (localModeVer !== modeVersionRef.current) {
          return;
        }
        if (readingMode !== "horizontal") {
          return;
        }
        // 检查异步加载期间书籍是否已切换
        if (bookIdRef.current !== capturedBookId) {
          log(`[renderPage] 书籍已切换，放弃渲染页面 ${pageNum}`);
          return;
        }
        canvas.width = standardImg.width;
        canvas.height = standardImg.height;
        if ((context as any).resetTransform) {
          (context as any).resetTransform();
        } else {
          context.setTransform(1, 0, 0, 1, 0, 0);
        }
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(standardImg, 0, 0);
        canvas.style.opacity = "1";
        canvas.style.backgroundColor = "transparent";

        const endTime = performance.now();
        log(`[renderPage] 页面 ${pageNum} 渲染完成，总耗时: ${Math.round(endTime - startTime)}ms`);

        // 缓存结果
        try {
          const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
          // 存入缓存时使用 scale (DPR)
          pageCache.set(pageNum, imageData, canvas.width, canvas.height, scale);
        } catch (e) {
          console.warn("Failed to cache page:", e);
        }
      } catch (error) {
        log(`[renderPage] 页面 ${pageNum} 渲染失败: ${error}`, 'error');
      } finally {
        renderQueueRef.current.delete(pageNum);
      }
    })();

    renderQueueRef.current.set(pageNum, renderPromise);
    return renderPromise;
  };

  // 预加载相邻页面（后台静默加载到缓存）
  const preloadAdjacentPages = async (currentPageNum: number) => {
    if (!book) return;
    
    // 捕获当前书籍 ID，避免为错误的书籍预加载
    const capturedBookId = bookIdRef.current;
    
    // 预加载下两页，确保连续翻页流畅
    const pagesToPreload = [currentPageNum + 1, currentPageNum + 2];
    // 获取当前 Scale，确保检查缓存的 Key 与渲染时一致
    const scale = getCurrentScale();
    
    for (const nextPage of pagesToPreload) {
      if (nextPage <= totalPages) {
        // 预加载前检查书籍是否已切换
        if (bookIdRef.current !== capturedBookId) {
          log(`[preloadAdjacentPages] 书籍已切换，停止预加载`);
          return;
        }
        
        // 1. 检查是否已有 ImageData 缓存
        if (pageCacheRef.current.has(nextPage, scale)) continue;
        
        // 2. 调用统一加载函数（内部会自动检查 preloadedBitmapsRef 和 preloadingTasksRef）
        // 这样可以确保如果用户快速翻页，renderPage 可以直接复用这里发起的 Promise
        loadPageBitmap(nextPage).catch(e => console.warn(`预加载页面 ${nextPage} 失败`, e));
      }
    }
  };

  

  const goToPage = async (pageNum: number) => {
    if (pageNum < 1 || pageNum > totalPages) return;

    setCurrentPage(pageNum);
    currentPageRef.current = pageNum;
    if (isDomRender) {
      const renderer = rendererRef.current;
      if (renderer && renderer instanceof MarkdownRenderer) {
        const scrollContainer = renderer.getScrollContainer();
        if (scrollContainer) {
          const viewportHeight = scrollContainer.clientHeight;
          renderer.scrollToVirtualPage(pageNum, viewportHeight);
        }
      } else if (renderer && renderer instanceof EpubRenderer) {
        // EPUB 渲染器直接调用 goToPage
        await renderer.goToPage(pageNum);
      }
    } else if (readingMode === "horizontal") {
      await renderPage(pageNum, true);
    } else {
      // 纵向模式：滚动到对应页的 canvas
      const target = verticalCanvasRefs.current.get(pageNum);
      if (target) {
        target.scrollIntoView({ behavior: "auto", block: "start" });
      }
      // 若尚未渲染，使用渐进式渲染
      if (!renderedPagesRef.current.has(pageNum)) {
        await renderPageToTarget(pageNum, target || null);
      }
      
    }

    // 保存阅读进度
    if (book) {
      await bookService.updateBookProgress(book.id!, pageNum);
    }
  };

  const nextPage = () => goToPage(currentPage + 1);
  const prevPage = () => goToPage(currentPage - 1);

  // 计算当前章节页（<= current_page 的最大章节页）
  const findCurrentChapterPage = (nodes: TocNode[]): number | undefined => {
    const pages: number[] = [];
    const collect = (ns: TocNode[]) => {
      for (const n of ns) {
        if (typeof n.page === "number") pages.push(n.page);
        if (n.children && n.children.length) collect(n.children);
      }
    };
    collect(nodes);
    pages.sort((a, b) => a - b);
    let target: number | undefined = undefined;
    for (const p of pages) {
      if (p <= currentPage) target = p;
      else break;
    }
    return target;
  };

  const currentChapterPageVal = findCurrentChapterPage(toc);
  const getBookmarkTitleForCurrent = (): string => {
    const chapterPage = currentChapterPageVal;
    if (typeof chapterPage === "number") {
      const findTitle = (nodes: TocNode[]): string | undefined => {
        for (const n of nodes) {
          if (n.page === chapterPage) return n.title;
          if (n.children && n.children.length) {
            const t = findTitle(n.children);
            if (t) return t;
          }
        }
        return undefined;
      };
      const title = findTitle(toc);
      if (title) return title;
    }
    return `第 ${currentPage} 页`;
  };

  const addBookmark = async () => {
    if (!book) return;
    try {
      const title = getBookmarkTitleForCurrent();
      const created = await bookmarkService.addBookmark(
        book.id,
        currentPage,
        title
      );
      setBookmarks((prev) =>
        [...prev, created].sort((a, b) => a.page_number - b.page_number)
      );
      // 展示短暂气泡提示
      setBookmarkToastText("书签已添加");
      setBookmarkToastVisible(true);
      setUiVisible(false);
      setTimeout(() => setBookmarkToastVisible(false), TOAST_DURATION_SHORT_MS);
    } catch (e) {
      console.error("添加书签失败", e);
      alert("添加书签失败");
    }
  };

  const deleteBookmark = async (id: number) => {
    try {
      await bookmarkService.deleteBookmark(id);
      setBookmarks((prev) => prev.filter((b) => b.id !== id));
    } catch (e) {
      console.error("删除书签失败", e);
      alert("删除书签失败");
    }
  };

  // 渲染队列：避免多个页面同时请求导致 IPC 阻塞
  const renderQueueRef = useRef<Map<number, Promise<void>>>(new Map());

  // 渐进式渲染（纵向模式）：先显示缩略图，再加载标准质量
  const renderPageToTarget = async (
    pageNum: number,
    canvasEl: HTMLCanvasElement | null
  ) => {
    if (!book) return;
    const localModeVer = modeVersionRef.current;
    // 捕获当前书籍 ID，用于检测渲染期间书籍是否切换
    const capturedBookId = bookIdRef.current;
    
    // 如果已经在渲染队列中，等待完成
    const existingRender = renderQueueRef.current.get(pageNum);
    if (existingRender) {
      return existingRender;
    }
    
    const canvas = canvasEl || verticalCanvasRefs.current.get(pageNum);
    if (!canvas) return;
    
    const context = canvas.getContext("2d");
    if (!context) return;

    // 创建渲染 Promise 并加入队列
    const renderPromise = (async () => {
      try {
        const viewW = mainViewRef.current?.clientWidth || 800;
        // 统一使用 getCurrentScale 获取 DPR
        const scale = getCurrentScale();
        const dpr = scale; // 别名，方便下面理解
        const containerWidth = Math.min(4096, Math.floor(viewW * dpr));
        const pageCache = pageCacheRef.current;

        // 检查前端缓存（如果有缓存，立即显示）
        // 使用动态 Scale 检查缓存
        const cached = pageCache.get(pageNum, scale);
        if (cached) {
          log(`[renderPageToTarget] 页面 ${pageNum} 从前端缓存加载`);
          canvas.width = cached.width;
          canvas.height = cached.height;
          if ((context as any).resetTransform) {
            (context as any).resetTransform();
          } else {
            context.setTransform(1, 0, 0, 1, 0, 0);
          }
          context.clearRect(0, 0, canvas.width, canvas.height);
          context.putImageData(cached.imageData, 0, 0);
          canvas.style.opacity = "1";
          canvas.style.backgroundColor = "transparent";
          renderedPagesRef.current.add(pageNum);
          return;
        }

        log(`[renderPageToTarget] 页面 ${pageNum} 开始渲染（前端无缓存）`);
        const startTime = performance.now();

      // 显示加载状态（保持 minHeight，避免布局跳动）
      canvas.style.backgroundColor = "#2a2a2a";

      // 检查渲染器是否就绪
      const renderer = rendererRef.current;
      if (!renderer) {
        log(`[renderPageToTarget] 渲染器未初始化，跳过页面 ${pageNum}`);
        return;
      }

      const renderStartTime = performance.now();
      // 通过渲染器接口加载页面位图
      if (!renderer.isReady && book?.file_path) {
        try { await renderer.loadDocument(book.file_path); } catch {}
      }
      let img: ImageBitmap;
      try {
        img = await renderer.loadPageBitmap!(
          pageNum,
          containerWidth,
          settings.renderQuality || 'standard'
        );
      } catch (err) {
        const msg = String(err || '');
        if ((msg.includes('文档未加载') || msg.includes('PDF文档未加载')) && book?.file_path) {
          try { await renderer.loadDocument(book.file_path); } catch {}
          img = await renderer.loadPageBitmap!(
            pageNum,
            containerWidth,
            settings.renderQuality || 'standard'
          );
        } else {
          throw err;
        }
      }
      const renderEndTime = performance.now();
      log(`[renderPageToTarget] 页面 ${pageNum} 渲染+解码耗时: ${Math.round(renderEndTime - renderStartTime)}ms`);

      if (localModeVer !== modeVersionRef.current) {
        return;
      }
      if (readingMode !== "vertical") {
        return;
      }
      if (!document.contains(canvas)) {
        return;
      }
      // 检查异步加载期间书籍是否已切换
      if (bookIdRef.current !== capturedBookId) {
        log(`[renderPageToTarget] 书籍已切换，放弃渲染页面 ${pageNum}`);
        return;
      }
      canvas.width = img.width;
      canvas.height = img.height;
      if ((context as any).resetTransform) {
        (context as any).resetTransform();
      } else {
        context.setTransform(1, 0, 0, 1, 0, 0);
      }
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      canvas.style.opacity = "1";
      canvas.style.backgroundColor = "transparent";
      context.drawImage(img, 0, 0);
      renderedPagesRef.current.add(pageNum);

      const endTime = performance.now();
      log(`[renderPageToTarget] 页面 ${pageNum} 渲染完成，总耗时: ${Math.round(endTime - startTime)}ms`);

        // 缓存结果
        try {
          const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
          // 存入缓存时使用 scale
          pageCache.set(pageNum, imageData, canvas.width, canvas.height, scale);
        } catch (e) {
          console.warn("Failed to cache vertical page:", e);
        }
      } catch (error) {
        log(`[renderPageToTarget] 页面 ${pageNum} 渲染失败: ${error}`, 'error');
      } finally {
        // 从队列中移除
        renderQueueRef.current.delete(pageNum);
      }
    })();

    // 加入队列
    renderQueueRef.current.set(pageNum, renderPromise);
    return renderPromise;
  };

  // 纵向模式懒加载：在进入可视区域时渲染页面（不在此处更新 currentPage）
  useEffect(() => {
    if (readingMode !== "vertical" || !book || totalPages === 0 || !verticalLazyReady) return;
    
    let observer: IntersectionObserver | null = null;
    
    // 延迟创建 observer，确保 DOM 已经渲染
    const timer = setTimeout(() => {
      const rootEl = verticalScrollRef.current || mainViewRef.current || undefined;
      const canvases = Array.from(verticalCanvasRefs.current.values());
      
      if (!rootEl || canvases.length === 0) return;

      observer = new IntersectionObserver(
        async (entries) => {
          for (const entry of entries) {
            const target = entry.target as HTMLCanvasElement;
            const pageAttr = target.getAttribute("data-page");
            const pageNum = pageAttr ? Number(pageAttr) : NaN;
            if (isNaN(pageNum)) continue;
            
            if (entry.isIntersecting) {
              log(`[IntersectionObserver] 页面 ${pageNum} 进入可视区域，已渲染: ${renderedPagesRef.current.has(pageNum)}`);
              if (!renderedPagesRef.current.has(pageNum)) {
                // 渲染页面
                await renderPageToTarget(pageNum, target);
              }
            }
          }
        },
        // 扩大预渲染范围，确保滚动时提前加载
        { root: rootEl, rootMargin: LAZY_LOAD_ROOT_MARGIN, threshold: 0.01 }
      );

      canvases.forEach((el) => observer!.observe(el));
    }, 100);

    return () => {
      clearTimeout(timer);
      observer && observer.disconnect();
    };
  }, [readingMode, totalPages, book, verticalLazyReady]);

  // 切换阅读模式时，清理渲染标记
  useEffect(() => {
    if (!book || totalPages === 0) return;
    
    // 清理渲染标记，让统一的渲染 useEffect 重新渲染
    renderedPagesRef.current.clear();
    modeVersionRef.current += 1;
    renderQueueRef.current.clear();
    setVerticalLazyReady(false);
    setContentReady(false);
    if (verticalScrollRafRef.current !== null) {
      cancelAnimationFrame(verticalScrollRafRef.current);
      verticalScrollRafRef.current = null;
    }
  }, [readingMode]);

  // 首次加载完成后，立即渲染当前页（横向、纵向和 DOM 渲染模式）
  useEffect(() => {
    if (loading || !book || totalPages === 0) return;
    
    // 对于 EPUB 格式，如果已经渲染过，跳过（模式切换由专门的 useEffect 处理）
    const isEpub = book?.file_path && getBookFormat(book.file_path) === 'epub';
    if (isEpub && epubRenderedRef.current) {
      log(`[Reader] EPUB 已渲染，跳过重复渲染（模式切换由 setReadingMode 处理）`);
      return;
    }
    
    log(`[Reader] 开始首次渲染，模式: ${readingMode}, DOM渲染: ${isDomRender}, 当前页: ${currentPage}`);
    
    const renderInitial = async () => {
      // DOM 渲染模式（Markdown 等格式）
      if (isDomRender) {
        const renderer = rendererRef.current;
        if (!renderer) {
          log('[Reader] DOM渲染模式: 渲染器未初始化');
          return;
        }
        
        // 等待 DOM 容器准备好（确保容器存在且有实际尺寸）
        const waitForContainer = () => {
          return new Promise<void>((resolve) => {
            const checkContainer = () => {
              const container = domContainerRef.current;
              if (container) {
                // 检查容器是否有实际尺寸（避免布局未完成时渲染导致白屏）
                const { clientWidth, clientHeight } = container;
                if (clientWidth > 0 && clientHeight > 0) {
                  log(`[Reader] DOM渲染容器已准备好，尺寸: ${clientWidth}x${clientHeight}`);
                  resolve();
                } else {
                  // 容器存在但尺寸为0，等待下一帧重新检查
                  requestAnimationFrame(checkContainer);
                }
              } else {
                setTimeout(checkContainer, 50);
              }
            };
            checkContainer();
          });
        };
        
        await waitForContainer();
        
        // 使用渲染器的 renderPage 方法直接渲染到容器
        try {
          log('[Reader] 开始 DOM 渲染');
          
          // Markdown 渲染器：注册位置恢复完成回调
          if (renderer instanceof MarkdownRenderer) {
            renderer.onPositionRestored = () => {
              log('[Reader] Markdown 位置恢复完成');
              setContentReady(true);
            };
          }
          
          await renderer.renderPage(1, domContainerRef.current!, { 
            initialVirtualPage: currentPage || 1,
            readingMode: readingMode,
            theme: 'light',
            pageGap: settings.pageGap,
          });
          log('[Reader] DOM 渲染完成');
          domRestoreDoneRef.current = true;
          
          // 非 Markdown 渲染器直接设置 contentReady
          if (!(renderer instanceof MarkdownRenderer)) {
            setContentReady(true);
          }
          
          if (renderer instanceof EpubRenderer) {
            renderer.onPageChange = (p: number) => {
              setCurrentPage(p);
              if (book) {
                bookService.updateBookProgress(book.id!, p).catch(() => {});
              }
            };
          }
          
          // 标记 EPUB 已完成首次渲染
          if (isEpub) {
            epubRenderedRef.current = true;
          }
          // 刷新目录（MdCatalog 提取的目录）
          try {
            const items = await renderer.getToc();
            const toTocNode = (list: any[]): TocNode[] => {
              return (list || []).map((item: any) => ({
                title: String(item?.title || ''),
                page: typeof item?.location === 'number' ? item.location : undefined,
                anchor: typeof item?.location === 'string' ? item.location : undefined,
                children: item?.children ? toTocNode(item.children) : [],
                expanded: false,
              }));
            };
            const nodes = toTocNode(items as any);
            if (nodes.length > 0) setToc(nodes);
            
            // EPUB 渲染器：注册目录变化回调以支持高亮
            if (renderer instanceof EpubRenderer) {
              renderer.onTocChange = (href: string) => {
                // 根据 href 查找对应的目录项并生成 signature
                // 支持完全匹配和部分匹配（忽略 # 后的锚点）
                const normalizeHref = (h: string) => h?.split('#')[0] || '';
                const hrefBase = normalizeHref(href);
                
                const findByHref = (list: TocNode[], level: number): { title: string; level: number } | null => {
                  for (const n of list) {
                    const anchorBase = normalizeHref(n.anchor || '');
                    // 完全匹配或基础路径匹配
                    if (n.anchor === href || (hrefBase && anchorBase === hrefBase)) {
                      return { title: n.title, level };
                    }
                    if (n.children) {
                      const r = findByHref(n.children, level + 1);
                      if (r) return r;
                    }
                  }
                  return null;
                };
                const found = findByHref(nodes, 0);
                if (found) {
                  const sig = `${found.title}|-1|${found.level}`;
                  setActiveNodeSignature(sig);
                }
              };
            }
          } catch {}
        } catch (e) {
          console.error('[Reader] DOM 渲染失败:', e);
        }
        return;
      }
      
      if (readingMode === "horizontal") {
        // 横向模式：等待 canvas 准备好后渲染
        const waitForCanvas = () => {
          return new Promise<void>((resolve) => {
            const checkCanvas = () => {
              if (canvasRef.current) {
                log('[Reader] 横向模式 canvas 已准备好');
                resolve();
              } else {
                setTimeout(checkCanvas, 50);
              }
            };
            checkCanvas();
          });
        };
        
        await waitForCanvas();
        log(`[Reader] 开始渲染横向模式页面: ${currentPage}`);
        await renderPage(currentPage);
        log('[Reader] 横向模式页面渲染完成');
        
        // 预加载逻辑已移至 renderPage 内部，此处不再重复调用
      } else {
        // 纵向模式：等待 canvas 准备好后渲染
        const waitForCanvases = () => {
          return new Promise<void>((resolve) => {
            const checkCanvases = () => {
              const canvas = verticalCanvasRefs.current.get(currentPage);
              if (canvas) {
                log('[Reader] 纵向模式 canvas 已准备好');
                resolve();
              } else {
                log('[Reader] 等待纵向模式 canvas...');
                setTimeout(checkCanvases, 50);
              }
            };
            checkCanvases();
          });
        };
        
        await waitForCanvases();
        
        // 渲染当前页及前后各1页，确保有内容显示
        // 优化：优先渲染当前页，然后并行渲染前后页
        const canvas = verticalCanvasRefs.current.get(currentPage);
        if (canvas && !renderedPagesRef.current.has(currentPage)) {
          await renderPageToTarget(currentPage, canvas);
        }

        const otherPages = [
          Math.max(1, currentPage - 1),
          Math.min(totalPages, currentPage + 1),
        ].filter(p => p !== currentPage);
        
        log(`[Reader] 开始渲染纵向模式邻近页面: ${JSON.stringify(otherPages)}`);
        // 并行渲染邻近页，不阻塞当前流程
        Promise.all(otherPages.map(pageNum => {
          const c = verticalCanvasRefs.current.get(pageNum);
          if (c && !renderedPagesRef.current.has(pageNum)) {
            return renderPageToTarget(pageNum, c);
          }
          return Promise.resolve();
        })).catch(e => console.warn("邻近页面渲染失败", e));

        log('[Reader] 纵向模式页面渲染完成');
        
        // 渲染完成后，滚动到当前页
        const currentCanvas = verticalCanvasRefs.current.get(currentPage);
        if (currentCanvas) {
          setTimeout(() => {
            currentCanvas.scrollIntoView({ behavior: "auto", block: "start" });
            setVerticalLazyReady(true);
          }, 100);
        }
      }
    };
    
    // 立即执行
    renderInitial();
}, [loading, book, totalPages, readingMode, isDomRender]);

  // 纵向模式：滚动时动态更新当前页（以视口中心线为准；不进行程序化对齐）
  useEffect(() => {
    if (loading) return;
    if (readingMode !== "vertical") return;
    if (isDomRender) return;
    const vs = verticalScrollRef.current;
    const mv = mainViewRef.current;

    const updateFromScroll = () => {
      verticalScrollRafRef.current = null;
      // 滑动期间不回写 currentPage，避免与滑动条中途状态互相干扰
      if (isSeeking) {
        const now = Date.now();
        if (now - lastSeekTsRef.current <= 400) {
          log('[updateFromScroll] 跳过更新（正在拖动进度条）');
          return;
        }
        // 保护：拖动结束但事件丢失时，自动退出 seeking
        setIsSeeking(false);
        setSeekPage(null);
      }
      // 选择活动滚动容器（优先内层，其次外层），否则使用窗口视口
      const hasVsScroll = !!(vs && vs.scrollHeight > vs.clientHeight + 2);
      const hasMvScroll = !!(mv && mv.scrollHeight > mv.clientHeight + 2);
      const activeContainer = hasVsScroll ? vs : hasMvScroll ? mv : null;
      const activeRect = activeContainer?.getBoundingClientRect();
      const centerY = activeContainer
        ? (activeRect!.top + activeContainer.clientHeight * 0.5)
        : (window.innerHeight * 0.5);
      let pageUnderCenter: number | null = null;
      verticalCanvasRefs.current.forEach((canvas, pageNum) => {
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        if (rect.top <= centerY && rect.bottom >= centerY) {
          pageUnderCenter = pageNum;
        }
      });
      let bestPage = pageUnderCenter ?? currentPageRef.current;
      if (pageUnderCenter === null) {
        let bestDist = Infinity;
        verticalCanvasRefs.current.forEach((canvas, pageNum) => {
          if (!canvas) return;
          const rect = canvas.getBoundingClientRect();
          const dist = Math.abs(rect.top - centerY);
          if (dist < bestDist) {
            bestDist = dist;
            bestPage = pageNum;
          }
        });
        if (bestDist === Infinity) {
          const fromDom = document.querySelectorAll("canvas[data-page]");
          fromDom.forEach((el) => {
            const rect = (el as HTMLCanvasElement).getBoundingClientRect();
            const dist = Math.abs(rect.top - centerY);
            if (dist < bestDist) {
              bestDist = dist;
              const attr = (el as HTMLCanvasElement).getAttribute("data-page");
              const num = attr ? Number(attr) : NaN;
              if (!isNaN(num)) bestPage = num;
            }
          });
        }
      }
      if (bestPage !== currentPageRef.current) {
        log(`[updateFromScroll] 页码更新: ${currentPageRef.current} -> ${bestPage}`);
        setCurrentPage(bestPage);
        if (book) {
          bookService.updateBookProgress(book.id!, bestPage).catch(() => {});
        }
      }

      // 计算当前页阅读进度和对应的目录节点
      const canvas = verticalCanvasRefs.current.get(bestPage);
      if (canvas && activeContainer) {
        const rect = canvas.getBoundingClientRect();
        // 计算视口中心在页面中的相对位置作为进度
        let progress = (centerY - rect.top) / rect.height;
        progress = Math.max(0, Math.min(1, progress));
        
        const isPageFullyVisible = rect.height <= activeContainer.clientHeight;
        const sig = findActiveNodeSignature(bestPage, progress, isPageFullyVisible, toc);
        setActiveNodeSignature(sig || undefined);
      }
    };

    const onScroll = () => {
      if (verticalScrollRafRef.current !== null) return;
      verticalScrollRafRef.current = requestAnimationFrame(updateFromScroll);
    };
    // 同时监听内层容器、外层容器与窗口滚动，避免滚动目标在加载过程发生切换时监听失效
    if (vs) {
      vs.addEventListener("scroll", onScroll, { passive: true });
    }
    if (mv) {
      mv.addEventListener("scroll", onScroll, { passive: true });
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    // 初次挂载后立即计算一次，保证进入后不滑动也同步当前页
    updateFromScroll();
    return () => {
      if (vs) {
        vs.removeEventListener("scroll", onScroll);
      }
      if (mv) {
        mv.removeEventListener("scroll", onScroll);
      }
      window.removeEventListener("scroll", onScroll);
      if (verticalScrollRafRef.current !== null) {
        cancelAnimationFrame(verticalScrollRafRef.current);
        verticalScrollRafRef.current = null;
      }
    };
  }, [readingMode, book, isSeeking, totalPages, loading, toc, isDomRender]);

  // DOM 渲染模式（Markdown）滚动监听：计算虚拟页码和进度
  useEffect(() => {
    if (!isDomRender || loading || !book) return;
    
    const renderer = rendererRef.current;
    if (!renderer || !(renderer instanceof MarkdownRenderer)) return;
    
    // 延迟绑定，确保 md-editor-rt 渲染完成
    let cleanup: (() => void) | null = null;
    let attempts = 0;
    const maxAttempts = 10;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    
    const setupScrollListener = (): (() => void) | null => {
      const scrollContainer = renderer.getScrollContainer();
      if (!scrollContainer) return null;
      
      // 检查内容是否已渲染（scrollHeight > clientHeight 表示有可滚动内容）
      if (scrollContainer.scrollHeight <= scrollContainer.clientHeight + 10) {
        // 内容可能还未渲染完成，继续等待
        return null;
      }
      
      let rafId: number | null = null;
      let lastPage = currentPage;
      let lastTotalPages = totalPages;
      
      const handleScroll = () => {
        if (rafId !== null) return;
        rafId = requestAnimationFrame(() => {
          rafId = null;
          const viewportHeight = scrollContainer.clientHeight;
          if (viewportHeight <= 0) return;
          
          // 再次检查内容高度，防止在渲染未完成或被清空时错误计算
          if (scrollContainer.scrollHeight <= viewportHeight + 10) return;

          const virtualTotalPages = renderer.calculateVirtualPages(viewportHeight);
          const virtualCurrentPage = renderer.getCurrentVirtualPage(scrollContainer.scrollTop, viewportHeight);          
          // 更新总页数（仅当页数大于1时更新，避免初始状态异常）
          if (virtualTotalPages !== totalPages && virtualTotalPages > 1) {
            setTotalPages(virtualTotalPages);
            if (book && virtualTotalPages !== lastTotalPages) {
              lastTotalPages = virtualTotalPages;
              bookService.updateBookTotalPages(book.id!, virtualTotalPages).catch(() => {});
            }
          }
          
          const canUpdatePage = (
            scrollContainer.scrollTop > 0 || savedPageAtOpenRef.current === 1 || domRestoreDoneRef.current
          );
          if (canUpdatePage && virtualCurrentPage !== lastPage) {
            lastPage = virtualCurrentPage;
            setCurrentPage(virtualCurrentPage);
            if (book) {
              bookService.updateBookProgress(book.id!, virtualCurrentPage).catch(() => {});
            }
          }

          // 计算 Markdown 目录高亮
          try {
            const centerY = scrollContainer.scrollTop + (scrollContainer.clientHeight * 0.5);
            const headings = Array.from(scrollContainer.querySelectorAll('h1,h2,h3,h4,h5,h6')) as HTMLElement[];
            if (headings.length > 0) {
              let bestIdx = 0;
              let bestDist = Infinity;
              for (let i = 0; i < headings.length; i++) {
                const h = headings[i];
                const top = h.offsetTop;
                const bottom = top + h.offsetHeight;
                const dist = (centerY >= top && centerY <= bottom) ? 0 : Math.min(Math.abs(centerY - top), Math.abs(centerY - bottom));
                if (dist < bestDist) { bestDist = dist; bestIdx = i; }
              }
              const anchor = `heading-${bestIdx}`;
              const findByAnchor = (nodes: TocNode[], level: number): { title: string; level: number } | null => {
                for (const n of nodes) {
                  if (n.anchor === anchor) return { title: n.title, level };
                  if (n.children) {
                    const r = findByAnchor(n.children, level + 1);
                    if (r) return r;
                  }
                }
                return null;
              };
              const found = findByAnchor(toc, 0);
              if (found) {
                const sig = `${found.title}|-1|${found.level}`;
                if (sig !== activeNodeSignature) setActiveNodeSignature(sig);
              }
            }
          } catch {}
        });
      };
      
      scrollContainer.addEventListener('scroll', handleScroll, { passive: true });
      handleScroll();
      
      return () => {
        scrollContainer.removeEventListener('scroll', handleScroll);
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
        }
      };
    };
    
    const trySetup = () => {
      cleanup = setupScrollListener();
      if (!cleanup && attempts < maxAttempts) {
        attempts++;
        timeoutId = setTimeout(trySetup, 300);
      }
    };
    
    // 初始延迟，等待 React 渲染完成
    timeoutId = setTimeout(trySetup, 500);
    
    return () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (cleanup) cleanup();
    };
  }, [isDomRender, book, loading, totalPages, readingMode]);

  useEffect(() => {
    if (!isDomRender || !book || loading) return;
    const renderer = rendererRef.current;
    if (!renderer || !(renderer instanceof MarkdownRenderer)) return;
    let attempts = 0;
    const maxAttempts = 50;
    const check = () => {
      const sc = renderer.getScrollContainer();
      if (!sc) { schedule(); return; }
      const vh = sc.clientHeight;
      if (vh <= 0) { schedule(); return; }
      const vt = renderer.calculateVirtualPages(vh);
      if (vt > 1 && vt !== totalPages) {
        setTotalPages(vt);
        bookService.updateBookTotalPages(book.id!, vt).catch(() => {});
      } else {
        schedule();
      }
    };
    const schedule = () => { attempts++; if (attempts < maxAttempts) setTimeout(check, 100); };
    setTimeout(check, 150);
  }, [isDomRender, book?.id, loading]);

  

  // 自动滚动：根据阅读模式分别处理（横向自动翻页，纵向持续滚动）
  useEffect(() => {
    const stopAll = () => {
      if (autoScrollTimerRef.current !== null) {
        window.clearInterval(autoScrollTimerRef.current);
        autoScrollTimerRef.current = null;
      }
      if (autoScrollRafRef.current !== null) {
        cancelAnimationFrame(autoScrollRafRef.current);
        autoScrollRafRef.current = null;
      }
    };

    // 当自动滚动关闭，或抽屉打开时，停止自动滚动
    if (!autoScroll || tocOverlayOpen || modeOverlayOpen) {
      stopAll();
      return () => stopAll();
    }

    if (readingMode === "horizontal") {
      // 横向：每隔固定时间翻到下一页，至末页自动停止
      stopAll();
      autoScrollTimerRef.current = window.setInterval(async () => {
        if (currentPage >= totalPages) {
          stopAll();
          setAutoScroll(false);
          return;
        }
        await goToPage(currentPage + 1);
      }, AUTO_PAGE_INTERVAL_MS);
    } else {
      // 纵向或 DOM 渲染模式：持续向下滚动
      stopAll();
      const speed = settings.scrollSpeed || DEFAULT_SCROLL_SPEED_PX_PER_SEC;

      const r = rendererRef.current;
      if (isDomRender && r && r instanceof EpubRenderer) {
        const step = () => {
          if (!autoScroll || tocOverlayOpen || modeOverlayOpen) {
            stopAll();
            return;
          }
          r.scrollBy(speed / 60);
          autoScrollRafRef.current = requestAnimationFrame(step);
        };
        autoScrollRafRef.current = requestAnimationFrame(step);
      } else {
        let el: HTMLElement | null = null;
        if (isDomRender) {
          if (r && r instanceof MarkdownRenderer) {
            el = r.getScrollContainer();
          }
          if (!el) el = domContainerRef.current;
        } else {
          el = verticalScrollRef.current || mainViewRef.current;
        }
        if (!el) return () => stopAll();
        const step = () => {
          if (!autoScroll || tocOverlayOpen || modeOverlayOpen) {
            stopAll();
            return;
          }
          const atBottom = el!.scrollTop + el!.clientHeight >= el!.scrollHeight - 2;
          if (atBottom) {
            stopAll();
            setAutoScroll(false);
            return;
          }
          el!.scrollTop = el!.scrollTop + speed / 60;
          autoScrollRafRef.current = requestAnimationFrame(step);
        };
        autoScrollRafRef.current = requestAnimationFrame(step);
      }
    }

    return () => stopAll();
  }, [
    autoScroll,
    readingMode,
    isDomRender,
    currentPage,
    totalPages,
    tocOverlayOpen,
    modeOverlayOpen,
    settings.scrollSpeed,
  ]);

  // 键盘：音量键翻页（部分平台支持），开启后生效
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!settings.volumeKeyTurnPage) return;
      const code = e.code || e.key;
      if (code === "AudioVolumeUp" || code === "VolumeUp") {
        e.preventDefault();
        prevPage();
      } else if (code === "AudioVolumeDown" || code === "VolumeDown") {
        e.preventDefault();
        nextPage();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [settings.volumeKeyTurnPage, currentPage]);

  // 通过 statusBarService 应用状态栏设置（支持 Tauri 移动端 + 浏览器降级）
  // 仅在阅读页面根据用户设置隐藏状态栏
  // 离开阅读页面时，始终恢复状态栏显示
  useEffect(() => {
    // 进入阅读页面或设置变更时应用设置
    statusBarService.applySettings(settings.showStatusBar);
    
    // 清理：离开阅读页面时始终显示状态栏
    return () => {
      statusBarService.showStatusBar();
    };
  }, [settings.showStatusBar]);



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
        加载中...
      </div>
    );
  }

  return (
    <div
      className="reader-fullheight"
      style={{
        display: "flex",
        flexDirection: "column",
        backgroundColor: "#2c2c2c",
        paddingTop: settings.showStatusBar ? getSafeAreaInsets().top : 0,
      }}
    >
      {/* 主体区域：仅中间渲染区（目录改为蒙版弹层） */}
      <div
        style={{
          flex: 1,
          display: "flex",
          overflow: "hidden",
        }}
      >
        {/* 中间渲染区 */}
        <div
          onClick={(e) => {
            const rect = (
              e.currentTarget as HTMLDivElement
            ).getBoundingClientRect();
            const x = e.clientX - rect.left;
            
            // 所有格式统一走 App 控件的点击翻页逻辑
            if (readingMode === "horizontal") {
              if (x < rect.width * 0.3) {
                if (settings.clickTurnPage) prevPage();
              } else if (x > rect.width * 0.7) {
                if (settings.clickTurnPage) nextPage();
              } else {
                // 中间点击：自动滚动时仅停止，不弹出扩展器；非自动滚动时切换UI显隐
                if (autoScroll) {
                  setAutoScroll(false);
                } else {
                  setUiVisible((v) => !v);
                }
              }
            } else {
              // 纵向模式：自动滚动时仅停止，不弹出扩展器；非自动滚动时切换UI显隐
              if (autoScroll) {
                setAutoScroll(false);
              } else {
                setUiVisible((v) => !v);
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
              ref={domContainerRef}
              className="no-scrollbar"
              style={{
                // EPUB 使用绝对定位确保占满整个父容器（避免 flexbox alignItems:center 影响布局）
                ...(book?.file_path && getBookFormat(book.file_path) === 'epub' ? {
                  position: 'absolute' as const,
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                } : {
                  width: "100%",
                  height: "100%",
                }),
                // EPUB 由 foliate-view 内部管理，不需要外层滚动
                overflowY: (book?.file_path && getBookFormat(book.file_path) === 'epub') ? 'hidden' : 'auto',
                // EPUB 使用白色背景，其他格式使用深色
                backgroundColor: (book?.file_path && getBookFormat(book.file_path) === 'epub') ? '#ffffff' : '#1a1a1a',
                pointerEvents: 'auto',
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
                backgroundColor: loading ? "#2a2a2a" : "transparent",
              }}
            />
          ) : (
            <div
              style={{ width: "100%", maxHeight: "100%", overflowY: "auto" }}
              className="no-scrollbar"
              ref={verticalScrollRef}
            >
              {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                <canvas
                  key={`${bookId}-${p}`}
                  data-page={p}
                  ref={(el) => {
                    if (el) {
                      verticalCanvasRefs.current.set(p, el);
                      // 设置初始高度，避免黑屏
                      if (el.height === 0) {
                        el.height = 800; // 临时高度，渲染后会更新
                      }
                    }
                  }}
                  style={{
                    width: "100%",
                    minHeight: "600px", // 设置最小高度，确保 IntersectionObserver 能触发
                    display: "block",
                    margin: `0 auto ${settings.pageGap}px`,
                    boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
                    backgroundColor: "#2a2a2a", // 添加背景色，避免完全黑屏
                  }}
                />
              ))}
            </div>
          )}

        </div>
      </div>
      <TopBar
        visible={(uiVisible || isSeeking) && !moreDrawerOpen && !tocOverlayOpen && !modeOverlayOpen}
        bookTitle={book?.title}
        isFinished={book?.status === 1}
        onToggleFinish={toggleFinish}
        onBack={() => {
          if (window.history.length > 1) {
            nav.goBack();
          } else {
            nav.toBookshelf('recent', { replace: true });
          }
        }}
      />
      {/* 顶部页码气泡：贴紧顶部栏最左侧下方，顶部栏可见时下移；不因"显示状态栏"而强制显示 */}
      {(uiVisible || isSeeking) && !moreDrawerOpen && !tocOverlayOpen && !modeOverlayOpen &&
        (() => {
          const toolbarVisible = uiVisible || isSeeking;          const baseOffsetPx = toolbarVisible ? 72 : 14;
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
                // 顶部覆盖层已满宽，严格对齐其左内边距（含安全区）
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
                {isSeeking && seekPage !== null ? seekPage : currentPage} /{" "}
                {totalPages}
              </div>
            </div>
          );
        })()}

      <TocOverlay
        visible={tocOverlayOpen}
        toc={toc}
        bookmarks={bookmarks}
        activeSignature={activeNodeSignature}
        onClose={() => {
          setTocOverlayOpen(false);
          setUiVisible(false);
        }}
        onGoToPage={(page, anchor) => {
          const isEpub = book?.file_path && getBookFormat(book.file_path) === 'epub';
          
          // 支持锚点跳转
          if (anchor && isDomRender && rendererRef.current) {
            if (isEpub) {
              // EPUB 格式：调用 goToHref
              (rendererRef.current as any).goToHref?.(anchor);
            } else {
              // Markdown 等格式：调用 scrollToAnchor
              (rendererRef.current as any).scrollToAnchor?.(anchor);
            }
          } else if (typeof page === 'number') {
            goToPage(page);
          }
          setTocOverlayOpen(false);
          setUiVisible(false);
        }}
        onDeleteBookmark={deleteBookmark}
        setToc={setToc}
      />

      <ModeOverlay
        visible={modeOverlayOpen}
        readingMode={readingMode}
        onClose={() => {
          setModeOverlayOpen(false);
          setUiVisible(false);
        }}
        onChangeMode={(mode) => {
          setReadingMode(mode);
          setSettings((prev) => {
            const next = {
              ...prev,
              readingMode: mode,
            } as ReaderSettings;
            saveReaderSettings({ readingMode: mode });
            return next;
          });
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
        autoScroll={autoScroll}
        tocOverlayOpen={tocOverlayOpen}
        modeOverlayOpen={modeOverlayOpen}
        moreDrawerOpen={moreDrawerOpen}
        onSeekStart={() => {
          setIsSeeking(true);
          lastSeekTsRef.current = Date.now();
        }}
        onSeekChange={(v) => {
          setSeekPage(v);
          lastSeekTsRef.current = Date.now();
        }}
        onSeekEnd={async (v) => {
          setSeekPage(null);
          setIsSeeking(false);
          lastSeekTsRef.current = 0;
          await goToPage(v);
        }}
        onPrevChapter={() => {
          const page = findCurrentChapterPage(toc);
          if (typeof page === "number" && page < currentPage) {
            goToPage(page);
          } else {
            prevPage();
          }
        }}
        onNextChapter={() => {
          const pages: number[] = [];
          const collect = (ns: TocNode[]) => {
            for (const n of ns) {
              if (typeof n.page === "number") pages.push(n.page);
              if (n.children && n.children.length)
                collect(n.children);
            }
          };
          collect(toc);
          pages.sort((a, b) => a - b);
          const target = pages.find((p) => p > currentPage);
          if (typeof target === "number") {
            goToPage(target);
          } else {
            nextPage();
          }
        }}
        onToggleToc={() => setTocOverlayOpen(true)}
        onToggleMode={() => setModeOverlayOpen(true)}
        onToggleAutoScroll={() => {
          if (!autoScroll) {
            setAutoScroll(true);
            setUiVisible(false);
          } else {
            setAutoScroll(false);
          }
        }}
        onAddBookmark={addBookmark}
        onOpenMore={() => setMoreDrawerOpen(true)}
      />
      <MoreDrawer
        visible={moreDrawerOpen}
        onClose={() => {
          setMoreDrawerOpen(false);
          setUiVisible(false);
        }}
        onCapture={handleCapture}
        onSettings={() => {
          setMoreDrawerOpen(false);
          nav.toSettings();
        }}
      />
      <CropOverlay
        visible={cropMode}
        capturedImage={capturedImage}
        onClose={() => {
          setCropMode(false);
          setCapturedImage(null);
          setUiVisible(false);
        }}
        onSaveSuccess={() => {
          setBookmarkToastText("保存成功");
          setBookmarkToastVisible(true);
          setTimeout(() => setBookmarkToastVisible(false), TOAST_DURATION_LONG_MS);
        }}
        onSaveError={(msg) => {
          // 移除可能存在的 "Error: " 前缀，使提示更友好
          const cleanMsg = msg.replace(/^Error:\s*/i, '');
          setBookmarkToastText(`保存失败: ${cleanMsg}`);
          setBookmarkToastVisible(true);
          setTimeout(() => setBookmarkToastVisible(false), TOAST_DURATION_ERROR_MS);
        }}
      />
      
      {/* 全局 Toast 提示 */}
      {bookmarkToastVisible && (
        <div
          style={{
            position: "fixed",
            bottom: "80px",
            left: "50%",
            transform: "translateX(-50%)",
            padding: "8px 16px",
            borderRadius: "20px",
            backgroundColor: "rgba(0,0,0,0.8)",
            color: "#fff",
            fontSize: "14px",
            boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
            pointerEvents: "none",
            zIndex: 2000,
            animation: "fadeIn 0.2s ease-out",
          }}
        >
          {bookmarkToastText}
        </div>
      )}
    </div>
  );
};

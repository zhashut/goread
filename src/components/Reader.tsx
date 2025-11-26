import React, { useState, useEffect, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { IBook, IBookmark } from "../types";
import {
  bookService,
  bookmarkService,
  getReaderSettings,
  saveReaderSettings,
  ReaderSettings,
} from "../services";
import {
  PageCacheManager,
} from "../utils/pdfOptimization";
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
import { TopBar } from "./reader/TopBar";
import { BottomBar } from "./reader/BottomBar";
import { TocOverlay } from "./reader/TocOverlay";
import { ModeOverlay } from "./reader/ModeOverlay";
import { MoreDrawer } from "./reader/MoreDrawer";
import { CropOverlay } from "./reader/CropOverlay";
import { TocNode } from "./reader/types";

export const Reader: React.FC = () => {
  const { bookId } = useParams<{ bookId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
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
  const lastSeekTsRef = useRef<number>(0);
  const renderedPagesRef = useRef<Set<number>>(new Set());
  const verticalScrollRef = useRef<HTMLDivElement>(null);
  const verticalScrollRafRef = useRef<number | null>(null);
  // 预加载防抖定时器
  const preloadTimerRef = useRef<any>(null);
  // 优化工具实例
  const pageCacheRef = useRef<PageCacheManager>(new PageCacheManager(PAGE_CACHE_SIZE, PAGE_CACHE_MEMORY_LIMIT_MB));
  // 预加载图片资源缓存（显式管理 ImageBitmap，确保 App 端缓存有效性）
  const preloadedBitmapsRef = useRef<Map<number, ImageBitmap>>(new Map());
  // 预加载任务队列（Promise 复用，防止重复请求）
  const preloadingTasksRef = useRef<Map<number, Promise<ImageBitmap>>>(new Map());
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

  const handleCapture = async () => {
    let dataUrl = "";
    try {
      const dpr = getCurrentScale();
      if (readingMode === "horizontal") {
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
            verticalCanvasRefs.current.forEach((vCanvas, page) => {
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

  useEffect(() => {
    // 切换书籍时，清理所有状态和缓存
    pageCacheRef.current.clear();
    // 清理预加载的 Bitmap 资源
    preloadedBitmapsRef.current.forEach(bmp => bmp.close && bmp.close());
    preloadedBitmapsRef.current.clear();
    preloadingTasksRef.current.clear();
    
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
  }, [currentPage]);

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
    // 1. 内存缓存命中
    if (preloadedBitmapsRef.current.has(pageNum)) {
      return preloadedBitmapsRef.current.get(pageNum)!;
    }
    // 2. 任务复用命中
    if (preloadingTasksRef.current.has(pageNum)) {
      return preloadingTasksRef.current.get(pageNum)!;
    }

    // 3. 发起新任务
    const task = (async () => {
      try {
        const { getInvoke } = await import("../services/index");
        const invoke = await getInvoke();
        const viewW = canvasRef.current?.parentElement?.clientWidth || mainViewRef.current?.clientWidth || 800;
        
        // 使用与 getCurrentScale 一致的逻辑获取 DPR
        const dpr = getCurrentScale();
        const containerWidth = Math.min(4096, Math.floor(viewW * dpr));

        const renderStartTime = performance.now();
        const filePath: string = await invoke('pdf_render_page_to_file', {
          filePath: book!.file_path,
          pageNumber: pageNum,
          quality: settings.renderQuality || 'standard',
          width: containerWidth,
          height: null,
        });
        const renderEndTime = performance.now();
        log(`[loadPageBitmap] 页面 ${pageNum} 后端渲染耗时: ${Math.round(renderEndTime - renderStartTime)}ms`);
        
        const decodeStartTime = performance.now();
        let bitmap: ImageBitmap;
        try {
          const imageUrl = convertFileSrc(filePath);
          const response = await fetch(imageUrl);
          const blob = await response.blob();
          bitmap = await createImageBitmap(blob);
        } catch (eAsset) {
          try {
            const dataUrl: string = await invoke('pdf_render_page_base64', {
              filePath: book!.file_path,
              pageNumber: pageNum,
              quality: settings.renderQuality || 'standard',
              width: containerWidth,
              height: null,
            });
            const resp2 = await fetch(dataUrl);
            const blob2 = await resp2.blob();
            bitmap = await createImageBitmap(blob2);
          } catch (e2) {
            const imageUrl = convertFileSrc(filePath);
            const img = await new Promise<HTMLImageElement>((resolve, reject) => {
              const im = new Image();
              im.onload = () => resolve(im);
              im.onerror = (err) => reject(err);
              im.src = imageUrl;
            });
            bitmap = await createImageBitmap(img);
          }
        }
        const decodeEndTime = performance.now();
        log(`[loadPageBitmap] 页面 ${pageNum} 图片解码耗时: ${Math.round(decodeEndTime - decodeStartTime)}ms`);
        
        // 存入缓存
        preloadedBitmapsRef.current.set(pageNum, bitmap);
        return bitmap;
      } finally {
        // 任务完成（无论成功失败），从队列移除
        preloadingTasksRef.current.delete(pageNum);
      }
    })();

    preloadingTasksRef.current.set(pageNum, task);
    return task;
  };

  const loadBook = async () => {
    try {
      setLoading(true);
      const books = await bookService.getAllBooks();
      const targetBook = books.find((b) => b.id === parseInt(bookId!));

      if (!targetBook) {
        alert("书籍不存在");
        navigate("/");
        return;
      }

      setBook(targetBook);
      setCurrentPage(targetBook.current_page);
      setTotalPages(targetBook.total_pages);

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

      const { getInvoke } = await import("../services/index");
      const invoke = await getInvoke();
      const infoResp = await invoke('pdf_load_document', { filePath: targetBook.file_path });
      const pageCount = Math.max(1, Number(infoResp?.info?.page_count ?? targetBook.total_pages ?? 1));
      
      setTotalPages(pageCount);
      setLoading(false);

      // 不在这里直接渲染，而是通过 useEffect 监听 loading 状态变化后再渲染
      // 这样可以确保 DOM 已经准备好
      
      // 后台加载目录和书签（不阻塞首屏显示）
      // 加载目录（Outline）——保留层级结构，支持字符串/数组 dest
      Promise.resolve().then(async () => {
        try {
          const outlineResp = await invoke('pdf_get_outline', { filePath: targetBook.file_path });
          const outline = outlineResp?.outline?.bookmarks || [];
          const toToc = (nodes: any[], level = 0): TocNode[] => {
            return (nodes || []).map((n: any) => ({
              title: n.title || '无标题',
              page: n.page_number || undefined,
              children: toToc(n.children || [], level + 1),
              expanded: level === 0,
            }));
          };
          const parsed = toToc(outline, 0);
          if (parsed.length > 0) {
            setToc(parsed);
          } else {
            try {
              const infoResp2 = await invoke('pdf_get_document_info', { filePath: targetBook.file_path });
              const pages = Number(infoResp2?.info?.page_count || 0);
              if (pages > 0) {
                setToc([{ title: targetBook.title || '目录', page: 1, children: [], expanded: true }]);
              } else {
                setToc([]);
              }
            } catch {
              setToc([]);
            }
          }
        } catch (e) {
          try {
            const { logError } = await import("../services/index");
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
      console.error("Failed to load book:", error);
      alert("加载书籍失败");
    }
  };

  

  const renderPage = async (pageNum: number, forceRender: boolean = false) => {
    if (!book || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const context = canvas.getContext("2d");
    if (!context) return;
    const localModeVer = modeVersionRef.current;

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
          if (preloadedBitmapsRef.current.has(pageNum)) {
            preloadedBitmapsRef.current.delete(pageNum);
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
    
    // 预加载下两页，确保连续翻页流畅
    const pagesToPreload = [currentPageNum + 1, currentPageNum + 2];
    // 获取当前 Scale，确保检查缓存的 Key 与渲染时一致
    const scale = getCurrentScale();
    
    for (const nextPage of pagesToPreload) {
      if (nextPage <= totalPages) {
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
    if (readingMode === "horizontal") {
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

  // 根据当前位置生成书签标题：优先使用章节标题，否则使用“第 X 页”
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

      const { getInvoke } = await import("../services/index");
      const invoke = await getInvoke();

      const renderStartTime = performance.now();
      const filePath: string = await invoke('pdf_render_page_to_file', {
        filePath: book.file_path,
        pageNumber: pageNum,
        quality: settings.renderQuality || 'standard',
        width: containerWidth,
        height: null,
      });
      const renderEndTime = performance.now();
      log(`[renderPageToTarget] 页面 ${pageNum} 后端渲染耗时: ${Math.round(renderEndTime - renderStartTime)}ms`);
      
      const decodeStartTime = performance.now();
      let img: any;
      try {
        const imageUrl = convertFileSrc(filePath);
        const response = await fetch(imageUrl);
        const blob = await response.blob();
        img = await createImageBitmap(blob);
      } catch (eAsset) {
        try {
          const dataUrl: string = await invoke('pdf_render_page_base64', {
            filePath: book.file_path,
            pageNumber: pageNum,
            quality: settings.renderQuality || 'standard',
            width: containerWidth,
            height: null,
          });
          const resp2 = await fetch(dataUrl);
          const blob2 = await resp2.blob();
          img = await createImageBitmap(blob2);
        } catch (e2) {
          const imageUrl = convertFileSrc(filePath);
          const im = await new Promise<HTMLImageElement>((resolve, reject) => {
            const ii = new Image();
            ii.onload = () => resolve(ii);
            ii.onerror = (err) => reject(err);
            ii.src = imageUrl;
          });
          img = im;
        }
      }
      const decodeEndTime = performance.now();
      log(`[renderPageToTarget] 页面 ${pageNum} 图片解码耗时: ${Math.round(decodeEndTime - decodeStartTime)}ms`);

      if (localModeVer !== modeVersionRef.current) {
        return;
      }
      if (readingMode !== "vertical") {
        return;
      }
      if (!document.contains(canvas)) {
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
    if (verticalScrollRafRef.current !== null) {
      cancelAnimationFrame(verticalScrollRafRef.current);
      verticalScrollRafRef.current = null;
    }
  }, [readingMode]);

  // 首次加载完成后，立即渲染当前页（横向和纵向模式）
  useEffect(() => {
    if (loading || !book || totalPages === 0) return;
    
    log(`[Reader] 开始首次渲染，模式: ${readingMode}, 当前页: ${currentPage}`);
    
    const renderInitial = async () => {
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
  }, [loading, book, totalPages, readingMode]);

  // 纵向模式：滚动时动态更新当前页（以视口中心线为准；不进行程序化对齐）
  useEffect(() => {
    if (loading) return;
    if (readingMode !== "vertical") return;
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
  }, [readingMode, book, isSeeking, totalPages, loading]);

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
      // 纵向：持续向下滚动
      stopAll();
      const el = verticalScrollRef.current || mainViewRef.current;
      if (!el) return () => stopAll();
      const speed = settings.scrollSpeed || DEFAULT_SCROLL_SPEED_PX_PER_SEC;
      const step = () => {
        if (!autoScroll || tocOverlayOpen || modeOverlayOpen) {
          stopAll();
          return;
        }
        const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
        if (atBottom) {
          stopAll();
          setAutoScroll(false);
          return;
        }
        el.scrollTop = el.scrollTop + speed / 60; // 约 60fps
        autoScrollRafRef.current = requestAnimationFrame(step);
      };
      autoScrollRafRef.current = requestAnimationFrame(step);
    }

    return () => stopAll();
  }, [
    autoScroll,
    readingMode,
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

  // 根据设置显示/隐藏系统状态栏：通过浏览器全屏控制（受平台限制）
  useEffect(() => {
    const hideStatusBar = !settings.showStatusBar;
    const ua = navigator.userAgent || "";
    const isMobile = /Android|iPhone|iPad|iPod/i.test(ua);
    const isTauri = typeof (window as any).__TAURI__ !== "undefined";

    // 仅在移动端浏览器或移动端容器中尝试全屏；桌面 Tauri/Web 不触发以避免窗口被最大化
    if (!isMobile || isTauri) return;

    if (hideStatusBar) {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen?.().catch(() => {});
      }
    } else {
      if (document.fullscreenElement) {
        document.exitFullscreen?.().catch(() => {});
      }
    }
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
        paddingTop: settings.showStatusBar ? "env(safe-area-inset-top)" : 0,
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
          {readingMode === "horizontal" ? (
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
        visible={(uiVisible || isSeeking || tocOverlayOpen) && !moreDrawerOpen}
        bookTitle={book?.title}
        onBack={() => {
          const state: any = location.state || {};
          if (typeof state.fromGroupId === "number") {
            navigate(`/?tab=all&group=${state.fromGroupId}`);
          } else if (state.fromTab === "all") {
            navigate("/?tab=all");
          } else if (state.fromTab === "recent") {
            navigate("/");
          } else if (window.history.length > 1) {
            navigate(-1);
          } else {
            navigate("/");
          }
        }}
      />
      {/* 顶部页码气泡：贴紧顶部栏最左侧下方，顶部栏可见时下移；不因“显示状态栏”而强制显示 */}
      {(uiVisible || isSeeking) && !moreDrawerOpen &&
        (() => {
          const toolbarVisible = uiVisible || isSeeking || tocOverlayOpen;
          const baseOffsetPx = toolbarVisible ? 72 : 14;
          const safeInset = settings.showStatusBar
            ? "env(safe-area-inset-top)"
            : "0px";
          return (
            <div
              style={{
                position: "fixed",
                top: `calc(${safeInset} + ${baseOffsetPx}px)`,
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
        currentChapterPage={currentChapterPageVal}
        onClose={() => {
          setTocOverlayOpen(false);
          setUiVisible(false);
        }}
        onGoToPage={(page) => {
          goToPage(page);
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
          navigate("/settings");
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
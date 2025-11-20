import React, { useState, useEffect, useRef } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { IBook, IBookmark } from "../types";
// @ts-ignore
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  bookService,
  bookmarkService,
  getReaderSettings,
  saveReaderSettings,
  ReaderSettings,
} from "../services";
import {
  PageCacheManager,
  ProgressiveRenderer,
  PagePreloader,
  WorkerPool,
  SmartPredictor,
  MemoryOptimizer,
} from "../utils/pdfOptimization";

export const Reader: React.FC = () => {
  const { bookId } = useParams<{ bookId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [book, setBook] = useState<IBook | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [pdf, setPdf] = useState<any>(null);
  const [bookmarks, setBookmarks] = useState<IBookmark[]>([]);
  type TocNode = {
    title: string;
    page?: number;
    children?: TocNode[];
    expanded?: boolean;
  };
  const [toc, setToc] = useState<TocNode[]>([]);
  const tocItemRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  // UI 可见与进度滑动状态
  const [uiVisible, setUiVisible] = useState(false);
  const [isSeeking, setIsSeeking] = useState(false);
  const [seekPage, setSeekPage] = useState<number | null>(null);
  const [leftTab, setLeftTab] = useState<"toc" | "bookmark">("toc");
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
  const DEFAULT_AUTO_PAGE_MS = 2000; // 横向自动翻页间隔
  const DEFAULT_SCROLL_PX_PER_SEC = 120; // 纵向每秒滚动像素
  // 阅读方式选择弹层
  const [modeOverlayOpen, setModeOverlayOpen] = useState(false);
  // 纵向阅读容器与懒加载渲染引用
  const mainViewRef = useRef<HTMLDivElement>(null);
  const verticalCanvasRefs = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const renderedPagesRef = useRef<Set<number>>(new Set());
  const verticalScrollRef = useRef<HTMLDivElement>(null);
  const verticalScrollRafRef = useRef<number | null>(null);
  const verticalInitFramesRef = useRef<number>(0);
  const verticalInitRafRef = useRef<number | null>(null);
  // 优化工具实例
  const pageCacheRef = useRef<PageCacheManager>(new PageCacheManager(50, 200));
  const progressiveRendererRef = useRef<ProgressiveRenderer>(new ProgressiveRenderer());
  const preloaderRef = useRef<PagePreloader>(new PagePreloader(3));
  const workerPoolRef = useRef<WorkerPool>(new WorkerPool());
  const smartPredictorRef = useRef<SmartPredictor>(new SmartPredictor());
  const memoryOptimizerRef = useRef<MemoryOptimizer>(new MemoryOptimizer(200));
  // 书签提示气泡
  const [bookmarkToastVisible, setBookmarkToastVisible] = useState(false);
  const [bookmarkToastText, setBookmarkToastText] = useState("");
  // 设置：本地持久化
  const [settings, setSettings] = useState<ReaderSettings>(getReaderSettings());
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
    loadBook();
    
    // 启动内存自动清理
    const memoryOptimizer = memoryOptimizerRef.current;
    
    // 注册缓存清理回调
    memoryOptimizer.registerCleanupCallback(() => {
      // 清理最旧的缓存项
      const cache = pageCacheRef.current;
      const stats = cache.getStats();
      if (stats.size > 30) {
        // 保留最近30页的缓存
        cache.clear();
      }
    });
    
    // 启动自动内存清理（每30秒检查一次）
    const stopAutoCleanup = memoryOptimizer.startAutoCleanup(30000);
    
    // 清理函数：组件卸载或切换书籍时清理缓存
    return () => {
      pageCacheRef.current.clear();
      preloaderRef.current.stop();
      smartPredictorRef.current.clear();
      stopAutoCleanup();
      memoryOptimizer.destroy();
    };
  }, [bookId]);

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
      } catch (e) {
        console.warn("标记书籍已打开失败", e);
      }

      // 加载PDF文件
      // 使用 Rust 后端命令读取文件，因为 @tauri-apps/plugin-fs 有安全限制
      const { getInvoke } = await import("../services/index");
      const invoke = await getInvoke();
      const fileData = await invoke('read_file_bytes', { path: targetBook.file_path });

      const pdfjs = await import("pdfjs-dist");
      // 设置 workerSrc，避免 "No GlobalWorkerOptions.workerSrc specified" 报错
      (pdfjs as any).GlobalWorkerOptions.workerSrc = workerUrl;
      
      // 优化的PDF加载配置
      const loadingTask = (pdfjs as any).getDocument({
        data: fileData,
        // 启用Worker以提升性能
        useWorkerFetch: false,
        isEvalSupported: false,
        // 优化内存使用
        maxImageSize: 16777216, // 16MB
        // 禁用字体缓存以减少内存
        disableFontFace: false,
        // 启用范围请求优化（虽然我们用的是data，但设置不会有害）
        rangeChunkSize: 65536, // 64KB
      });
      
      const loadedPdf = await loadingTask.promise;
      setPdf(loadedPdf);

      // 渲染当前页面（仅在横向模式下立即渲染；纵向模式交由懒加载）
      if (readingMode === "horizontal") {
        await renderPage(targetBook.current_page, loadedPdf);
      }
      
      // 后台加载目录和书签（不阻塞首屏显示）
      // 加载目录（Outline）——保留层级结构，支持字符串/数组 dest
      setTimeout(async () => {
        try {
          const outline = await loadedPdf.getOutline();
            const resolvePage = async (node: any): Promise<number | undefined> => {
              const key = node?.dest || node?.a?.dest;
              try {
                if (!key) return undefined;
                if (Array.isArray(key)) {
                  const ref = key[0];
                  if (ref) return (await loadedPdf.getPageIndex(ref)) + 1;
                }
                if (typeof key === "string") {
                  const dest = await loadedPdf.getDestination(key);
                  const ref = dest && dest[0];
                  if (ref) return (await loadedPdf.getPageIndex(ref)) + 1;
                }
              } catch (e) {
                console.warn("解析目录目标失败", e);
              }
              return undefined;
            };
            const parseNodes = async (
              nodes: any[] | undefined,
              level = 0
            ): Promise<TocNode[]> => {
              if (!nodes || !Array.isArray(nodes)) return [];
              const result: TocNode[] = [];
              for (const n of nodes) {
                const title = n?.title || "无标题";
                const page = await resolvePage(n);
                const children = await parseNodes(
                  n?.items || n?.children,
                  level + 1
                );
                result.push({ title, page, children, expanded: level === 0 });
              }
              return result;
            };
            const root = await parseNodes(outline as any[], 0);
            setToc(root || []);
          } catch (e) {
            console.warn("获取PDF目录失败", e);
            setToc([]);
          }
        }, 100);

        // 加载书签
        setTimeout(async () => {
          try {
            const list = await bookmarkService.getBookmarks(targetBook.id);
            setBookmarks(Array.isArray(list) ? list : []);
          } catch (e) {
            console.warn("获取书签失败", e);
            setBookmarks([]);
          }
        }, 100);

        // 缓存预热：在加载完成后才开始预热（避免阻塞首屏）
        if ('requestIdleCallback' in window) {
          requestIdleCallback(() => {
            warmupCache(loadedPdf, targetBook.current_page, targetBook.total_pages);
          }, { timeout: 2000 });
        } else {
          setTimeout(() => {
            warmupCache(loadedPdf, targetBook.current_page, targetBook.total_pages);
          }, 2000);
        }
    } catch (error) {
      console.error("Failed to load book:", error);
      alert("加载书籍失败");
    } finally {
      setLoading(false);
    }
  };

  // 缓存预热：后台预加载常用页面
  const warmupCache = async (pdfDoc: any, currentPageNum: number, total: number) => {
    if (!pdfDoc) return;

    try {
      // 预热策略：只预热前后2页（减少预热数量，加快首屏）
      const pagesToWarmup: number[] = [];
      const start = Math.max(1, currentPageNum - 2);
      const end = Math.min(total, currentPageNum + 2);
      
      for (let i = start; i <= end; i++) {
        if (i !== currentPageNum) { // 当前页已经渲染
          pagesToWarmup.push(i);
        }
      }

      // 逐个预加载（避免一次性占用太多资源）
      for (const pageNum of pagesToWarmup) {
        // 检查是否已缓存
        if (pageCacheRef.current.has(pageNum, 1.0)) {
          continue;
        }

        try {
          const page = await pdfDoc.getPage(pageNum);
          const viewport = page.getViewport({ scale: 1.0 });
          
          // 创建临时canvas
          const tempCanvas = document.createElement('canvas');
          tempCanvas.width = viewport.width;
          tempCanvas.height = viewport.height;
          const tempContext = tempCanvas.getContext('2d');
          
          if (tempContext) {
            await page.render({
              canvasContext: tempContext,
              viewport: viewport,
            }).promise;

            // 缓存
            const imageData = tempContext.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
            pageCacheRef.current.set(pageNum, imageData, tempCanvas.width, tempCanvas.height, 1.0);
          }
        } catch (error) {
          console.warn(`Warmup page ${pageNum} failed:`, error);
        }

        // 每预加载一页后短暂休息，避免阻塞
        await new Promise(resolve => setTimeout(resolve, 150));
      }

      console.log('Cache warmup completed');
    } catch (error) {
      console.warn('Cache warmup failed:', error);
    }
  };

  const renderPage = async (pageNum: number, pdfDoc?: any) => {
    const pdfToUse = pdfDoc || pdf;
    if (!pdfToUse || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const context = canvas.getContext("2d");
    if (!context) return;

    try {
      const scale = 1.0;
      const pageCache = pageCacheRef.current;
      const memoryOptimizer = memoryOptimizerRef.current;

      // 检查缓存
      const cached = pageCache.get(pageNum, scale);
      if (cached) {
        // 使用缓存的页面
        canvas.width = cached.width;
        canvas.height = cached.height;
        
        // 清除之前的内容
        context.clearRect(0, 0, canvas.width, canvas.height);
        
        // 绘制缓存的图像
        context.putImageData(cached.imageData, 0, 0);
        
        // 确保canvas可见
        canvas.style.opacity = "1";
        
        // 注册canvas到内存优化器
        memoryOptimizer.registerCanvas(canvas);
        return;
      }

      // 获取PDF页面
      const page = await pdfToUse.getPage(pageNum);
      const viewport = page.getViewport({ scale });

      // 直接设置canvas尺寸（不使用优化器，避免尺寸不匹配）
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      
      // 注册canvas到内存优化器
      memoryOptimizer.registerCanvas(canvas);

      // 清除canvas内容，确保没有残留
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);

      // 直接渲染（不使用渐进式渲染，避免黑屏问题）
      if (settings.pageTransition) {
        canvas.style.transition = "opacity 200ms ease";
        canvas.style.opacity = "0";
      }

      // 渲染页面
      await page.render({
        canvasContext: context,
        viewport: viewport,
      }).promise;

      if (settings.pageTransition) {
        canvas.style.opacity = "1";
      } else {
        canvas.style.opacity = "1";
      }

      // 缓存渲染结果
      try {
        const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
        pageCache.set(pageNum, imageData, canvas.width, canvas.height, scale);
      } catch (e) {
        console.warn("Failed to cache page:", e);
      }

      // 触发预加载相邻页面
      triggerPreload(pageNum);
    } catch (error) {
      console.error("Failed to render page:", error);
    }
  };

  // 触发预加载相邻页面
  const triggerPreload = (currentPageNum: number) => {
    if (!pdf) return;

    const preloader = preloaderRef.current;
    const smartPredictor = smartPredictorRef.current;
    
    // 记录页面访问，用于智能预测
    smartPredictor.recordPageVisit(currentPageNum);
    
    // 使用智能预测器预测下一步可能访问的页面
    const predictedPages = smartPredictor.predictNextPages(
      currentPageNum,
      totalPages,
      readingMode
    );
    
    // 获取阅读行为分析
    const behavior = smartPredictor.analyzeReadingBehavior();
    
    // 根据预测结果生成预加载任务
    const tasks = predictedPages.map(pageNum => ({
      pageNumber: pageNum,
      priority: smartPredictor.getPriority(pageNum, currentPageNum, behavior),
      scale: 1.0,
    }));

    // 添加任务到队列
    preloader.addTasks(tasks);

    // 开始预加载（非阻塞）
    preloader.startPreload(async (pageNum, scale) => {
      // 检查是否已缓存
      if (pageCacheRef.current.has(pageNum, scale)) {
        return;
      }

      try {
        const page = await pdf.getPage(pageNum);
        
        // 创建临时canvas进行后台渲染
        const tempCanvas = document.createElement('canvas');
        const viewport = page.getViewport({ scale });
        tempCanvas.width = viewport.width;
        tempCanvas.height = viewport.height;
        const tempContext = tempCanvas.getContext('2d');
        
        if (tempContext) {
          await page.render({
            canvasContext: tempContext,
            viewport: viewport,
          }).promise;

          // 缓存渲染结果
          const imageData = tempContext.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
          pageCacheRef.current.set(pageNum, imageData, tempCanvas.width, tempCanvas.height, scale);
        }
      } catch (error) {
        console.warn(`Preload page ${pageNum} failed:`, error);
      }
    }).catch(err => {
      console.warn('Preload error:', err);
    });
  };

  const goToPage = async (pageNum: number) => {
    if (pageNum < 1 || pageNum > totalPages) return;

    setCurrentPage(pageNum);
    if (readingMode === "horizontal") {
      await renderPage(pageNum);
    } else {
      // 纵向模式：滚动到对应页的 canvas
      const target = verticalCanvasRefs.current.get(pageNum);
      if (target) {
        target.scrollIntoView({ behavior: "auto", block: "start" });
      }
      // 若尚未渲染，尝试渲染该页
      if (!renderedPagesRef.current.has(pageNum)) {
        await renderPageToTarget(pageNum, target || null);
      }
      // 触发预加载
      triggerPreload(pageNum);
    }

    // 保存阅读进度
    if (book) {
      await bookService.updateBookProgress(book.id!, pageNum);
    }
  };

  const nextPage = () => goToPage(currentPage + 1);
  const prevPage = () => goToPage(currentPage - 1);

  // 计算当前章节页（<= currentPage 的最大章节页）
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

  // 侧栏自动滚动至当前章节
  useEffect(() => {
    const chapterPage = findCurrentChapterPage(toc);
    if (typeof chapterPage === "number") {
      const el = tocItemRefs.current.get(chapterPage);
      if (el) el.scrollIntoView({ block: "center" });
    }
  }, [currentPage, toc]);

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
      setTimeout(() => setBookmarkToastVisible(false), 1200);
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

  // 将指定页渲染到给定 canvas（用于纵向模式）
  const renderPageToTarget = async (
    pageNum: number,
    canvasEl: HTMLCanvasElement | null
  ) => {
    const pdfToUse = pdf;
    if (!pdfToUse) return;
    
    const canvas = canvasEl || verticalCanvasRefs.current.get(pageNum);
    if (!canvas) return;
    
    const context = canvas.getContext("2d");
    if (!context) return;

    try {
      const page = await pdfToUse.getPage(pageNum);
      const viewport = page.getViewport({ scale: 1.0 });
      const containerWidth = mainViewRef.current?.clientWidth || viewport.width;
      const scale = Math.max(0.5, Math.min(2, containerWidth / viewport.width));
      
      const pageCache = pageCacheRef.current;
      const memoryOptimizer = memoryOptimizerRef.current;

      // 检查缓存
      const cached = pageCache.get(pageNum, scale);
      if (cached) {
        canvas.width = cached.width;
        canvas.height = cached.height;
        
        // 清除之前的内容
        context.clearRect(0, 0, canvas.width, canvas.height);
        
        // 绘制缓存的图像
        context.putImageData(cached.imageData, 0, 0);
        
        // 确保canvas可见
        canvas.style.opacity = "1";
        
        // 注册canvas到内存优化器
        memoryOptimizer.registerCanvas(canvas);
        
        renderedPagesRef.current.add(pageNum);
        return;
      }

      // 渲染页面
      const scaledViewport = page.getViewport({ scale });
      
      // 直接设置canvas尺寸（不使用优化器，避免尺寸不匹配）
      canvas.width = scaledViewport.width;
      canvas.height = scaledViewport.height;
      
      // 注册canvas到内存优化器
      memoryOptimizer.registerCanvas(canvas);
      
      // 清除canvas内容，确保没有残留
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      
      // 确保canvas可见
      canvas.style.opacity = "1";
      
      await page.render({ canvasContext: context, viewport: scaledViewport })
        .promise;
      
      renderedPagesRef.current.add(pageNum);

      // 缓存渲染结果
      try {
        const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
        pageCache.set(pageNum, imageData, canvas.width, canvas.height, scale);
      } catch (e) {
        console.warn("Failed to cache vertical page:", e);
      }
    } catch (error) {
      console.error("Failed to render vertical page:", error);
    }
  };

  // 纵向模式懒加载：在进入可视区域时渲染页面（不在此处更新 currentPage）
  useEffect(() => {
    if (readingMode !== "vertical" || !pdf) return;
    let observer: IntersectionObserver | null = null;

    const rootEl =
      verticalScrollRef.current || mainViewRef.current || undefined;
    const canvases = Array.from(verticalCanvasRefs.current.values());
    if (!rootEl || canvases.length === 0) return () => {};

    observer = new IntersectionObserver(
      async (entries) => {
        for (const entry of entries) {
          const target = entry.target as HTMLCanvasElement;
          const pageAttr = target.getAttribute("data-page");
          const pageNum = pageAttr ? Number(pageAttr) : NaN;
          if (isNaN(pageNum)) continue;
          if (entry.isIntersecting && !renderedPagesRef.current.has(pageNum)) {
            await renderPageToTarget(pageNum, target);
          }
        }
      },
      // 扩大预渲染范围，缓解快速向上滚动时的空白
      { root: rootEl, rootMargin: "400px 0px 800px 0px" }
    );

    canvases.forEach((el) => observer!.observe(el));
    return () => {
      observer && observer.disconnect();
    };
  }, [readingMode, pdf, totalPages]);

  // 切换阅读模式时，确保重新渲染当前页（横向）或滚动到当前页（纵向）
  useEffect(() => {
    if (!pdf) return;
    if (readingMode === "horizontal") {
      // 横向模式：渲染当前页到单一 canvas
      renderPage(currentPage);
      // 清理纵向模式的渲染标记，防止引用残留
      renderedPagesRef.current.clear();
    } else {
      // 纵向模式：尝试滚动至当前页的 canvas
      const target = verticalCanvasRefs.current.get(currentPage);
      if (target && target.height > 0) {
        target.scrollIntoView({ behavior: "auto", block: "start" });
      }
    }
  }, [readingMode, pdf]);

  // 纵向模式：首次进入时主动渲染当前页及相邻页，确保滚动监听有尺寸参考
  useEffect(() => {
    if (!pdf || readingMode !== "vertical") return;
    const renderInitial = async () => {
      const cur = verticalCanvasRefs.current.get(currentPage);
      if (cur && cur.height === 0) {
        await renderPageToTarget(currentPage, cur);
      }
      const nextPageNum = Math.min(totalPages, currentPage + 1);
      const next = verticalCanvasRefs.current.get(nextPageNum);
      if (next && next.height === 0 && nextPageNum !== currentPage) {
        await renderPageToTarget(nextPageNum, next);
      }
    };
    // 下一帧执行，确保 DOM 已挂载
    requestAnimationFrame(() => {
      renderInitial();
    });
  }, [pdf, readingMode, currentPage, totalPages]);

  // 纵向模式：滚动时动态更新当前页（以视口中心线为准；不进行程序化对齐）
  useEffect(() => {
    if (readingMode !== "vertical") return;
    const vs = verticalScrollRef.current;
    const mv = mainViewRef.current;

    const updateFromScroll = () => {
      verticalScrollRafRef.current = null;
      // 滑动期间不回写 currentPage，避免与滑动条中途状态互相干扰
      if (isSeeking) return;
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
      let bestPage = pageUnderCenter ?? currentPage;
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
      if (bestPage !== currentPage) {
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
    // 绑定 wheel 事件，确保某些环境下仅 wheel 不触发 scroll 时也能更新
    if (vs) {
      vs.addEventListener("wheel", onScroll, { passive: true });
    }
    if (mv) {
      mv.addEventListener("wheel", onScroll, { passive: true });
    }
    window.addEventListener("wheel", onScroll, { passive: true });
    // 初次挂载后立即计算一次，保证进入后不滑动也同步当前页
    requestAnimationFrame(updateFromScroll);
    // 首次进入时短暂轮询，确保画布尺寸与滚动容器就绪后立即更新页码
    verticalInitFramesRef.current = 0;
    const initTick = () => {
      verticalInitRafRef.current = null;
      if (verticalInitFramesRef.current >= 12) return; // 约 12 帧 ~200ms
      verticalInitFramesRef.current += 1;
      updateFromScroll();
      verticalInitRafRef.current = requestAnimationFrame(initTick);
    };
    verticalInitRafRef.current = requestAnimationFrame(initTick);
    return () => {
      if (vs) {
        vs.removeEventListener("scroll", onScroll);
        vs.removeEventListener("wheel", onScroll);
      }
      if (mv) {
        mv.removeEventListener("scroll", onScroll);
        mv.removeEventListener("wheel", onScroll);
      }
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("wheel", onScroll);
      if (verticalScrollRafRef.current !== null) {
        cancelAnimationFrame(verticalScrollRafRef.current);
        verticalScrollRafRef.current = null;
      }
      if (verticalInitRafRef.current !== null) {
        cancelAnimationFrame(verticalInitRafRef.current);
        verticalInitRafRef.current = null;
      }
    };
  }, [readingMode, book, isSeeking, totalPages]);

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
      }, DEFAULT_AUTO_PAGE_MS);
    } else {
      // 纵向：持续向下滚动
      stopAll();
      const el = verticalScrollRef.current || mainViewRef.current;
      if (!el) return () => stopAll();
      const speed = settings.scrollSpeed || DEFAULT_SCROLL_PX_PER_SEC;
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

  // 渲染目录树（组件内，可访问状态与方法）
  const renderTocTree = (nodes: TocNode[], level: number): React.ReactNode => {
    const indent = 10 + level * 14;
    return nodes.map((node, idx) => {
      const hasChildren = !!(node.children && node.children.length);
      const caret = hasChildren ? (node.expanded ? "▼" : "▶") : "•";
      const isActive =
        typeof currentChapterPageVal === "number" &&
        node.page === currentChapterPageVal;
      return (
        <div key={`${level}-${idx}`} style={{ marginLeft: indent }}>
          <div
            ref={(el) => {
              if (el && typeof node.page === "number") {
                tocItemRefs.current.set(node.page, el as HTMLDivElement);
              }
            }}
            style={{
              padding: "8px",
              borderRadius: "6px",
              cursor: "default",
              backgroundColor: isActive ? "#333" : "transparent",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = isActive
                ? "#333"
                : "#2a2a2a";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = isActive
                ? "#333"
                : "transparent";
            }}
          >
            <span
              onClick={(e) => {
                e.stopPropagation();
                if (hasChildren) {
                  node.expanded = !node.expanded;
                  setToc([...toc]);
                }
              }}
              style={{
                marginRight: 12,
                fontSize: "11px",
                lineHeight: "1",
                color: "#ffffff",
                opacity: 0.7,
                cursor: hasChildren ? "pointer" : "default",
              }}
            >
              {caret}
            </span>
            <span
              onClick={(e) => {
                e.stopPropagation();
                if (typeof node.page === "number") {
                  goToPage(node.page);
                  setTocOverlayOpen(false);
                  setUiVisible(false);
                }
              }}
              style={{
                fontSize: "13px",
                color: isActive ? "#d15158" : "#ffffff",
                cursor: typeof node.page === "number" ? "pointer" : "default",
              }}
            >
              {node.title}
            </span>
            {typeof node.page === "number" && (
              <span style={{ fontSize: "12px", opacity: 0.7, marginLeft: 6 }}>
                第 {node.page} 页
              </span>
            )}
          </div>
          {hasChildren &&
            node.expanded &&
            renderTocTree(node.children!, level + 1)}
        </div>
      );
    });
  };

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
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            overflow: tocOverlayOpen || modeOverlayOpen ? "hidden" : "auto",
            padding: "20px",
            position: "relative",
          }}
          ref={mainViewRef}
        >
          {/* 顶部工具栏覆盖层：与底部控制栏一致的显示/隐藏逻辑 */}
          {(uiVisible || isSeeking || tocOverlayOpen) && (
            <div
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              onMouseUp={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
              onTouchEnd={(e) => e.stopPropagation()}
              onWheel={(e) => e.stopPropagation()}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                transform: "none",
                boxSizing: "border-box",
                backgroundColor: "rgba(26,26,26,0.92)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                color: "white",
                borderRadius: "10px",
                padding: "8px 12px",
                boxShadow: "0 6px 24px rgba(0,0,0,0.35)",
                zIndex: 12,
              }}
            >
              <button
                onClick={() => {
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
                style={{
                  background: "none",
                  border: "none",
                  color: "#fff",
                  cursor: "pointer",
                  fontSize: "16px",
                }}
                title="返回"
              >
                {"<"}
              </button>
              <div
                style={{
                  fontSize: "16px",
                  fontWeight: 500,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {book?.title}
              </div>
              <div style={{ width: "24px" }} />
            </div>
          )}
          {readingMode === "horizontal" ? (
            <canvas
              ref={canvasRef}
              style={{
                maxWidth: "100%",
                maxHeight: "100%",
                boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
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
                  key={p}
                  data-page={p}
                  ref={(el) => {
                    if (el) verticalCanvasRefs.current.set(p, el);
                  }}
                  style={{
                    width: "100%",
                    display: "block",
                    margin: `0 auto ${settings.pageGap}px`,
                    boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
                  }}
                />
              ))}
            </div>
          )}

          {/* 顶部页码气泡：贴紧顶部栏最左侧下方，顶部栏可见时下移；不因“显示状态栏”而强制显示 */}
          {(uiVisible || isSeeking) &&
            (() => {
              const toolbarVisible = uiVisible || isSeeking || tocOverlayOpen;
              const baseOffsetPx = toolbarVisible ? 72 : 14;
              const safeInset = settings.showStatusBar
                ? "env(safe-area-inset-top)"
                : "0px";
              return (
                <div
                  style={{
                    position: "absolute",
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

          {/* 目录蒙版弹层：占据页面90%，点击外部收回 */}
          {tocOverlayOpen && (
            <div
              onClick={(e) => {
                e.stopPropagation();
                setTocOverlayOpen(false);
                setUiVisible(false);
              }}
              style={{
                position: "absolute",
                inset: 0,
                backgroundColor: "rgba(0,0,0,0.6)",
                display: "flex",
                alignItems: "stretch",
                justifyContent: "flex-start",
                overflow: "hidden",
                zIndex: 20,
              }}
            >
              <div
                onClick={(e) => e.stopPropagation()}
                style={{
                  width: "90%",
                  height: "100%",
                  backgroundColor: "#1f1f1f",
                  color: "#fff",
                  borderRadius: "0 10px 10px 0",
                  overflowY: "auto",
                  padding: "16px",
                  boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
                }}
                className="no-scrollbar"
              >
                {/* 顶部页签：目录 / 书签（图标与文字贴近） */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "16px",
                    marginBottom: "12px",
                  }}
                >
                  <button
                    onClick={() => setLeftTab("toc")}
                    style={{
                      background: "none",
                      border: "none",
                      color: leftTab === "toc" ? "#d15158" : "#fff",
                      cursor: "pointer",
                      fontSize: "14px",
                      padding: "4px 6px",
                      borderBottom:
                        leftTab === "toc"
                          ? "2px solid #d15158"
                          : "2px solid transparent",
                    }}
                  >
                    <span style={{ marginRight: "6px" }}>≡</span>
                    <span>目录</span>
                  </button>
                  <button
                    onClick={() => setLeftTab("bookmark")}
                    style={{
                      background: "none",
                      border: "none",
                      color: leftTab === "bookmark" ? "#d15158" : "#fff",
                      cursor: "pointer",
                      fontSize: "14px",
                      padding: "4px 6px",
                      borderBottom:
                        leftTab === "bookmark"
                          ? "2px solid #d15158"
                          : "2px solid transparent",
                    }}
                  >
                    <span style={{ marginRight: "6px" }}>🔖</span>
                    <span>书签</span>
                  </button>
                </div>
                {/* 内容区：目录或书签列表 */}
                {leftTab === "toc" ? (
                  toc.length === 0 ? (
                    <div style={{ fontSize: "13px", opacity: 0.6 }}>
                      无目录信息
                    </div>
                  ) : (
                    <div>{renderTocTree(toc, 0)}</div>
                  )
                ) : bookmarks.length === 0 ? (
                  <div
                    style={{
                      fontSize: "13px",
                      opacity: 0.6,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      height: "100%",
                    }}
                  >
                    没有添加书签
                  </div>
                ) : (
                  <div>
                    {bookmarks.map((bm) => (
                      <div
                        key={bm.id}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          padding: "6px 8px",
                          borderRadius: "6px",
                          cursor: "pointer",
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.backgroundColor = "#2a2a2a";
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.backgroundColor = "transparent";
                        }}
                        onClick={() => {
                          goToPage(bm.page_number);
                          setTocOverlayOpen(false);
                          setUiVisible(false);
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                          }}
                        >
                          <span style={{ fontSize: "13px", color: "#fff" }}>
                            {bm.title}
                          </span>
                          <span style={{ fontSize: "12px", opacity: 0.7 }}>
                            第 {bm.page_number} 页
                          </span>
                        </div>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteBookmark(bm.id);
                          }}
                          style={{
                            background: "none",
                            border: "none",
                            color: "#ccc",
                            cursor: "pointer",
                            fontSize: "12px",
                          }}
                          title="删除书签"
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 阅读方式抽屉：贴底部的下拉面板（Bottom Sheet），选择横向/纵向 */}
          {modeOverlayOpen && (
            <div
              onClick={(e) => {
                e.stopPropagation();
                setModeOverlayOpen(false);
                setUiVisible(false);
              }}
              style={{
                position: "absolute",
                inset: 0,
                backgroundColor: "rgba(0,0,0,0.6)",
                display: "flex",
                flexDirection: "column",
                justifyContent: "flex-end",
                alignItems: "center",
                overflow: "hidden",
                zIndex: 20,
              }}
            >
              <div
                onClick={(e) => e.stopPropagation()}
                style={{
                  width: "min(720px, calc(100% - 32px))",
                  backgroundColor: "#1f1f1f",
                  color: "#fff",
                  borderTopLeftRadius: "12px",
                  borderTopRightRadius: "12px",
                  padding: "18px",
                  paddingBottom: "calc(18px + env(safe-area-inset-bottom))",
                  margin: "0 auto 0",
                  boxShadow: "0 -8px 32px rgba(0,0,0,0.5)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "16px",
                  }}
                >
                  <button
                    onClick={() => {
                      setReadingMode("horizontal");
                      setSettings((prev) => {
                        const next = {
                          ...prev,
                          readingMode: "horizontal",
                        } as ReaderSettings;
                        saveReaderSettings({ readingMode: "horizontal" });
                        return next;
                      });
                      setModeOverlayOpen(false);
                      setUiVisible(false);
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "12px",
                      background: "none",
                      border: "1px solid #333",
                      color: readingMode === "horizontal" ? "#d15158" : "#fff",
                      cursor: "pointer",
                      borderRadius: "8px",
                      padding: "10px 12px",
                      textAlign: "left",
                    }}
                  >
                    <span style={{ fontSize: "18px" }}>▤</span>
                    <div>
                      <div style={{ fontSize: "14px" }}>横向阅读</div>
                      <div style={{ fontSize: "12px", opacity: 0.7 }}>
                        左右翻页，适合分页浏览
                      </div>
                    </div>
                  </button>
                  <button
                    onClick={() => {
                      setReadingMode("vertical");
                      setSettings((prev) => {
                        const next = {
                          ...prev,
                          readingMode: "vertical",
                        } as ReaderSettings;
                        saveReaderSettings({ readingMode: "vertical" });
                        return next;
                      });
                      setModeOverlayOpen(false);
                      setUiVisible(false);
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "12px",
                      background: "none",
                      border: "1px solid #333",
                      color: readingMode === "vertical" ? "#d15158" : "#fff",
                      cursor: "pointer",
                      borderRadius: "8px",
                      padding: "10px 12px",
                      textAlign: "left",
                    }}
                  >
                    <span style={{ fontSize: "18px" }}>▮</span>
                    <div>
                      <div style={{ fontSize: "14px" }}>纵向阅读</div>
                      <div style={{ fontSize: "12px", opacity: 0.7 }}>
                        向下滚动，连续阅读
                      </div>
                    </div>
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* 覆盖式底部控制栏（绝对定位），不挤压内容；抽屉打开时隐藏 */}
          {(uiVisible || isSeeking) && !tocOverlayOpen && !modeOverlayOpen && (
            <div
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              onMouseUp={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
              onTouchEnd={(e) => e.stopPropagation()}
              onWheel={(e) => e.stopPropagation()}
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                transform: "none",
                bottom: "20px",
                boxSizing: "border-box",
                backgroundColor: "rgba(26,26,26,0.92)",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                color: "white",
                borderRadius: "10px",
                padding: "14px 18px",
                paddingBottom: "calc(14px + env(safe-area-inset-bottom))",
                boxShadow: "0 6px 24px rgba(0,0,0,0.35)",
                zIndex: 10,
              }}
            >
              {/* 上方进度滑条 + 两端上一章/下一章文案 */}
              <div
                style={{
                  width: "100%",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "stretch",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: "clamp(10px, 1.6vw, 12px)",
                    color: "#bbb",
                    marginBottom: "8px",
                  }}
                >
                  <span
                    onClick={() => {
                      const page = findCurrentChapterPage(toc);
                      if (typeof page === "number" && page < currentPage) {
                        goToPage(page);
                      } else {
                        prevPage();
                      }
                    }}
                    style={{
                      cursor: currentPage <= 1 ? "default" : "pointer",
                      opacity: currentPage <= 1 ? 0.5 : 1,
                    }}
                  >
                    上一章
                  </span>
                  <span
                    onClick={() => {
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
                    style={{
                      cursor: currentPage >= totalPages ? "default" : "pointer",
                      opacity: currentPage >= totalPages ? 0.5 : 1,
                    }}
                  >
                    下一章
                  </span>
                </div>
                {(() => {
                  const sliderVal =
                    isSeeking && seekPage !== null ? seekPage : currentPage;
                  const pct = Math.max(
                    0,
                    Math.min(
                      100,
                      Math.round((sliderVal / Math.max(1, totalPages)) * 100)
                    )
                  );
                  const track = `linear-gradient(to right, #d15158 0%, #d15158 ${pct}%, #3a3a3a ${pct}%, #3a3a3a 100%)`;
                  return (
                    <input
                      className="reader-range"
                      type="range"
                      min={1}
                      max={totalPages}
                      value={sliderVal}
                      onMouseDown={(e) => {
                        e.stopPropagation();
                        setIsSeeking(true);
                      }}
                      onTouchStart={(e) => {
                        e.stopPropagation();
                        setIsSeeking(true);
                      }}
                      onInput={(e) => {
                        const v = Number((e.target as HTMLInputElement).value);
                        setSeekPage(v);
                      }}
                      onMouseUp={async (e) => {
                        e.stopPropagation();
                        const v = Number((e.target as HTMLInputElement).value);
                        // 提交后立刻结束 seeking，让滚动监听按照内容更新预览
                        setSeekPage(null);
                        setIsSeeking(false);
                        await goToPage(v);
                      }}
                      onTouchEnd={async (e) => {
                        e.stopPropagation();
                        const v = Number((e.target as HTMLInputElement).value);
                        // 提交后立刻结束 seeking，让滚动监听按照内容更新预览
                        setSeekPage(null);
                        setIsSeeking(false);
                        await goToPage(v);
                      }}
                      style={{
                        width: "100%",
                        height: "6px",
                        borderRadius: "6px",
                        background: track,
                        outline: "none",
                      }}
                    />
                  );
                })()}
              </div>
              {/* 下方图标操作区：5等分网格，窄屏也不拥挤 */}
              <div
                style={{
                  marginTop: "14px",
                  display: "grid",
                  gridTemplateColumns: "repeat(5, 1fr)",
                  alignItems: "center",
                  justifyItems: "center",
                  width: "100%",
                  gap: "8px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                  }}
                >
                  <button
                    onClick={() => setTocOverlayOpen(true)}
                    style={{
                      background: "none",
                      border: "none",
                      color: tocOverlayOpen ? "#d15158" : "#fff",
                      cursor: "pointer",
                      fontSize: "clamp(16px, 3.2vw, 18px)",
                    }}
                    title="目录"
                  >
                    ≡
                  </button>
                  <div
                    style={{
                      fontSize: "clamp(10px, 1.6vw, 12px)",
                      color: tocOverlayOpen ? "#d15158" : "#ccc",
                      marginTop: "6px",
                    }}
                  >
                    目录
                  </div>
                </div>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                  }}
                >
                  <button
                    onClick={() => setModeOverlayOpen(true)}
                    style={{
                      background: "none",
                      border: "none",
                      color: "#fff",
                      cursor: "pointer",
                      fontSize: "clamp(16px, 3.2vw, 18px)",
                    }}
                    title="阅读方式"
                  >
                    ▉▉
                  </button>
                  <div
                    style={{
                      fontSize: "clamp(10px, 1.6vw, 12px)",
                      color: "#ccc",
                      marginTop: "6px",
                    }}
                  >
                    阅读方式
                  </div>
                </div>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                  }}
                >
                  <button
                    onClick={() => {
                      if (!autoScroll) {
                        setAutoScroll(true);
                        setUiVisible(false);
                      } else {
                        setAutoScroll(false);
                      }
                    }}
                    style={{
                      background: "none",
                      border: "none",
                      color: autoScroll ? "#d15158" : "#fff",
                      cursor: "pointer",
                      fontSize: "clamp(16px, 3.2vw, 18px)",
                    }}
                    title="自动滚动"
                  >
                    ☰
                  </button>
                  <div
                    style={{
                      fontSize: "clamp(10px, 1.6vw, 12px)",
                      color: autoScroll ? "#d15158" : "#ccc",
                      marginTop: "6px",
                    }}
                  >
                    自动滚动
                  </div>
                </div>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                  }}
                >
                  <button
                    onClick={addBookmark}
                    style={{
                      background: "none",
                      border: "none",
                      color: "#fff",
                      cursor: "pointer",
                      fontSize: "clamp(16px, 3.2vw, 18px)",
                    }}
                    title="书签"
                  >
                    🔖
                  </button>
                  <div
                    style={{
                      fontSize: "clamp(10px, 1.6vw, 12px)",
                      color: "#ccc",
                      marginTop: "6px",
                    }}
                  >
                    书签
                  </div>
                </div>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                  }}
                >
                  <button
                    onClick={() => navigate("/settings")}
                    style={{
                      background: "none",
                      border: "none",
                      color: "#fff",
                      cursor: "pointer",
                      fontSize: "clamp(16px, 3.2vw, 18px)",
                    }}
                    title="更多"
                  >
                    …
                  </button>
                  <div
                    style={{
                      fontSize: "clamp(10px, 1.6vw, 12px)",
                      color: "#ccc",
                      marginTop: "6px",
                    }}
                  >
                    更多
                  </div>
                </div>
              </div>

              {/* 书签提示气泡：覆盖显示，不影响布局与交互 */}
              {bookmarkToastVisible && (
                <div
                  style={{
                    position: "absolute",
                    bottom: "8px",
                    left: "50%",
                    transform: "translateX(-50%)",
                    padding: "6px 12px",
                    borderRadius: "16px",
                    backgroundColor: "rgba(0,0,0,0.8)",
                    color: "#fff",
                    fontSize: "12px",
                    boxShadow: "0 2px 6px rgba(0,0,0,0.3)",
                    pointerEvents: "none",
                  }}
                >
                  {bookmarkToastText}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

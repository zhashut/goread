import React, { useState, useEffect, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { TOP_DRAWER_RADIUS, BOTTOM_DRAWER_RADIUS } from "../constants/ui";
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
import { log } from "../services/index";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";

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
  const currentPageRef = useRef<number>(1);
  const modeVersionRef = useRef<number>(0);
  const lastSeekTsRef = useRef<number>(0);
  const renderedPagesRef = useRef<Set<number>>(new Set());
  const verticalScrollRef = useRef<HTMLDivElement>(null);
  const verticalScrollRafRef = useRef<number | null>(null);
  // 预加载防抖定时器
  const preloadTimerRef = useRef<any>(null);
  // 优化工具实例
  const pageCacheRef = useRef<PageCacheManager>(new PageCacheManager(100, 500));
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
  const [cropRect, setCropRect] = useState<{x: number, y: number, w: number, h: number} | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [startPos, setStartPos] = useState<{x: number, y: number} | null>(null);
  const imageRef = useRef<HTMLImageElement>(null);

  const handleCapture = async () => {
    let dataUrl = "";
    try {
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
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.fillStyle = "#2a2a2a";
            ctx.fillRect(0, 0, width, height);
            verticalCanvasRefs.current.forEach((vCanvas, page) => {
              const rect = vCanvas.getBoundingClientRect();
              const containerRect = container.getBoundingClientRect();
              const relativeTop = rect.top - containerRect.top;
              const relativeLeft = rect.left - containerRect.left;
              if (relativeTop < height && relativeTop + rect.height > 0) {
                 ctx.drawImage(vCanvas, relativeLeft, relativeTop);
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

  const handleSaveCrop = async () => {
    if (!capturedImage || !cropRect || !imageRef.current) return;
    try {
      const img = imageRef.current;
      const canvas = document.createElement("canvas");
      const scaleX = img.naturalWidth / img.width;
      const scaleY = img.naturalHeight / img.height;
      
      canvas.width = cropRect.w * scaleX;
      canvas.height = cropRect.h * scaleY;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(
          img,
          cropRect.x * scaleX,
          cropRect.y * scaleY,
          cropRect.w * scaleX,
          cropRect.h * scaleY,
          0,
          0,
          canvas.width,
          canvas.height
        );
        
        const dataUrl = canvas.toDataURL("image/png");
        const base64Data = dataUrl.split(',')[1];
        const binaryData = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
        
        const path = await save({
            filters: [{
                name: 'Image',
                extensions: ['png', 'jpg']
            }],
            defaultPath: `goread_capture_${Date.now()}.png`
        });
        
        if (path) {
            await writeFile(path, binaryData);
            setCropMode(false);
            setCapturedImage(null);
            setCropRect(null);
        }
      }
    } catch (e) {
      console.error("Save failed", e);
    }
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (!imageRef.current) return;
    const rect = imageRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setStartPos({ x, y });
    setIsSelecting(true);
    setCropRect({ x, y, w: 0, h: 0 });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isSelecting || !startPos || !imageRef.current) return;
    const rect = imageRef.current.getBoundingClientRect();
    const currentX = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const currentY = Math.max(0, Math.min(e.clientY - rect.top, rect.height));
    
    const x = Math.min(startPos.x, currentX);
    const y = Math.min(startPos.y, currentY);
    const w = Math.abs(currentX - startPos.x);
    const h = Math.abs(currentY - startPos.y);
    
    setCropRect({ x, y, w, h });
  };

  const handleMouseUp = () => {
    setIsSelecting(false);
  };
  
  // 获取当前渲染倍率 (Scale)
  // 在 App/Web 端，这通常对应设备的像素密度 (DPR)。
  // 因为没有手动缩放按钮，所以 Scale 仅由屏幕素质决定。
  // 限制在 1-3 之间，防止超高清屏显存爆炸。
  const getCurrentScale = () => {
    return Math.max(1, Math.min(3, (window as any).devicePixelRatio || 1));
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
      }, 300); // 300ms 防抖，等待拖动结束
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
          quality: 'standard',
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
              quality: 'standard',
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
      
      // 轻量预热：前后各2页，使用 standard 质量，确保首屏附近翻页流畅
      Promise.resolve().then(async () => {
        try {
          const startPage = Math.max(1, targetBook.current_page - 2);
          const endPage = Math.min(pageCount, targetBook.current_page + 2);
          await invoke('pdf_preload_pages', {
            filePath: targetBook.file_path,
            startPage,
            endPage,
            quality: 'standard',
          });
        } catch (e) {
          console.warn('后台预加载失败', e);
        }
      });
      
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
        quality: 'standard',
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
            quality: 'standard',
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
        { root: rootEl, rootMargin: "800px 0px 800px 0px", threshold: 0.01 }
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
        const pagesToRender = [
          Math.max(1, currentPage - 1),
          currentPage,
          Math.min(totalPages, currentPage + 1),
        ];
        
        log(`[Reader] 开始渲染纵向模式页面: ${JSON.stringify(pagesToRender)}`);
        for (const pageNum of pagesToRender) {
          const canvas = verticalCanvasRefs.current.get(pageNum);
          if (canvas && !renderedPagesRef.current.has(pageNum)) {
            await renderPageToTarget(pageNum, canvas);
          }
        }
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
            padding: 0,
            position: "relative",
          }}
          ref={mainViewRef}
        >
          {/* 顶部工具栏覆盖层：与底部控制栏一致的显示/隐藏逻辑 */}
          {(uiVisible || isSeeking || tocOverlayOpen) && !moreDrawerOpen && (
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
                borderRadius: `0 0 ${TOP_DRAWER_RADIUS}px ${TOP_DRAWER_RADIUS}px`,
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
                  width: "75%",
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
          {(uiVisible || isSeeking) && !tocOverlayOpen && !modeOverlayOpen && !moreDrawerOpen && (
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
                bottom: 0,
                boxSizing: "border-box",
                backgroundColor: "rgba(26,26,26,0.92)",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                color: "white",
                borderRadius: `${BOTTOM_DRAWER_RADIUS}px ${BOTTOM_DRAWER_RADIUS}px 0 0`,
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
                        lastSeekTsRef.current = Date.now();
                      }}
                      onTouchStart={(e) => {
                        e.stopPropagation();
                        setIsSeeking(true);
                        lastSeekTsRef.current = Date.now();
                      }}
                      onInput={(e) => {
                        const v = Number((e.target as HTMLInputElement).value);
                        setSeekPage(v);
                        lastSeekTsRef.current = Date.now();
                      }}
                      onMouseUp={async (e) => {
                        e.stopPropagation();
                        const v = Number((e.target as HTMLInputElement).value);
                        // 提交后立刻结束 seeking，让滚动监听按照内容更新预览
                        setSeekPage(null);
                        setIsSeeking(false);
                        lastSeekTsRef.current = 0;
                        await goToPage(v);
                      }}
                      onTouchEnd={async (e) => {
                        e.stopPropagation();
                        const v = Number((e.target as HTMLInputElement).value);
                        // 提交后立刻结束 seeking，让滚动监听按照内容更新预览
                        setSeekPage(null);
                        setIsSeeking(false);
                        lastSeekTsRef.current = 0;
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
                    {readingMode === "horizontal" ? "▤" : "▮"}
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
                    title={readingMode === "horizontal" ? "自动翻页" : "自动滚动"}
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
                    {readingMode === "horizontal" ? "自动翻页" : "自动滚动"}
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
                    onClick={() => setMoreDrawerOpen(true)}
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

          {/* 更多选项抽屉 */}
          {moreDrawerOpen && (
            <div
              onClick={(e) => {
                e.stopPropagation();
                setMoreDrawerOpen(false);
                setUiVisible(false);
              }}
              style={{
                position: "absolute",
                inset: 0,
                backgroundColor: "rgba(0,0,0,0.5)",
                zIndex: 20,
                display: "flex",
                flexDirection: "column",
                justifyContent: "flex-end",
              }}
            >
              <div
                onClick={(e) => e.stopPropagation()}
                style={{
                  backgroundColor: "#1f1f1f",
                  borderRadius: `${BOTTOM_DRAWER_RADIUS}px ${BOTTOM_DRAWER_RADIUS}px 0 0`,
                  padding: "12px 0",
                  paddingBottom: "calc(12px + env(safe-area-inset-bottom))",
                  display: "flex",
                  flexDirection: "column",
                  animation: "slideUp 0.3s ease-out",
                }}
              >
                <div
                  onClick={handleCapture}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    padding: "16px 24px",
                    cursor: "pointer",
                    color: "#fff",
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "#2a2a2a"}
                  onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
                >
                  <div style={{ 
                    fontSize: "20px", 
                    marginRight: "16px",
                    width: "24px",
                    textAlign: "center"
                  }}>
                    📷
                  </div>
                  <span style={{ fontSize: "16px" }}>导出图片</span>
                </div>

                <div
                  onClick={() => {
                    setMoreDrawerOpen(false);
                    navigate("/settings");
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    padding: "16px 24px",
                    cursor: "pointer",
                    color: "#fff",
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "#2a2a2a"}
                  onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
                >
                  <div style={{ 
                    fontSize: "20px", 
                    marginRight: "16px",
                    width: "24px",
                    textAlign: "center"
                  }}>
                    ⚙️
                  </div>
                  <span style={{ fontSize: "16px" }}>设置</span>
                </div>
              </div>
            </div>
          )}

          {/* 截图裁切层 */}
          {cropMode && capturedImage && (
            <div
              style={{
                position: "fixed",
                inset: 0,
                backgroundColor: "#000",
                zIndex: 100,
                display: "flex",
                flexDirection: "column",
              }}
            >
              {/* 顶部栏 */}
              <div
                style={{
                  height: "50px",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "0 16px",
                  backgroundColor: "#1f1f1f",
                  color: "#fff",
                }}
              >
                <button
                  onClick={() => {
                    setCropMode(false);
                    setCapturedImage(null);
                    setCropRect(null);
                  }}
                  style={{
                    background: "none",
                    border: "none",
                    color: "#fff",
                    fontSize: "16px",
                    cursor: "pointer",
                  }}
                >
                  取消
                </button>
                <span>裁切图片</span>
                <button
                  onClick={handleSaveCrop}
                  style={{
                    background: "none",
                    border: "none",
                    color: "#d15158",
                    fontSize: "16px",
                    cursor: "pointer",
                    fontWeight: "bold",
                  }}
                >
                  ✔
                </button>
              </div>
              
              {/* 图片区域 */}
              <div
                style={{
                  flex: 1,
                  position: "relative",
                  overflow: "hidden",
                  display: "flex",
                  justifyContent: "center",
                  alignItems: "center",
                  backgroundColor: "#000",
                  userSelect: "none",
                }}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
              >
                <img
                  ref={imageRef}
                  src={capturedImage}
                  alt="Capture"
                  style={{
                    maxWidth: "100%",
                    maxHeight: "100%",
                    display: "block",
                    pointerEvents: "none",
                  }}
                  draggable={false}
                />
                
                {/* 裁切框与遮罩 */}
                {cropRect && imageRef.current && (
                   <div
                     style={{
                       position: "absolute",
                       left: imageRef.current.offsetLeft + cropRect.x,
                       top: imageRef.current.offsetTop + cropRect.y,
                       width: cropRect.w,
                       height: cropRect.h,
                       border: "2px solid #fff",
                       boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.5)",
                       pointerEvents: "none",
                     }}
                   />
                )}
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
};
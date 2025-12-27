import { useRef, useCallback, useEffect } from "react";
import { IBookRenderer } from "../../../services/formats";
import {
    PageCacheManager,
    SmartPredictor,
} from "../../../utils/pdfOptimization";
import {
    QUALITY_SCALE_MAP,
    PAGE_CACHE_SIZE,
    PAGE_CACHE_MEMORY_LIMIT_MB,
} from "../../../constants/config";
import { log } from "../../../services";
import { ReaderSettings } from "../../../services";
import { IBook } from "../../../types";

type RenderStateProps = {
    rendererRef: React.MutableRefObject<IBookRenderer | null>;
    bookIdRef: React.MutableRefObject<string | undefined>;
    modeVersionRef: React.MutableRefObject<number>;
    canvasRef: React.RefObject<HTMLCanvasElement>;
    mainViewRef: React.RefObject<HTMLDivElement>;
    isExternal: boolean;
    externalPath: string | null;
    book: IBook | null;
    settings: ReaderSettings;
    readingMode: "horizontal" | "vertical";
    totalPages: number;
};

/**
 * 核心渲染逻辑 Hook
 * 负责：
 * 1. 页面位图的加载与缓存 (loadPageBitmap)
 * 2. Canvas 绘制逻辑 (renderPage / renderPageToTarget)
 * 3. 智能预加载 (SmartPredictor)
 * 4. 缓存管理 (PageCacheManager)
 */
export const usePageRenderer = ({
    rendererRef,
    bookIdRef,
    modeVersionRef,
    canvasRef,
    mainViewRef,
    isExternal,
    externalPath,
    book,
    settings,
    readingMode,
    totalPages,
}: RenderStateProps) => {
    // 缓存与队列管理
    const pageCacheRef = useRef<PageCacheManager>(
        new PageCacheManager(PAGE_CACHE_SIZE, PAGE_CACHE_MEMORY_LIMIT_MB)
    );
    // 预加载图片资源缓存（显式管理 ImageBitmap）
    const preloadedBitmapsRef = useRef<Map<string, ImageBitmap>>(new Map());
    // 预加载任务队列（Promise 复用）
    const preloadingTasksRef = useRef<Map<string, Promise<ImageBitmap>>>(
        new Map()
    );
    const smartPredictorRef = useRef<SmartPredictor | null>(null);
    // 渲染任务队列（避免重复渲染同页）
    const renderQueueRef = useRef<Map<number, Promise<void>>>(new Map());
    // 已渲染页面集合（用于避免重复渲染）
    const renderedPagesRef = useRef<Set<number>>(new Set());

    // 辅助函数
    const makeCacheKey = (id: string, pageNum: number) => `${id}:${pageNum}`;

    const getCurrentScale = () => {
        const dpr = Math.max(1, Math.min(3, (window as any).devicePixelRatio || 1));
        const qualityScale =
            QUALITY_SCALE_MAP[settings.renderQuality || "standard"] || 1.0;
        return dpr * qualityScale;
    };

    const getSmartPredictor = () => {
        const renderer = rendererRef.current;
        if (!renderer || renderer.format !== "pdf") {
            return null;
        }
        if (!smartPredictorRef.current) {
            smartPredictorRef.current = new SmartPredictor();
        }
        return smartPredictorRef.current;
    };

    const resetCache = useCallback(() => {
        pageCacheRef.current.clear();
        smartPredictorRef.current = null;

        const currentId = bookIdRef.current || "";
        const currentPrefix = `${currentId}:`;

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
        renderQueueRef.current.clear();
    }, [bookIdRef]);

    const forceClearCache = useCallback(() => {
        pageCacheRef.current.clear();
        smartPredictorRef.current = null;
        preloadedBitmapsRef.current.forEach((bmp) => bmp.close && bmp.close());
        preloadedBitmapsRef.current.clear();
        preloadingTasksRef.current.clear();
        renderedPagesRef.current.clear();
        renderQueueRef.current.clear();
    }, []);

    useEffect(() => {
        forceClearCache();
    }, [settings.theme, forceClearCache]);

    // 核心加载函数
    const loadPageBitmap = async (pageNum: number): Promise<ImageBitmap> => {
        const capturedBookId = bookIdRef.current;
        if (!capturedBookId) {
            return Promise.reject(new Error("无效的书籍 ID"));
        }
        const cacheKey = makeCacheKey(capturedBookId, pageNum);

        if (preloadedBitmapsRef.current.has(cacheKey)) {
            return preloadedBitmapsRef.current.get(cacheKey)!;
        }
        if (preloadingTasksRef.current.has(cacheKey)) {
            return preloadingTasksRef.current.get(cacheKey)!;
        }

        const task = (async () => {
            try {
                if (bookIdRef.current !== capturedBookId) {
                    return Promise.reject(new Error("Book changed")) as unknown as ImageBitmap;
                }

                const renderer = rendererRef.current;
                if (!renderer) {
                    return Promise.reject(new Error("渲染器未初始化")) as unknown as ImageBitmap;
                }
                const filePath = isExternal ? externalPath : book?.file_path;
                if (!renderer.isReady && filePath) {
                    try {
                        await renderer.loadDocument(filePath);
                    } catch { }
                }

                const viewW =
                    canvasRef.current?.parentElement?.clientWidth ||
                    mainViewRef.current?.clientWidth ||
                    800;

                const dpr = getCurrentScale();
                const containerWidth = Math.min(4096, Math.floor(viewW * dpr));

                const renderStartTime = performance.now();
                let bitmap: ImageBitmap;
                try {
                    bitmap = await renderer.loadPageBitmap!(
                        pageNum,
                        containerWidth,
                        settings.renderQuality || "standard",
                        settings.theme
                    );
                } catch (err) {
                    const msg = String(err || "");
                    if (
                        (msg.includes("文档未加载") || msg.includes("PDF文档未加载")) &&
                        filePath
                    ) {
                        try {
                            await renderer.loadDocument(filePath);
                        } catch { }
                        bitmap = await renderer.loadPageBitmap!(
                            pageNum,
                            containerWidth,
                            settings.renderQuality || "standard",
                            settings.theme
                        );
                    } else {
                        throw err;
                    }
                }
                const renderEndTime = performance.now();
                log(
                    `[loadPageBitmap] 页面 ${pageNum} 渲染+解码耗时: ${Math.round(
                        renderEndTime - renderStartTime
                    )}ms`
                );

                if (bookIdRef.current !== capturedBookId) {
                    bitmap.close && bitmap.close();
                    return Promise.reject(new Error("Book changed")) as unknown as ImageBitmap;
                }

                preloadedBitmapsRef.current.set(cacheKey, bitmap);
                return bitmap;
            } finally {
                preloadingTasksRef.current.delete(cacheKey);
            }
        })();

        preloadingTasksRef.current.set(cacheKey, task);
        return task;
    };

    const preloadAdjacentPages = async (currentPageNum: number) => {
        if ((!book && !isExternal) || !rendererRef.current) return;
        const capturedBookId = bookIdRef.current;
        if (!capturedBookId) return;

        const renderer = rendererRef.current;
        const isPdf = renderer.format === "pdf";
        const scale = getCurrentScale();
        const themeKey = settings.theme || "light";
        let pagesToPreload: number[] = [];

        if (isPdf) {
            const predictor = getSmartPredictor();
            if (predictor) {
                pagesToPreload = predictor.predictNextPages(
                    currentPageNum,
                    totalPages,
                    readingMode
                );
            }
        }

        if (pagesToPreload.length === 0) {
            pagesToPreload = [currentPageNum + 1, currentPageNum + 2];
        }

        const seen = new Set<number>();
        pagesToPreload = pagesToPreload.filter((p) => {
            if (p <= 0 || p > totalPages) return false;
            if (p === currentPageNum) return false;
            if (seen.has(p)) return false;
            seen.add(p);
            return true;
        });

        for (const nextPage of pagesToPreload) {
            if (bookIdRef.current !== capturedBookId) return;
            if (pageCacheRef.current.has(nextPage, scale, themeKey)) continue;
            loadPageBitmap(nextPage).catch((e) =>
                console.warn(`预加载页面 ${nextPage} 失败`, e)
            );
        }
    };

    // 横向渲染
    const renderPage = async (pageNum: number, forceRender: boolean = false) => {
        if (!canvasRef.current) return;
        const canvas = canvasRef.current;
        const context = canvas.getContext("2d");
        if (!context) return;

        const localModeVer = modeVersionRef.current;
        const capturedBookId = bookIdRef.current;

        const existingRender = renderQueueRef.current.get(pageNum);
        if (existingRender) {
            try {
                await existingRender;
            } catch { }
            return;
        }

        const renderPromise = (async () => {
            try {
                const scale = getCurrentScale();
                const themeKey = settings.theme || "light";
                const pageCache = pageCacheRef.current;

                if (!forceRender) {
                    const cached = pageCache.get(pageNum, scale, themeKey);
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
                        preloadAdjacentPages(pageNum);
                        return;
                    }
                }

                preloadAdjacentPages(pageNum);

                log(`[renderPage] 页面 ${pageNum} 开始渲染（前端无缓存）`);
                const startTime = performance.now();
                canvas.style.backgroundColor = "#2a2a2a";

                let standardImg: ImageBitmap;
                try {
                    standardImg = await loadPageBitmap(pageNum);
                    if (capturedBookId) {
                        const k = makeCacheKey(capturedBookId, pageNum);
                        preloadedBitmapsRef.current.delete(k);
                    }
                } catch (error) {
                    log(`[renderPage] 页面 ${pageNum} 加载失败: ${error}`, "error");
                    throw error;
                }

                if (localModeVer !== modeVersionRef.current || readingMode !== "horizontal" || bookIdRef.current !== capturedBookId) {
                    standardImg.close && standardImg.close();
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
                context.fillStyle = "#ffffff";
                context.fillRect(0, 0, canvas.width, canvas.height);
                context.drawImage(standardImg, 0, 0);
                canvas.style.opacity = "1";
                canvas.style.backgroundColor = "transparent";

                const endTime = performance.now();
                log(
                    `[renderPage] 页面 ${pageNum} 渲染完成，总耗时: ${Math.round(
                        endTime - startTime
                    )}ms`
                );

                try {
                    const imageData = context.getImageData(
                        0,
                        0,
                        canvas.width,
                        canvas.height
                    );
                    pageCache.set(pageNum, imageData, canvas.width, canvas.height, scale, themeKey);
                } catch (e) {
                    console.warn("Failed to cache page:", e);
                }
                standardImg.close && standardImg.close();

            } catch (error) {
                log(`[renderPage] 页面 ${pageNum} 渲染失败: ${error}`, "error");
            } finally {
                renderQueueRef.current.delete(pageNum);
            }
        })();

        renderQueueRef.current.set(pageNum, renderPromise);
        return renderPromise;
    };

    // 纵向渲染
    const renderPageToTarget = async (
        pageNum: number,
        canvasEl: HTMLCanvasElement | null
    ) => {
        if ((!book && !isExternal) || !canvasEl) return;

        const existingRender = renderQueueRef.current.get(pageNum);
        if (existingRender) return existingRender;

        const localModeVer = modeVersionRef.current;
        const capturedBookId = bookIdRef.current;
        const canvas = canvasEl;
        const context = canvas.getContext("2d");
        if (!context) return;

        const renderPromise = (async () => {
            try {
                // Updated to not use containerWidth
                // const viewW = mainViewRef.current?.clientWidth || 800;
                const scale = getCurrentScale();
                const themeKey = settings.theme || "light";
                // const dpr = scale;
                const pageCache = pageCacheRef.current;

                const cached = pageCache.get(pageNum, scale, themeKey);
                if (cached) {
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

                const startTime = performance.now();
                canvas.style.backgroundColor = "#2a2a2a";

                const renderer = rendererRef.current;
                if (!renderer) return;

                let img: ImageBitmap;
                try {
                    img = await loadPageBitmap(pageNum);
                } catch (e) { throw e; }

                // 从预加载缓存移除，防止被其他渲染复用已关闭的 bitmap
                if (capturedBookId) {
                    const k = makeCacheKey(capturedBookId, pageNum);
                    preloadedBitmapsRef.current.delete(k);
                }

                if (localModeVer !== modeVersionRef.current || readingMode !== "vertical" || !document.contains(canvas)) {
                    img.close && img.close();
                    return;
                }
                if (bookIdRef.current !== capturedBookId) {
                    img.close && img.close();
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
                log(`[renderPageToTarget] 页面 ${pageNum} 渲染完成: ${Math.round(endTime - startTime)}ms`);

                try {
                    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
                    pageCache.set(pageNum, imageData, canvas.width, canvas.height, scale, themeKey);
                } catch (e) { console.warn("Failed cache vert", e); }

                img.close && img.close();

            } catch (error) {
                log(`[renderPageToTarget] 页面 ${pageNum} 渲染失败`, 'error');
            } finally {
                renderQueueRef.current.delete(pageNum);
            }
        })();

        renderQueueRef.current.set(pageNum, renderPromise);
        return renderPromise;
    };

    return {
        loadPageBitmap,
        renderPage,
        renderPageToTarget,
        resetCache,
        forceClearCache,
        getSmartPredictor,
        renderedPagesRef,
        renderQueueRef
    };
};

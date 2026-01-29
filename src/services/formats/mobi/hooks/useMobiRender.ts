/**
 * Mobi 渲染 Hook
 * 负责 DOM渲染、滚动监听、ShadowRoot 管理
 * 支持首屏优先渲染和快速位置恢复
 */
import { log, logError } from '../../../index';
import { RenderOptions } from '../../types';
import { MobiBook } from '../types';
import { MobiThemeHook } from './useMobiTheme';
import { mobiCacheService } from '../mobiCacheService';
import { sha256 } from '../../../../utils/bookId';

const RESOURCE_PREFIX = 'mobi-res://';

export interface MobiRenderContext {
    book: MobiBook | null;
    bookId: string | null;
    sectionCount: number;
    ensureBookLoaded: () => Promise<void>;
    themeHook: MobiThemeHook;
    onPageChange?: (page: number) => void;
    onTocChange?: (anchor: string) => void;
    onPositionRestored?: () => void;
    onScrollActivity?: () => void;
}

export interface MobiRenderState {
    currentVirtualPage: number;
    currentPreciseProgress: number;
    scrollContainer: HTMLElement | null;
    shadowRoot: ShadowRoot | null;
}

export interface MobiRenderHook {
    state: MobiRenderState;
    renderPage: (page: number, container: HTMLElement, options?: RenderOptions) => Promise<void>;
    reset: () => void;
}

export function useMobiRender(context: MobiRenderContext): MobiRenderHook {
    // 从 Context 中解构需要的属性
    const { themeHook, onPageChange, onTocChange, onPositionRestored, onScrollActivity, bookId, sectionCount, ensureBookLoaded } = context;

    const state: MobiRenderState = {
        currentVirtualPage: 1,
        currentPreciseProgress: 1,
        scrollContainer: null,
        shadowRoot: null,
    };

    const blobUrls = new Set<string>();
    let lastTocAnchor: string | null = null;

    /**
     * 处理并缓存资源
     */
    const _processAndCacheResources = async (html: string, bookId: string): Promise<string> => {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        // 查找所有 blob: 开头的图片
        const imgs = Array.from(doc.querySelectorAll('img[src^="blob:"]')) as HTMLImageElement[];
        // 查找所有 blob: 开头的链接 (CSS等)
        const links = Array.from(doc.querySelectorAll('link[href^="blob:"]')) as HTMLLinkElement[];

        const processResource = async (url: string, element: Element, attr: 'src' | 'href') => {
            try {
                // 读取 Blob 数据
                const response = await fetch(url);
                const blob = await response.blob();
                const buffer = await blob.arrayBuffer();
                
                // 计算哈希
                const hash = await sha256(buffer);
                const resourcePath = hash; // 使用哈希作为资源路径/ID

                // 保存到缓存
                if (!mobiCacheService.resourceCache.has(bookId, resourcePath)) {
                    await mobiCacheService.saveResourceToDB({
                        bookId,
                        resourcePath,
                        mimeType: blob.type,
                        sizeBytes: buffer.byteLength,
                        lastAccessTime: Date.now(),
                        data: buffer
                    });
                     // 同时写入内存缓存
                    mobiCacheService.resourceCache.set(bookId, resourcePath, buffer, blob.type);
                }

                // 替换 URL 为占位符
                element.setAttribute(attr, `${RESOURCE_PREFIX}${resourcePath}`);
            } catch (e) {
                console.error('[MobiRender] Resource process failed', e);
            }
        };

        await Promise.all([
            ...imgs.map(img => processResource(img.src, img, 'src')),
            ...links.map(link => processResource(link.href, link, 'href'))
        ]);

        return doc.body.innerHTML;
    };

    /**
     * 从缓存恢复资源
     */
    const _restoreResources = async (html: string, bookId: string): Promise<string> => {
        // 简单正则替换，比 DOM 解析更快
        // 查找 mobi-res://([a-f0-9]+)
        const regex = new RegExp(`${RESOURCE_PREFIX}([a-f0-9]+)`, 'g');
        
        // 收集所有需要恢复的资源ID
        const matches = Array.from(html.matchAll(regex));
        const resourceIds = new Set(matches.map(m => m[1]));
        
        const urlMap = new Map<string, string>();

        await Promise.all(Array.from(resourceIds).map(async (resId) => {
            let buffer = mobiCacheService.resourceCache.get(bookId, resId);
            let mimeType = mobiCacheService.resourceCache.getMimeType(bookId, resId) || 'application/octet-stream';

            if (!buffer) {
                // 从 DB 加载
                const entry = await mobiCacheService.loadResourceFromDB(bookId, resId);
                if (entry) {
                    buffer = entry.data;
                    mimeType = entry.mimeType;
                    // 放入内存缓存
                    mobiCacheService.resourceCache.set(bookId, resId, buffer, mimeType);
                }
            }

            if (buffer) {
                const blob = new Blob([buffer], { type: mimeType });
                const url = URL.createObjectURL(blob);
                blobUrls.add(url);
                urlMap.set(resId, url);
            }
        }));

        // 替换回去
        return html.replace(regex, (_match, resId) => {
            return urlMap.get(resId) || _match;
        });
    };

    /**
     * 渲染单个章节到指定的 DOM 元素
     */
    const _renderSingleSection = async (
        sectionEl: HTMLElement,
        sectionIndex: number
    ): Promise<boolean> => {
        let htmlContent: string | null = null;
        let fromCache = false;

        // 1. 尝试从缓存加载
        if (bookId) {
            // 内存缓存
            const memCache = mobiCacheService.sectionCache.getSection(bookId, sectionIndex);
            if (memCache) {
                htmlContent = memCache.rawHtml;
                fromCache = true;
                if (memCache.meta.sectionId !== undefined) {
                    sectionEl.dataset.sectionId = String(memCache.meta.sectionId);
                }
            } else {
                // 数据库缓存
                const dbCache = await mobiCacheService.loadSectionFromDB(bookId, sectionIndex);
                if (dbCache) {
                    htmlContent = dbCache.rawHtml;
                    if (dbCache.meta.sectionId !== undefined) {
                        sectionEl.dataset.sectionId = String(dbCache.meta.sectionId);
                    }
                    mobiCacheService.sectionCache.setSection(dbCache);
                    fromCache = true;
                }
            }
        }

        // 2. 缓存未命中，加载并处理
        if (!htmlContent) {
            if (!context.book) {
                await ensureBookLoaded();
            }

            const book = context.book!;
            const validSections = book.sections.filter(s => s.linear !== 'no');
            const section = validSections[sectionIndex];

            if (!section) {
                return false;
            }

            sectionEl.dataset.sectionId = String(section.id);

            const url = await section.load();
            if (url) {
                const response = await fetch(url);
                let rawHtml = await response.text();

                const parser = new DOMParser();
                const doc = parser.parseFromString(rawHtml, 'text/html');
                rawHtml = doc.body.innerHTML;

                if (bookId) {
                    htmlContent = await _processAndCacheResources(rawHtml, bookId);

                    const entry = {
                        bookId,
                        sectionIndex,
                        rawHtml: htmlContent,
                        rawStyles: [],
                        resourceRefs: [],
                        meta: {
                            lastAccessTime: Date.now(),
                            sizeBytes: htmlContent.length * 2,
                            createdAt: Date.now(),
                            sectionId: section.id
                        }
                    };
                    mobiCacheService.sectionCache.setSection(entry);
                    mobiCacheService.saveSectionToDB(entry);
                } else {
                    htmlContent = rawHtml;
                }

                if (url.startsWith('blob:')) {
                    blobUrls.add(url);
                }
            }
        }

        // 3. 渲染内容
        if (htmlContent) {
            if (bookId && (fromCache || htmlContent.includes(RESOURCE_PREFIX))) {
                htmlContent = await _restoreResources(htmlContent, bookId);
            }
            sectionEl.innerHTML = htmlContent;
            return true;
        }

        return false;
    };

    /**
     * 渲染所有章节内容（首屏优先策略）
     * 优先渲染目标章节及其前后章节，然后逐步补齐其他章节
     */
    const _renderAllSections = async (
        bodyEl: HTMLElement,
        options?: RenderOptions
    ): Promise<{ targetRendered: boolean; allRendered: Promise<void> }> => {
        const count = sectionCount || context.book?.sections.filter(s => s.linear !== 'no').length || 0;
        if (count === 0) {
            return { targetRendered: false, allRendered: Promise.resolve() };
        }

        // 计算目标章节索引（基于精确进度）
        const initialProgress = options?.initialVirtualPage || 1;
        const targetSectionIndex = Math.max(0, Math.min(count - 1, Math.floor(initialProgress) - 1));

        // 首屏渲染范围：目标章节前后各 1 个章节
        const PRELOAD_RANGE = 1;
        const firstScreenStart = Math.max(0, targetSectionIndex - PRELOAD_RANGE);
        const firstScreenEnd = Math.min(count - 1, targetSectionIndex + PRELOAD_RANGE);

        // 预创建所有章节的占位 DOM 元素（保证顺序）
        const sectionElements: HTMLElement[] = [];
        for (let i = 0; i < count; i++) {
            const sectionEl = document.createElement('div');
            sectionEl.className = 'mobi-section';
            sectionEl.dataset.sectionId = String(i);
            sectionEl.dataset.loaded = 'false';
            sectionElements.push(sectionEl);

            bodyEl.appendChild(sectionEl);

            // 添加分割线
            if (i < count - 1) {
                const divider = document.createElement('div');
                divider.className = 'mobi-divider';
                bodyEl.appendChild(divider);
            }
        }

        await log(`[MobiRender] 首屏优先渲染: 目标章节=${targetSectionIndex}, 范围=[${firstScreenStart}, ${firstScreenEnd}]`, 'info').catch(() => {});

        // 第一阶段：优先渲染首屏章节（目标章节及前后章节）
        let targetRendered = false;
        for (let i = firstScreenStart; i <= firstScreenEnd; i++) {
            try {
                const success = await _renderSingleSection(sectionElements[i], i);
                if (success) {
                    sectionElements[i].dataset.loaded = 'true';
                    if (i === targetSectionIndex) {
                        targetRendered = true;
                    }
                }
            } catch (error) {
                await logError(`[MobiRender] 首屏章节加载失败: ${i}`, { error: String(error) }).catch(() => {});
            }
        }

        // 第二阶段：异步渲染剩余章节（使用 requestIdleCallback 或 setTimeout）
        const remainingSections: number[] = [];
        for (let i = 0; i < count; i++) {
            if (i < firstScreenStart || i > firstScreenEnd) {
                remainingSections.push(i);
            }
        }

        const allRendered = new Promise<void>((resolve) => {
            if (remainingSections.length === 0) {
                resolve();
                return;
            }

            let currentIndex = 0;

            const renderNext = async () => {
                if (currentIndex >= remainingSections.length) {
                    await log(`[MobiRender] 所有章节渲染完成`, 'info').catch(() => {});
                    resolve();
                    return;
                }

                const sectionIndex = remainingSections[currentIndex];
                currentIndex++;

                try {
                    const success = await _renderSingleSection(sectionElements[sectionIndex], sectionIndex);
                    if (success) {
                        sectionElements[sectionIndex].dataset.loaded = 'true';
                    }
                } catch (error) {
                    await logError(`[MobiRender] 后台章节加载失败: ${sectionIndex}`, { error: String(error) }).catch(() => {});
                }

                // 使用 requestIdleCallback 或 setTimeout 调度下一个章节
                if (typeof requestIdleCallback !== 'undefined') {
                    requestIdleCallback(() => renderNext(), { timeout: 500 });
                } else {
                    setTimeout(renderNext, 16);
                }
            };

            // 延迟启动后台渲染，给首屏留出布局时间
            setTimeout(renderNext, 50);
        });

        return { targetRendered, allRendered };
    };

    /**
     * 设置滚动监听器
     */
    const _setupScrollListener = (scrollContainer: HTMLElement, shadowRoot: ShadowRoot) => {
        if (!scrollContainer) return;

        const handleScroll = () => {
            const container = scrollContainer;
            const scrollTop = container.scrollTop;
            const viewportHeight = container.clientHeight;

            if (viewportHeight > 0) {
                // 目录定位逻辑
                let currentSectionIndex = 1; // 起始索引 1
                let currentOffsetRatio = 0;

                if (shadowRoot) {
                    const bodyEl = shadowRoot.querySelector('.mobi-body') as HTMLElement | null;
                    if (bodyEl) {
                        const sections = Array.from(
                            bodyEl.querySelectorAll('.mobi-section')
                        ) as HTMLElement[];
                        if (sections.length > 0) {
                            const centerY = scrollTop + viewportHeight * 0.5;
                            let bestId: string | null = null;
                            let bestDist = Infinity;

                            // 查找进度对应的 section (基于顶部位置)
                            // 查找包含 scrollTop 线的那一行，或者第一个可见的 section
                            let foundProgressSection = false;

                            for (let i = 0; i < sections.length; i++) {
                                const section = sections[i];
                                const top = section.offsetTop;
                                const bottom = top + section.offsetHeight;
                                const height = section.offsetHeight;

                                // 目录逻辑 (基于中心)
                                const dist =
                                    centerY >= top && centerY <= bottom
                                        ? 0
                                        : Math.min(Math.abs(centerY - top), Math.abs(centerY - bottom));
                                if (dist < bestDist) {
                                    bestDist = dist;
                                    bestId = section.dataset.sectionId || null;
                                }

                                // 进度逻辑 (基于顶部)
                                if (!foundProgressSection && (scrollTop >= top && scrollTop < bottom)) {
                                    currentSectionIndex = i + 1; // 索引从 1 开始
                                    currentOffsetRatio = height > 0 ? (scrollTop - top) / height : 0;
                                    foundProgressSection = true;
                                }
                            }

                            // 边界情况：如果滚动到底部，强制设置为最后一章
                            // 容差设为 50px 或者 视口高度的 10%
                            const scrollBottom = scrollTop + viewportHeight;
                            const isAtBottom = scrollBottom >= container.scrollHeight - 20;

                            if (isAtBottom && sections.length > 0) {
                                currentSectionIndex = sections.length;
                                currentOffsetRatio = 0.9999;
                                foundProgressSection = true;
                            } else if (!foundProgressSection && sections.length > 0) {
                                const lastSec = sections[sections.length - 1];
                                if (scrollTop >= lastSec.offsetTop + lastSec.offsetHeight) {
                                    currentSectionIndex = sections.length;
                                    currentOffsetRatio = 0.999;
                                    foundProgressSection = true;
                                }
                            }

                            if (bestId) {
                                const anchor = `section:${bestId}`;
                                if (anchor !== lastTocAnchor) {
                                    lastTocAnchor = anchor;
                                    if (onTocChange) {
                                        onTocChange(anchor);
                                    }
                                }
                            }
                        }
                    }
                }

                // 更新精确进度
                const preciseProgress = currentSectionIndex + Math.max(0, Math.min(0.9999, currentOffsetRatio));
                const virtualPage = Math.floor(preciseProgress); // UI 显示用的整数页码
                
                state.currentPreciseProgress = preciseProgress;
                state.currentVirtualPage = virtualPage;

                if (onPageChange) {
                    onPageChange(preciseProgress);
                }
                
                // 通知滚动活跃状态，用于阅读时长统计
                if (onScrollActivity) {
                    onScrollActivity();
                }
            }
        };

        scrollContainer.addEventListener('scroll', handleScroll, { passive: true });
        handleScroll();
    };

    /**
     * 恢复阅读位置（首屏优先版本）
     * 当目标章节已渲染时，可以更快地完成位置恢复
     */
    const _restorePosition = (initialProgress: number, scrollContainer: HTMLElement, shadowRoot: ShadowRoot, pageCount: number) => {
        const tryRestore = (attempts: number) => {
            if (!scrollContainer) {
                if (attempts < 20) setTimeout(() => tryRestore(attempts + 1), 50);
                else onPositionRestored?.();
                return;
            }

            // 检查由于屏幕尺寸变化导致的页码溢出
            const totalSections = pageCount;
            const isLegacyPage = initialProgress > totalSections + 1;

            let restored = false;

            if (isLegacyPage) {
                const viewportHeight = scrollContainer.clientHeight;
                if (viewportHeight > 0) {
                    const targetScrollTop = (initialProgress - 1) * viewportHeight;
                    scrollContainer.scrollTo({ top: targetScrollTop, behavior: 'auto' });
                    restored = true;
                }
            } else {
                // 精确进度恢复
                const sectionIndex = Math.floor(initialProgress);
                const offsetRatio = initialProgress - sectionIndex;

                if (shadowRoot) {
                    const bodyEl = shadowRoot.querySelector('.mobi-body') as HTMLElement | null;
                    if (bodyEl) {
                        const sections = Array.from(bodyEl.querySelectorAll('.mobi-section')) as HTMLElement[];
                        const targetIndex = Math.max(0, Math.min(sections.length - 1, sectionIndex - 1));
                        const section = sections[targetIndex];

                        if (section) {
                            // 检查目标章节是否已加载内容
                            const isLoaded = section.dataset.loaded === 'true' || section.innerHTML.trim().length > 0;
                            
                            if (isLoaded) {
                                const top = section.offsetTop;
                                const height = section.offsetHeight;
                                const targetScrollTop = top + height * offsetRatio;
                                scrollContainer.scrollTo({ top: targetScrollTop, behavior: 'auto' });
                                restored = true;
                            } else if (attempts < 20) {
                                // 目标章节尚未加载，稍后重试
                                setTimeout(() => tryRestore(attempts + 1), 50);
                                return;
                            }
                        }
                    }
                }
            }

            // 位置恢复完成，通知外部
            if (restored) {
                // 短暂延迟确保滚动生效
                setTimeout(() => {
                    onPositionRestored?.();
                }, 30);
            } else if (attempts < 20) {
                setTimeout(() => tryRestore(attempts + 1), 50);
            } else {
                // 超过重试次数，仍然触发回调
                onPositionRestored?.();
            }
        };

        // 首屏已渲染，减少初始延迟
        setTimeout(() => tryRestore(0), 30);
    };


    /**
     * 渲染页面到容器
     */
    const renderPage = async (
        _page: number, 
        container: HTMLElement,
        options?: RenderOptions
    ): Promise<void> => {
        // 不再强制检查 context.book，允许 lazy load
        // if (!context.book) { throw new Error('文档未加载'); }
        if (!bookId && !context.book) {
             // 如果连 bookId 都没有，那确实无法渲染
             throw new Error('文档未就绪');
        }

        // 清理容器
        container.innerHTML = '';

        // 创建 Shadow DOM 宿主
        const host = document.createElement('div');
        host.className = 'mobi-renderer-host';
        host.style.width = '100%';
        host.style.height = '100%';
        host.style.display = 'block';
        container.appendChild(host);

        // 创建 Shadow DOM 以隔离样式
        const shadowRoot = host.attachShadow({ mode: 'open' });
        
        state.shadowRoot = shadowRoot;
        state.scrollContainer = host;

        // 计算分割线样式
        const dividerHeight = (options?.pageGap || 4) * 2 + 1;
        const baseFontSize = options?.fontSize || 16;
        const paragraphMargin = baseFontSize * 0.8;
        const dividerMargin = Math.max((options?.pageGap || 4) * 2, paragraphMargin * 1.5);
        const dividerColor = (options?.theme || 'light') === 'dark' ? '#ffffff' : '#000000';

        // 构建样式
        const themeStyles = themeHook.getThemeStyles(options?.theme || 'light');
        const defaultStyles = `
      :host {
        display: block;
        width: 100%;
        height: 100%;
        overflow-y: auto;
        overflow-x: hidden;
        contain: content;
        position: relative;
        scrollbar-width: none !important;
        -ms-overflow-style: none;
        ${themeStyles}
      }
      :host::-webkit-scrollbar {
        width: 0 !important;
        height: 0 !important;
      }
      .mobi-body {
        min-height: 100%;
        padding: 24px;
        box-sizing: border-box;
        max-width: 800px;
        margin: 0 auto;
      }
      .mobi-section {
        margin-bottom: 0;
        padding-bottom: 0;
      }
      .mobi-divider {
        height: ${dividerHeight}px;
        background-color: ${dividerColor};
        margin-top: ${dividerMargin}px;
        margin-bottom: ${dividerMargin}px;
        width: calc(100% + 48px);
        margin-left: -24px;
        margin-right: -24px;
      }
      img {
        max-width: 100%;
        height: auto;
      }
      a {
        color: #0969da;
        text-decoration: none;
      }
      a:hover {
        text-decoration: underline;
      }
      h1, h2, h3, h4, h5, h6 {
        margin-top: 24px;
        margin-bottom: 16px;
        font-weight: 600;
        line-height: 1.25;
      }
      h1 { font-size: 2em; }
      h2 { font-size: 1.5em; }
      h3 { font-size: 1.25em; }
      h4 { font-size: 1em; }
      h5 { font-size: 0.875em; }
      h6 { font-size: 0.85em; }
      p {
        margin-top: 0;
        margin-bottom: 16px;
        line-height: 1.7;
      }
      blockquote {
        margin: 0 0 16px;
        padding: 0 1em;
        border-left: 0.25em solid rgba(128, 128, 128, 0.3);
      }
      ul, ol {
        margin-top: 0;
        margin-bottom: 16px;
        padding-left: 2em;
      }
      hr {
        height: 0.25em;
        padding: 0;
        margin: 24px 0;
        background-color: rgba(128, 128, 128, 0.3);
        border: 0;
      }
      table {
        border-spacing: 0;
        border-collapse: collapse;
        margin: 16px 0;
        width: 100%;
        overflow: auto;
      }
      th, td {
        padding: 6px 13px;
        border: 1px solid rgba(128, 128, 128, 0.3);
      }
    `;

        // 创建容器结构
        const styleEl = document.createElement('style');
        styleEl.textContent = defaultStyles;

        const bodyEl = document.createElement('div');
        bodyEl.className = 'mobi-body';

        shadowRoot.appendChild(styleEl);
        shadowRoot.appendChild(bodyEl);

        // 应用字体大小（提前设置，避免布局偏移）
        if (options?.fontSize) {
            host.style.fontSize = `${options.fontSize}px`;
        }

        // 设置滚动监听
        _setupScrollListener(host, shadowRoot);

        // 防止容器本身滚动
        container.style.overflow = 'hidden';

        // 首屏优先渲染：先渲染目标章节及前后章节，然后在后台逐步补齐其他章节
        const { targetRendered, allRendered } = await _renderAllSections(bodyEl, options);

        // 首屏渲染完成后立即恢复位置（不必等待所有章节渲染完成）
        const initialPage = options?.initialVirtualPage;
        if (typeof initialPage === 'number' && initialPage > 0 && targetRendered) {
            const pageCount = sectionCount || context.book?.sections?.filter(s => s.linear !== 'no').length || 1;
            _restorePosition(initialPage, host, shadowRoot, pageCount);
        } else {
            requestAnimationFrame(() => {
                onPositionRestored?.();
            });
        }

        // 后台继续渲染剩余章节（不阻塞用户交互）
        allRendered.catch((err) => {
            logError('[MobiRender] 后台渲染失败', { error: String(err) }).catch(() => {});
        });
    };

    const reset = () => {
        // 清理 Blob URLs
        blobUrls.forEach(url => {
            try {
                URL.revokeObjectURL(url);
            } catch { }
        });
        blobUrls.clear();
        
        state.currentVirtualPage = 1;
        state.currentPreciseProgress = 1;
        state.scrollContainer = null;
        state.shadowRoot = null;
        lastTocAnchor = null;
    };

    return {
        state,
        renderPage,
        reset,
    };
}

/**
 * Mobi 渲染 Hook
 * 从 Rust 后端磁盘缓存加载章节和资源，渲染到 Shadow DOM
 */
import { logError } from '../../../index';
import { RenderOptions } from '../../types';
import { MobiThemeHook } from './useMobiTheme';
import { mobiCacheService } from '../mobiCacheService';

const RESOURCE_PREFIX = '__MOBI_RES__:';

export interface MobiRenderContext {
    book: null;
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
    updateDividerVisibility: (hidden: boolean) => void;
}

export function useMobiRender(context: MobiRenderContext): MobiRenderHook {
    const { themeHook, onPageChange, onTocChange, onPositionRestored, onScrollActivity, bookId, sectionCount } = context;

    const state: MobiRenderState = {
        currentVirtualPage: 1,
        currentPreciseProgress: 1,
        scrollContainer: null,
        shadowRoot: null,
    };

    const blobUrls = new Set<string>();
    let lastTocAnchor: string | null = null;

    /**
     * 将 HTML 中的资源占位符替换为 Blob URL
     */
    const _restoreResources = async (html: string, bid: string): Promise<string> => {
        const regex = new RegExp(`__MOBI_RES__:([^"'\\s>]+)`, 'g');
        const matches = Array.from(html.matchAll(regex));
        const resourceIds = [...new Set(matches.map(m => m[1]))];

        const urlMap = new Map<string, string>();

        await Promise.all(resourceIds.map(async (resId) => {
            // 内存缓存
            let buffer = mobiCacheService.resourceCache.get(bid, resId);
            let mimeType = mobiCacheService.resourceCache.getMimeType(bid, resId) || 'application/octet-stream';

            // 磁盘缓存
            if (!buffer) {
                const entry = await mobiCacheService.loadResourceFromDB(bid, resId);
                if (entry) {
                    buffer = entry.data;
                    mimeType = entry.mimeType;
                    mobiCacheService.resourceCache.set(bid, resId, buffer, mimeType);
                }
            }

            if (buffer) {
                const blob = new Blob([buffer], { type: mimeType });
                const url = URL.createObjectURL(blob);
                blobUrls.add(url);
                urlMap.set(resId, url);
            }
        }));

        return html.replace(regex, (_match, resId) => urlMap.get(resId) || _match);
    };

    /**
     * 渲染单个章节
     */
    const _renderSingleSection = async (
        sectionEl: HTMLElement,
        sectionIndex: number
    ): Promise<boolean> => {
        if (!bookId) return false;

        // 1. 内存缓存
        let htmlContent: string | null = null;
        let styles: string[] = [];

        const memCache = mobiCacheService.sectionCache.getSection(bookId, sectionIndex);
        if (memCache) {
            htmlContent = memCache.rawHtml;
            styles = memCache.rawStyles;
        } else {
            // 2. 磁盘缓存
            const dbCache = await mobiCacheService.loadSectionFromDB(bookId, sectionIndex);
            if (dbCache) {
                htmlContent = dbCache.rawHtml;
                styles = dbCache.rawStyles;
                mobiCacheService.sectionCache.setSection(dbCache);
            }
        }

        if (!htmlContent) return false;

        // 替换资源占位符为 Blob URL
        if (htmlContent.includes(RESOURCE_PREFIX)) {
            htmlContent = await _restoreResources(htmlContent, bookId);
        }

        // 样式中的占位符也需要替换
        if (styles.length > 0) {
            const resolvedStyles: string[] = [];
            for (let s of styles) {
                if (s.includes(RESOURCE_PREFIX)) {
                    s = await _restoreResources(s, bookId);
                }
                resolvedStyles.push(s);
            }
            styles = resolvedStyles;
        }

        // 注入样式
        if (styles.length > 0) {
            const styleEl = document.createElement('style');
            styleEl.textContent = styles.join('\n');
            sectionEl.appendChild(styleEl);
        }

        // 注入内容
        const contentDiv = document.createElement('div');
        contentDiv.innerHTML = htmlContent;
        sectionEl.appendChild(contentDiv);

        return true;
    };

    /**
     * 渲染所有章节（首屏优先策略）
     */
    const _renderAllSections = async (
        bodyEl: HTMLElement,
        options?: RenderOptions
    ): Promise<{ targetRendered: boolean; allRendered: Promise<void> }> => {
        const count = sectionCount;
        if (count === 0) {
            return { targetRendered: false, allRendered: Promise.resolve() };
        }

        const initialProgress = options?.initialVirtualPage || 1;
        const targetSectionIndex = Math.max(0, Math.min(count - 1, Math.floor(initialProgress) - 1));

        const PRELOAD_RANGE = 1;
        const firstScreenStart = Math.max(0, targetSectionIndex - PRELOAD_RANGE);
        const firstScreenEnd = Math.min(count - 1, targetSectionIndex + PRELOAD_RANGE);

        // 预创建所有章节占位元素
        const sectionElements: HTMLElement[] = [];
        for (let i = 0; i < count; i++) {
            const sectionEl = document.createElement('div');
            sectionEl.className = 'mobi-section';
            sectionEl.dataset.sectionId = String(i);
            sectionEl.dataset.loaded = 'false';
            sectionElements.push(sectionEl);
            bodyEl.appendChild(sectionEl);
        }

        const ensureDividerForSection = (index: number) => {
            if (index >= count - 1) return;
            const sectionEl = sectionElements[index];
            if (!sectionEl?.parentElement) return;
            const nextSibling = sectionEl.nextElementSibling as HTMLElement | null;
            if (nextSibling && nextSibling.classList.contains('mobi-divider')) return;

            const divider = document.createElement('div');
            divider.className = 'mobi-divider';
            if (nextSibling) {
                sectionEl.parentElement.insertBefore(divider, nextSibling);
            } else {
                sectionEl.parentElement.appendChild(divider);
            }
        };

        // 第一阶段：首屏渲染
        let targetRendered = false;
        for (let i = firstScreenStart; i <= firstScreenEnd; i++) {
            try {
                const success = await _renderSingleSection(sectionElements[i], i);
                if (success) {
                    sectionElements[i].dataset.loaded = 'true';
                    ensureDividerForSection(i);
                    if (i === targetSectionIndex) targetRendered = true;
                }
            } catch (error) {
                await logError(`[MobiRender] 首屏章节加载失败: ${i}`, { error: String(error) }).catch(() => { });
            }
        }

        // 第二阶段：后台渲染剩余章节
        const remainingSections: number[] = [];
        for (let i = 0; i < count; i++) {
            if (i < firstScreenStart || i > firstScreenEnd) {
                remainingSections.push(i);
            }
        }

        const allRendered = new Promise<void>((resolve) => {
            if (remainingSections.length === 0) { resolve(); return; }

            let currentIndex = 0;
            const renderNext = async () => {
                if (currentIndex >= remainingSections.length) { resolve(); return; }

                const idx = remainingSections[currentIndex++];
                try {
                    const success = await _renderSingleSection(sectionElements[idx], idx);
                    if (success) {
                        sectionElements[idx].dataset.loaded = 'true';
                        ensureDividerForSection(idx);
                    }
                } catch (error) {
                    await logError(`[MobiRender] 后台章节加载失败: ${idx}`, { error: String(error) }).catch(() => { });
                }

                if (typeof requestIdleCallback !== 'undefined') {
                    requestIdleCallback(() => renderNext(), { timeout: 500 });
                } else {
                    setTimeout(renderNext, 16);
                }
            };

            setTimeout(renderNext, 50);
        });

        return { targetRendered, allRendered };
    };

    /**
     * 滚动监听
     */
    const _setupScrollListener = (scrollContainer: HTMLElement, shadowRoot: ShadowRoot) => {
        if (!scrollContainer) return;

        const handleScroll = () => {
            const container = scrollContainer;
            const scrollTop = container.scrollTop;
            const viewportHeight = container.clientHeight;

            if (viewportHeight <= 0) return;

            let currentSectionIndex = 1;
            let currentOffsetRatio = 0;

            const bodyEl = shadowRoot.querySelector('.mobi-body') as HTMLElement | null;
            if (bodyEl) {
                const sections = Array.from(bodyEl.querySelectorAll('.mobi-section')) as HTMLElement[];
                if (sections.length > 0) {
                    const centerY = scrollTop + viewportHeight * 0.3;
                    let bestId: string | null = null;
                    let bestDist = Infinity;
                    let foundProgressSection = false;

                    for (let i = 0; i < sections.length; i++) {
                        const section = sections[i];
                        const top = section.offsetTop;
                        const bottom = top + section.offsetHeight;
                        const height = section.offsetHeight;

                        const dist = centerY >= top && centerY <= bottom
                            ? 0
                            : Math.min(Math.abs(centerY - top), Math.abs(centerY - bottom));
                        if (dist < bestDist) {
                            bestDist = dist;
                            bestId = section.dataset.sectionId || null;
                        }

                        if (!foundProgressSection && scrollTop >= top && scrollTop < bottom) {
                            currentSectionIndex = i + 1;
                            currentOffsetRatio = height > 0 ? (scrollTop - top) / height : 0;
                            foundProgressSection = true;
                        }
                    }

                    const scrollBottom = scrollTop + viewportHeight;
                    const isAtBottom = scrollBottom >= container.scrollHeight - 20;

                    if (isAtBottom && sections.length > 0) {
                        currentSectionIndex = sections.length;
                        currentOffsetRatio = 0.9999;
                    } else if (!foundProgressSection && sections.length > 0) {
                        const lastSec = sections[sections.length - 1];
                        if (scrollTop >= lastSec.offsetTop + lastSec.offsetHeight) {
                            currentSectionIndex = sections.length;
                            currentOffsetRatio = 0.999;
                        }
                    }

                    if (bestId) {
                        // 查找视口内最近的 filepos 锚点，实现子章节级精确高亮
                        let anchor = `section:${bestId}`;
                        const bestSection = bodyEl.querySelector(`[data-section-id="${bestId}"]`);
                        if (bestSection) {
                            const fpAnchors = Array.from(bestSection.querySelectorAll('[id^="filepos"]')) as HTMLElement[];
                            if (fpAnchors.length > 0) {
                                let closestFp: HTMLElement | null = null;
                                let closestDist = Infinity;
                                for (const fp of fpAnchors) {
                                    const fpTop = fp.getBoundingClientRect().top + scrollTop - (scrollContainer.getBoundingClientRect?.()?.top || 0);
                                    if (fpTop <= centerY) {
                                        const dist = centerY - fpTop;
                                        if (dist < closestDist) {
                                            closestDist = dist;
                                            closestFp = fp;
                                        }
                                    }
                                }
                                if (closestFp) {
                                    anchor = `section:${bestId}#${closestFp.id}`;
                                }
                            }
                        }
                        if (anchor !== lastTocAnchor) {
                            lastTocAnchor = anchor;
                            onTocChange?.(anchor);
                        }
                    }
                }
            }

            const preciseProgress = currentSectionIndex + Math.max(0, Math.min(0.9999, currentOffsetRatio));
            state.currentPreciseProgress = preciseProgress;
            state.currentVirtualPage = Math.floor(preciseProgress);
            onPageChange?.(preciseProgress);
            onScrollActivity?.();
        };

        scrollContainer.addEventListener('scroll', handleScroll, { passive: true });
        handleScroll();
    };

    /**
     * 恢复阅读位置
     */
    const _restorePosition = (initialProgress: number, scrollContainer: HTMLElement, shadowRoot: ShadowRoot) => {
        const tryRestore = (attempts: number) => {
            if (!scrollContainer) {
                if (attempts < 20) setTimeout(() => tryRestore(attempts + 1), 50);
                else onPositionRestored?.();
                return;
            }

            const sectionIndex = Math.floor(initialProgress);
            const offsetRatio = initialProgress - sectionIndex;
            let restored = false;

            const bodyEl = shadowRoot.querySelector('.mobi-body') as HTMLElement | null;
            if (bodyEl) {
                const sections = Array.from(bodyEl.querySelectorAll('.mobi-section')) as HTMLElement[];
                const targetIndex = Math.max(0, Math.min(sections.length - 1, sectionIndex - 1));
                const section = sections[targetIndex];

                if (section) {
                    const isLoaded = section.dataset.loaded === 'true' || section.innerHTML.trim().length > 0;
                    if (isLoaded) {
                        const top = section.offsetTop;
                        const height = section.offsetHeight;
                        scrollContainer.scrollTo({ top: top + height * offsetRatio, behavior: 'auto' });
                        restored = true;
                    } else if (attempts < 20) {
                        setTimeout(() => tryRestore(attempts + 1), 50);
                        return;
                    }
                }
            }

            if (restored) {
                setTimeout(() => onPositionRestored?.(), 30);
            } else if (attempts < 20) {
                setTimeout(() => tryRestore(attempts + 1), 50);
            } else {
                onPositionRestored?.();
            }
        };

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
        if (!bookId) throw new Error('文档未就绪');

        container.innerHTML = '';

        // 创建 Shadow DOM 宿主
        const host = document.createElement('div');
        host.className = 'mobi-renderer-host';
        host.style.width = '100%';
        host.style.height = '100%';
        host.style.display = 'block';
        container.appendChild(host);

        const shadowRoot = host.attachShadow({ mode: 'open' });
        state.shadowRoot = shadowRoot;
        state.scrollContainer = host;

        // 样式构建
        const dividerHeight = (options?.pageGap || 4) * 2 + 1;
        const baseFontSize = options?.fontSize || 16;
        const paragraphMargin = baseFontSize * 0.8;
        const dividerMargin = Math.max((options?.pageGap || 4) * 2, paragraphMargin * 1.5);
        const dividerColor = (options?.theme || 'light') === 'dark' ? '#ffffff' : '#000000';
        const themeStyles = themeHook.getThemeStyles(options?.theme || 'light');

        const defaultStyles = `
      :host {
        display: block; width: 100%; height: 100%;
        overflow-y: auto; overflow-x: hidden;
        contain: content; position: relative;
        scrollbar-width: none !important; -ms-overflow-style: none;
        ${themeStyles}
      }
      :host::-webkit-scrollbar { width: 0 !important; height: 0 !important; }
      .mobi-body { min-height: 100%; padding: 24px; box-sizing: border-box; max-width: 800px; margin: 0 auto; }
      .mobi-section { margin-bottom: 0; padding-bottom: 0; }
      .mobi-divider {
        height: ${dividerHeight}px; background-color: ${dividerColor};
        margin-top: ${dividerMargin}px; margin-bottom: ${dividerMargin}px;
        width: calc(100% + 48px); margin-left: -24px; margin-right: -24px;
        display: ${options?.hideDivider ? 'none' : 'block'};
      }
      img { max-width: 100%; height: auto; }
      a { color: #0969da; text-decoration: none; }
      h1, h2, h3, h4, h5, h6 { margin-top: 24px; margin-bottom: 16px; font-weight: 600; line-height: 1.25; }
      h1 { font-size: 2em; } h2 { font-size: 1.5em; } h3 { font-size: 1.25em; }
      p { margin-top: 0; margin-bottom: 16px; line-height: 1.7; }
      blockquote { margin: 0 0 16px; padding: 0 1em; border-left: 0.25em solid rgba(128,128,128,0.3); }
      ul, ol { margin-top: 0; margin-bottom: 16px; padding-left: 2em; }
      table { border-spacing: 0; border-collapse: collapse; margin: 16px 0; width: 100%; }
      th, td { padding: 6px 13px; border: 1px solid rgba(128,128,128,0.3); }
    `;

        const styleEl = document.createElement('style');
        styleEl.textContent = defaultStyles;
        const bodyEl = document.createElement('div');
        bodyEl.className = 'mobi-body';
        shadowRoot.appendChild(styleEl);
        shadowRoot.appendChild(bodyEl);

        if (options?.fontSize) {
            host.style.fontSize = `${options.fontSize}px`;
        }

        _setupScrollListener(host, shadowRoot);
        container.style.overflow = 'hidden';

        const { targetRendered, allRendered } = await _renderAllSections(bodyEl, options);

        const initialPage = options?.initialVirtualPage;
        if (typeof initialPage === 'number' && initialPage > 0 && targetRendered) {
            _restorePosition(initialPage, host, shadowRoot);
        } else {
            requestAnimationFrame(() => onPositionRestored?.());
        }

        allRendered.catch((err) => {
            logError('[MobiRender] 后台渲染失败', { error: String(err) }).catch(() => { });
        });
    };

    const updateDividerVisibility = (hidden: boolean) => {
        const shadowRoot = state.shadowRoot;
        if (!shadowRoot) return;
        const dividers = shadowRoot.querySelectorAll('.mobi-divider') as NodeListOf<HTMLElement>;
        dividers.forEach(divider => {
            divider.style.display = hidden ? 'none' : 'block';
        });
    };

    const reset = () => {
        blobUrls.forEach(url => {
            try { URL.revokeObjectURL(url); } catch { }
        });
        blobUrls.clear();
        state.currentVirtualPage = 1;
        state.currentPreciseProgress = 1;
        state.scrollContainer = null;
        state.shadowRoot = null;
        lastTocAnchor = null;
    };

    return { state, renderPage, reset, updateDividerVisibility };
}

/**
 * Mobi 渲染 Hook
 * 负责 DOM渲染、滚动监听、ShadowRoot 管理
 */
import { logError } from '../../../index';
import { RenderOptions } from '../../types';
import { MobiBook } from '../types';
import { MobiThemeHook } from './useMobiTheme';

export interface MobiRenderContext {
    book: MobiBook | null;
    themeHook: MobiThemeHook;
    onPageChange?: (page: number) => void;
    onTocChange?: (anchor: string) => void;
    onPositionRestored?: () => void;
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
    const { themeHook, onPageChange, onTocChange, onPositionRestored } = context;

    const state: MobiRenderState = {
        currentVirtualPage: 1,
        currentPreciseProgress: 1,
        scrollContainer: null,
        shadowRoot: null,
    };

    const blobUrls = new Set<string>();
    let lastTocAnchor: string | null = null;

    /**
     * 渲染所有章节内容
     */
    const _renderAllSections = async (
        bodyEl: HTMLElement,
        _options?: RenderOptions
    ): Promise<void> => {
        const book = context.book;
        if (!book) return;

        const validSections = book.sections.filter(s => s.linear !== 'no');

        for (const section of validSections) {
            try {
                const sectionEl = document.createElement('div');
                sectionEl.className = 'mobi-section';
                sectionEl.dataset.sectionId = String(section.id);

                // 加载章节内容
                const url = await section.load();
                if (url) {
                    // 获取章节 HTML 内容
                    const response = await fetch(url);
                    const html = await response.text();

                    // 解析并提取 body 内容
                    const parser = new DOMParser();
                    const doc = parser.parseFromString(html, 'text/html');

                    // 复制 body 内容到章节元素
                    sectionEl.innerHTML = doc.body.innerHTML;

                    // 记录 Blob URL 以便后续清理
                    if (url.startsWith('blob:')) {
                        blobUrls.add(url);
                    }
                }

                bodyEl.appendChild(sectionEl);

                // 如果不是最后一个章节，添加分割线
                if (section !== validSections[validSections.length - 1]) {
                    const divider = document.createElement('div');
                    divider.className = 'mobi-divider';
                    bodyEl.appendChild(divider);
                }
            } catch (error) {
                await logError(`[MobiRenderer] 章节加载失败: ${section.id}`, {
                    error: String(error),
                }).catch(() => { });
            }
        }
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
                    onPageChange(virtualPage);
                }
            }
        };

        scrollContainer.addEventListener('scroll', handleScroll, { passive: true });
        handleScroll();
    };

    /**
     * 恢复阅读位置
     */
    const _restorePosition = (initialProgress: number, scrollContainer: HTMLElement, shadowRoot: ShadowRoot, pageCount: number) => {
        const tryRestore = (attempts: number) => {
            if (!scrollContainer) {
                if (attempts < 50) setTimeout(() => tryRestore(attempts + 1), 100);
                else onPositionRestored?.();
                return;
            }

            // 检查由于屏幕尺寸变化导致的页码溢出
            const sectionCount = pageCount;
            const isLegacyPage = initialProgress > sectionCount + 1;

            if (isLegacyPage) {
                const viewportHeight = scrollContainer.clientHeight;
                if (viewportHeight > 0) {
                    const targetScrollTop = (initialProgress - 1) * viewportHeight;
                    scrollContainer.scrollTo({ top: targetScrollTop, behavior: 'auto' });
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
                            const top = section.offsetTop;
                            const height = section.offsetHeight;
                            const targetScrollTop = top + height * offsetRatio;
                            scrollContainer.scrollTo({ top: targetScrollTop, behavior: 'auto' });
                        }
                    }
                }
            }

            //等待 DOM 稳定并更新内部状态
            setTimeout(() => {
                onPositionRestored?.();
            }, 50);
        };

        setTimeout(() => tryRestore(0), 100);
    };


    /**
     * 渲染页面到容器
     */
    const renderPage = async (
        _page: number, 
        container: HTMLElement,
        options?: RenderOptions
    ): Promise<void> => {
        const book = context.book;
        if (!book) {
            throw new Error('文档未加载');
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

        // 加载并渲染所有有效章节
        await _renderAllSections(bodyEl, options);

        // 应用字体大小
        if (options?.fontSize) {
            host.style.fontSize = `${options.fontSize}px`;
        }

        // 设置滚动监听
        _setupScrollListener(host, shadowRoot);

        // 防止容器本身滚动
        container.style.overflow = 'hidden';

        // 恢复阅读位置
        const initialPage = options?.initialVirtualPage;
        if (typeof initialPage === 'number' && initialPage > 0) {
            const pageCount = book.sections?.filter(s => s.linear !== 'no').length || 1;
            _restorePosition(initialPage, host, shadowRoot, pageCount);
        } else {
            requestAnimationFrame(() => {
                onPositionRestored?.();
            });
        }
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

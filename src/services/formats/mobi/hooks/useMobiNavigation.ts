/**
 * Mobi 导航 Hook
 * 负责页码跳转、锚点定位
 */
import { log, logError } from '../../../index';
import { MobiBook } from '../types';
import { MobiRenderState } from './useMobiRender';

export interface MobiNavigationContext {
    getRenderState: () => MobiRenderState;
    book: MobiBook | null;
    onPageChange?: (page: number) => void;
}

export interface MobiNavigationHook {
    goToPage: (page: number) => Promise<void>;
    scrollToAnchor: (anchor: string) => Promise<void>;
}

export function useMobiNavigation(context: MobiNavigationContext): MobiNavigationHook {
    const { getRenderState, onPageChange } = context;


    /**
     * 构建元素选择器（辅助方法）
     */
    const _buildSelector = (el: Element): string | null => {
        if (el.id) return `#${CSS.escape(el.id)}`;
        if (el.hasAttribute('name')) return `[name="${CSS.escape(el.getAttribute('name')!)}"]`;
        if (el.hasAttribute('aid')) return `[aid="${CSS.escape(el.getAttribute('aid')!)}"]`;
        // 回退到标签名（可能不精确）
        return el.tagName?.toLowerCase() || null;
    };

    /**
     * 直接在 DOM 中查找锚点并滚动
     */
    const _scrollToAnchorDirect = async (anchor: string): Promise<void> => {
        const { shadowRoot } = getRenderState();
        if (!shadowRoot) return;

        const bodyEl = shadowRoot.querySelector('.mobi-body');
        if (!bodyEl) return;

        // 尝试从 filepos: 格式提取 ID
        const fileposMatch = anchor.match(/filepos:(\d+)/);
        if (fileposMatch) {
            const fileposId = `filepos${fileposMatch[1]}`;
            const targetEl = bodyEl.querySelector(`#${CSS.escape(fileposId)}`);
            if (targetEl) {
                await log(`[MobiRenderer] 直接找到 filepos 锚点`, 'info', { fileposId }).catch(() => { });
                targetEl.scrollIntoView({ behavior: 'auto', block: 'start' });
                return;
            }
        }

        // 尝试从 kindle:pos: 格式提取信息
        const kindlePosMatch = anchor.match(/kindle:pos:fid:(\w+):off:(\w+)/);
        if (kindlePosMatch) {
            await log(`[MobiRenderer] kindle:pos 格式锚点，需要 resolveHref 支持`, 'warn', { anchor }).catch(() => { });
        }

        await log(`[MobiRenderer] 无法直接定位锚点: ${anchor}`, 'warn').catch(() => { });
    };

    /**
     * 跳转到指定页面 (章节)
     * 支持精确进度：page 可以是浮点数，整数部分表示章节，小数部分表示章节内偏移
     */
    const goToPage = async (page: number): Promise<void> => {
        const { scrollContainer, shadowRoot } = getRenderState();
        if (!scrollContainer || !shadowRoot) return;

        const bodyEl = shadowRoot.querySelector('.mobi-body');
        if (!bodyEl) return;

        // 提取整数页码和章节内偏移
        const intPage = Math.floor(page);
        const offsetRatio = page - intPage;

        const sections = Array.from(bodyEl.querySelectorAll('.mobi-section')) as HTMLElement[];
        const pageCount = sections.length || 1;
        // page 是从 1 开始的索引
        const sectionIndex = Math.max(1, Math.min(intPage, pageCount));
        const targetSection = sections[sectionIndex - 1]; // 0 为起始索引

        if (targetSection) {
            // 先滚动到章节开头
            targetSection.scrollIntoView({ behavior: 'auto', block: 'start' });
            
            // 应用章节内偏移
            if (offsetRatio > 0) {
                const sectionHeight = targetSection.offsetHeight;
                const offsetPx = sectionHeight * offsetRatio;
                scrollContainer.scrollTop += offsetPx;
            }
            
            // 直接使用传入的 page 值通知页码变化，无需等待 scroll 事件
            if (onPageChange) {
                onPageChange(page);
            }
        }
    };

    /**
     * 滚动到指定锚点（支持 filepos:、kindle:pos: 和 section: 格式）
     */
    const scrollToAnchor = async (anchor: string): Promise<void> => {
        const { shadowRoot } = getRenderState();
        if (!shadowRoot) {
            await log('[MobiRenderer] scrollToAnchor: shadowRoot 未初始化', 'warn').catch(() => { });
            return;
        }

        await log(`[MobiRenderer] scrollToAnchor 开始`, 'info', { anchor }).catch(() => { });

        try {
            const bodyEl = shadowRoot.querySelector('.mobi-body');
            if (!bodyEl) {
                await log('[MobiRenderer] 未找到 .mobi-body 元素', 'warn').catch(() => { });
                return;
            }

            // 处理 section: 格式的锚点（来自 _buildTocFromSections）
            const sectionMatch = anchor.match(/^section:(\d+)(?:#(.+))?$/);
            if (sectionMatch) {
                const sectionId = sectionMatch[1];
                const fragmentId = sectionMatch[2];

                await log(`[MobiRenderer] 处理 section 格式锚点`, 'info', { sectionId, fragmentId }).catch(() => { });

                const sectionEl = bodyEl.querySelector(`[data-section-id="${sectionId}"]`);
                if (sectionEl) {
                    if (fragmentId) {
                        // 尝试查找具体元素
                        const targetEl = sectionEl.querySelector(`#${CSS.escape(fragmentId)}`);
                        if (targetEl) {
                            targetEl.scrollIntoView({ behavior: 'auto', block: 'start' });
                            return;
                        }
                    }
                    // 滚动到 section 开头
                    sectionEl.scrollIntoView({ behavior: 'auto', block: 'start' });
                    return;
                }
                await log(`[MobiRenderer] 未找到 section ${sectionId}`, 'warn').catch(() => { });
                return;
            }

            const book = context.book;
            if (!book) {
                await _scrollToAnchorDirect(anchor);
                return;
            }

            // 检查 book 对象是否有 resolveHref 方法
            if (typeof book.resolveHref !== 'function') {
                await log('[MobiRenderer] book 对象没有 resolveHref 方法，尝试直接查找锚点', 'warn').catch(() => { });
                // 尝试直接在 DOM 中查找
                await _scrollToAnchorDirect(anchor);
                return;
            }

            // 调用 book 对象的 resolveHref 方法解析位置
            const resolved = await book.resolveHref(anchor);
            if (!resolved) {
                await log(`[MobiRenderer] 无法解析锚点: ${anchor}`, 'warn').catch(() => { });
                return;
            }

            const { index, anchor: anchorFn } = resolved;
            await log(`[MobiRenderer] 解析结果`, 'info', { index, hasAnchorFn: !!anchorFn }).catch(() => { });

            // 获取对应 section 的容器
            const sectionEl = bodyEl.querySelector(`[data-section-id="${index}"]`);
            if (sectionEl) {
                if (anchorFn) {
                    // 创建临时 document 用于查询
                    const parser = new DOMParser();
                    const doc = parser.parseFromString(`<html><body>${sectionEl.innerHTML}</body></html>`, 'text/html');
                    const targetEl = anchorFn(doc);

                    if (targetEl) {
                        // 在实际 DOM 中查找对应元素
                        const selector = _buildSelector(targetEl);
                        await log(`[MobiRenderer] 构建选择器`, 'info', { selector }).catch(() => { });

                        if (selector) {
                            const realTarget = sectionEl.querySelector(selector);
                            if (realTarget) {
                                await log('[MobiRenderer] 找到目标元素，开始滚动', 'info').catch(() => { });
                                realTarget.scrollIntoView({ behavior: 'auto', block: 'start' });
                                return;
                            }
                        }
                    }
                }

                // 回退：滚动到对应 section 的开头
                await log(`[MobiRenderer] 回退到 section ${index} 开头`, 'info').catch(() => { });
                sectionEl.scrollIntoView({ behavior: 'auto', block: 'start' });
                return;
            }

            await log(`[MobiRenderer] 未找到 section ${index}`, 'warn').catch(() => { });
        } catch (error) {
            await logError(`[MobiRenderer] scrollToAnchor 失败`, {
                error: String(error),
                stack: (error as Error)?.stack,
                anchor,
            }).catch(() => { });
        }
    };

    return {
        goToPage,
        scrollToAnchor,
    };
}

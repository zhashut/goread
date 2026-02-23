/**
 * Mobi 导航 Hook
 * 负责页码跳转、锚点定位
 */
import { log } from '../../../index';
import { MobiRenderState } from './useMobiRender';

export interface MobiNavigationContext {
    getRenderState: () => MobiRenderState;
    onPageChange?: (page: number) => void;
}

export interface MobiNavigationHook {
    goToPage: (page: number) => Promise<void>;
    scrollToAnchor: (anchor: string) => Promise<void>;
}

export function useMobiNavigation(context: MobiNavigationContext): MobiNavigationHook {
    const { getRenderState, onPageChange } = context;

    /**
     * 跳转到指定页面（章节）
     * 支持精确进度：整数部分=章节，小数部分=章节内偏移
     */
    const goToPage = async (page: number): Promise<void> => {
        const { scrollContainer, shadowRoot } = getRenderState();
        if (!scrollContainer || !shadowRoot) return;

        const bodyEl = shadowRoot.querySelector('.mobi-body');
        if (!bodyEl) return;

        const intPage = Math.floor(page);
        const offsetRatio = page - intPage;

        const sections = Array.from(bodyEl.querySelectorAll('.mobi-section')) as HTMLElement[];
        const pageCount = sections.length || 1;
        const sectionIndex = Math.max(1, Math.min(intPage, pageCount));
        const targetSection = sections[sectionIndex - 1];

        if (targetSection) {
            targetSection.scrollIntoView({ behavior: 'auto', block: 'start' });
            if (offsetRatio > 0) {
                scrollContainer.scrollTop += targetSection.offsetHeight * offsetRatio;
            }
            onPageChange?.(page);
        }
    };

    /**
     * 滚动到指定锚点（支持 section:N 格式）
     */
    const scrollToAnchor = async (anchor: string): Promise<void> => {
        const { shadowRoot } = getRenderState();
        if (!shadowRoot) return;

        const bodyEl = shadowRoot.querySelector('.mobi-body');
        if (!bodyEl) return;

        const sectionMatch = anchor.match(/^section:(\d+)(?:#(.+))?$/);
        if (sectionMatch) {
            const sectionId = sectionMatch[1];
            const fragmentId = sectionMatch[2];

            const sectionEl = bodyEl.querySelector(`[data-section-id="${sectionId}"]`);
            if (sectionEl) {
                if (fragmentId) {
                    const directTarget = sectionEl.querySelector(`#${CSS.escape(fragmentId)}`);
                    if (directTarget) {
                        directTarget.scrollIntoView({ behavior: 'auto', block: 'start' });
                        return;
                    }
                    if (fragmentId.startsWith('filepos')) {
                        const globalTarget = bodyEl.querySelector(`#${CSS.escape(fragmentId)}`);
                        if (globalTarget) {
                            globalTarget.scrollIntoView({ behavior: 'auto', block: 'start' });
                            return;
                        }
                    }
                }
                sectionEl.scrollIntoView({ behavior: 'auto', block: 'start' });
                return;
            }
        }

        // 尝试 filepos 格式
        const fileposMatch = anchor.match(/filepos:(\d+)/);
        if (fileposMatch) {
            const fileposId = `filepos${fileposMatch[1]}`;
            const targetEl = bodyEl.querySelector(`#${CSS.escape(fileposId)}`);
            if (targetEl) {
                targetEl.scrollIntoView({ behavior: 'auto', block: 'start' });
                return;
            }
        }

        await log(`[MobiNav] 无法定位锚点: ${anchor}`, 'warn').catch(() => { });
    };

    return { goToPage, scrollToAnchor };
}

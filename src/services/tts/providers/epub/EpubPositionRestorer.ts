import {
  createTextContentSearchCache,
  findRangeByTextQuote,
} from '../../../../utils/ttsDOM';
import type { TTSReadingAnchor } from '../../types';
import { log } from '../../../index';

/** 位置恢复需要的上下文 */
export interface EpubPositionRestorerContext {
  getReadingMode: () => 'horizontal' | 'vertical';
  getContainer: () => HTMLElement | null;
  /** 把章节索引 +1 转成 progress 跳转参数 */
  goToProgress: (progress: number) => Promise<void>;
  /** 设置当前章节索引（不触发跳转） */
  setSectionIndex: (sectionIndex: number) => void;
  /** 取当前章节根 DOM */
  getCurrentSectionRoot: () => Element | null;
  /** 该章节是否已渲染在视图里（已渲染时不需要先切章） */
  isSectionRendered: (sectionIndex: number) => boolean;
}

const waitForDomReady = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
};

const findAnchorRange = (
  root: Element | null,
  anchor: TTSReadingAnchor | null,
): Range | null => {
  if (!root || !anchor) return null;
  const cache = createTextContentSearchCache(root);
  if (!cache) return null;
  return findRangeByTextQuote(cache, anchor);
};

/** 横向模式下根据 Range 计算精确进度 */
const horizontalProgressFromRange = (
  range: Range,
  sectionIndex: number,
  container: HTMLElement,
): number => {
  const containerRect = container.getBoundingClientRect();
  const rangeRect = range.getBoundingClientRect();
  const scrollable = Math.max(0, container.scrollWidth - container.clientWidth);
  if (scrollable <= 0) return sectionIndex + 1;
  const desiredLeft = container.scrollLeft + Math.max(0, rangeRect.left - containerRect.left);
  const ratio = Math.max(0, Math.min(0.999, desiredLeft / scrollable));
  return sectionIndex + 1 + ratio;
};

/**
 * EPUB 听书停止后把最后朗读位置回写到视图
 * 横向模式：先渲染目标章节，再用 anchor 计算精确 progress；纵向模式：scrollIntoView
 */
export class EpubPositionRestorer {
  #ctx: EpubPositionRestorerContext;

  constructor(ctx: EpubPositionRestorerContext) {
    this.#ctx = ctx;
  }

  async restore(sectionIndex: number, anchor: TTSReadingAnchor | null): Promise<void> {
    if (sectionIndex < 0) return;

    // 目标章节已渲染时不需要切章：同章恢复只做章内定位，
    // 避免“先跳回章首、再找 anchor”的两次跳动（anchor 未命中时也不会白跳）
    const alreadyRendered = this.#ctx.isSectionRendered(sectionIndex);

    // 同步对外章节索引（阅读进度/书签以朗读位置为准）
    this.#ctx.setSectionIndex(sectionIndex);
    // 后台不操作视图：renderSection 内部的 rAF 等待在后台不会触发
    if (document.hidden) {
      log('[TTS][EpubRestorer] 后台中，仅同步章节索引', 'warn');
      return;
    }

    if (this.#ctx.getReadingMode() === 'horizontal') {
      await this.#alignHorizontal(sectionIndex, anchor, alreadyRendered);
      return;
    }

    if (!alreadyRendered) {
      await this.#ctx.goToProgress(sectionIndex + 1);
      await waitForDomReady();
    }

    const range = this.#locateAnchorOrLog(sectionIndex, anchor);
    if (!range) return;

    range.startContainer.parentElement?.scrollIntoView({ behavior: 'auto', block: 'center' });
    log(`[TTS][EpubRestorer] 纵向恢复到 sectionIndex=${sectionIndex}`, 'info');
  }

  /** 横向：先把目标章节渲染出来（若尚未渲染），再把滚动位置推到朗读句所在列 */
  async #alignHorizontal(
    sectionIndex: number,
    anchor: TTSReadingAnchor | null,
    alreadyRendered: boolean,
  ): Promise<void> {
    if (!alreadyRendered) {
      // 整数进度 = 切章（渲染目标章节并滚到章首）
      await this.#ctx.goToProgress(sectionIndex + 1);
      await waitForDomReady();
    }

    const range = this.#locateAnchorOrLog(sectionIndex, anchor);
    if (!range) return;

    const container = this.#ctx.getContainer();
    if (!container) return;

    const progress = horizontalProgressFromRange(range, sectionIndex, container);
    await this.#ctx.goToProgress(progress);
    await waitForDomReady();
    log(`[TTS][EpubRestorer] 横向恢复 progress=${progress.toFixed(4)}`, 'info');
  }

  /**
   * 在当前章节根里定位 anchor；未命中只记日志并返回 null（不移动视图）
   */
  #locateAnchorOrLog(
    sectionIndex: number,
    anchor: TTSReadingAnchor | null,
  ): Range | null {
    if (!anchor) {
      log('[TTS][EpubRestorer] 无 anchor，保持当前位置', 'info');
      return null;
    }
    const range = findAnchorRange(this.#ctx.getCurrentSectionRoot(), anchor);
    if (!range) {
      log(`[TTS][EpubRestorer] anchor 未命中，保持当前位置 sectionIndex=${sectionIndex}`, 'warn');
      return null;
    }
    return range;
  }
}


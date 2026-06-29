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
}

const waitForDomReady = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
};

const waitForAnchorReady = async (retries: number): Promise<void> => {
  for (let i = 0; i < retries; i++) {
    await waitForDomReady();
  }
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
): number | null => {
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
 * 横向模式：用 anchor 计算精确 progress；纵向模式：scrollIntoView
 */
export class EpubPositionRestorer {
  #ctx: EpubPositionRestorerContext;

  constructor(ctx: EpubPositionRestorerContext) {
    this.#ctx = ctx;
  }

  async restore(sectionIndex: number, anchor: TTSReadingAnchor | null): Promise<void> {
    if (sectionIndex < 0) return;

    this.#ctx.setSectionIndex(sectionIndex);
    if (document.hidden) {
      log('[TTS][EpubRestorer] 后台中，仅同步章节索引', 'warn');
      return;
    }

    if (this.#ctx.getReadingMode() === 'horizontal') {
      await this.#alignHorizontalTarget(sectionIndex, anchor, 'restore');
      return;
    }

    await this.#ctx.goToProgress(sectionIndex + 1);
    await waitForDomReady();

    if (!anchor) {
      log('[TTS][EpubRestorer] 无 anchor，回退到章节起点', 'info');
      return;
    }

    const range = await this.#findAnchorRangeWithRetry(anchor);
    if (!range) {
      log(`[TTS][EpubRestorer] anchor 未命中，回退到章节起点 sectionIndex=${sectionIndex}`, 'warn');
      return;
    }

    range.startContainer.parentElement?.scrollIntoView({ behavior: 'auto', block: 'center' });
    log(`[TTS][EpubRestorer] 纵向恢复到 sectionIndex=${sectionIndex}`, 'info');
  }

  async followHorizontalProgress(
    sectionIndex: number,
    anchor: TTSReadingAnchor | null,
  ): Promise<boolean> {
    if (sectionIndex < 0) return false;
    if (this.#ctx.getReadingMode() !== 'horizontal') return false;
    if (document.hidden) return false;
    return this.#alignHorizontalTarget(sectionIndex, anchor, 'follow');
  }

  async #findAnchorRangeWithRetry(anchor: TTSReadingAnchor): Promise<Range | null> {
    let range = findAnchorRange(this.#ctx.getCurrentSectionRoot(), anchor);
    if (range) return range;

    // EPUB 横向翻页后的 DOM 更新有时会比两帧更慢，这里补几次重试。
    await waitForAnchorReady(2);
    range = findAnchorRange(this.#ctx.getCurrentSectionRoot(), anchor);
    if (range) return range;

    await waitForAnchorReady(2);
    return findAnchorRange(this.#ctx.getCurrentSectionRoot(), anchor);
  }

  async #alignHorizontalTarget(
    sectionIndex: number,
    anchor: TTSReadingAnchor | null,
    mode: 'restore' | 'follow',
  ): Promise<boolean> {
    await this.#ctx.goToProgress(sectionIndex + 1);
    await waitForDomReady();

    if (!anchor) {
      log(
        mode === 'restore'
          ? '[TTS][EpubRestorer] 无 anchor，回退到章节起点'
          : `[TTS][EpubRestorer] 实时跟随无 anchor sectionIndex=${sectionIndex}`,
        'info',
      );
      return true;
    }

    const range = await this.#findAnchorRangeWithRetry(anchor);
    if (!range) {
      log(
        mode === 'restore'
          ? `[TTS][EpubRestorer] anchor 未命中，回退到章节起点 sectionIndex=${sectionIndex}`
          : `[TTS][EpubRestorer] 实时跟随 anchor 未命中 sectionIndex=${sectionIndex}`,
        mode === 'restore' ? 'warn' : 'info',
      );
      return true;
    }

    const container = this.#ctx.getContainer();
    if (!container) return true;

    const progress = horizontalProgressFromRange(range, sectionIndex, container);
    if (progress == null) return true;

    await this.#ctx.goToProgress(progress);
    await waitForDomReady();
    log(
      mode === 'restore'
        ? `[TTS][EpubRestorer] 横向恢复 progress=${progress.toFixed(4)}`
        : `[TTS][EpubRestorer] 横向实时跟随 progress=${progress.toFixed(4)}`,
      'info',
    );
    return true;
  }
}


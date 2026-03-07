import type { PageRange } from './useTxtRendererCore';
import type { TxtChapterCacheHook } from './useTxtChapterCache';
import type { TxtBookMeta } from '../txtCacheService';

export type TxtChapterWindowOptions = {
  includePrev?: boolean;
  includeNext?: boolean;
};

export interface TxtChapterWindowJumpContext {
  getIsReady: () => boolean;
  getUseChapterMode: () => boolean;
  getIsVerticalMode: () => boolean;
  getContainer: () => HTMLElement | null;
  getBookMeta: () => TxtBookMeta | null;
  getChapterCache: () => TxtChapterCacheHook | null;

  setContent: (value: string) => void;
  setPages: (value: PageRange[]) => void;
  setCurrentChapterIndex: (value: number) => void;
  setBookPreciseProgress: (value: number) => void;
  resetLoadedChapters: (indices: number[]) => void;
  resetChapterContentOffsets: (pairs: Array<{ chapterIndex: number; offset: number }>) => void;
  invalidateTitleMapCache: () => void;

  estimatePages: (content: string, chapterIndex: number, baseOffset: number) => PageRange[];
  bumpPagesVersion: () => void;
  renderFullContent: (container: HTMLElement) => Promise<void>;
  convertChapterPreciseToVirtualPrecise: (progress: number) => number;
  scrollToVirtualPage: (virtualPrecise: number, viewportHeight: number) => void;
  preloadAdjacentChapters: (chapterIndex: number) => Promise<void>;
  jumpToPreciseProgress: (progress: number) => Promise<void>;
}

export interface TxtChapterWindowJumpHook {
  jumpToPreciseProgressWithWindow: (
    progress: number,
    window?: TxtChapterWindowOptions
  ) => Promise<void>;
}

export function useTxtChapterWindowJump(ctx: TxtChapterWindowJumpContext): TxtChapterWindowJumpHook {
  let seq = 0;

  const jumpToPreciseProgressWithWindow = async (
    progress: number,
    window: TxtChapterWindowOptions = { includePrev: true, includeNext: true }
  ): Promise<void> => {
    if (!ctx.getIsReady()) return;

    const chapterCache = ctx.getChapterCache();
    const bookMeta = ctx.getBookMeta();
    const container = ctx.getContainer();

    if (
      !ctx.getUseChapterMode() ||
      !chapterCache ||
      !bookMeta ||
      !container ||
      !ctx.getIsVerticalMode()
    ) {
      await ctx.jumpToPreciseProgress(progress);
      return;
    }

    const chapterCount = Math.max(1, bookMeta.chapters.length);
    const max = chapterCount + 0.999999;
    const clampedProgress = Math.max(1, Math.min(progress, max));

    let chapterInt = Math.floor(clampedProgress);
    if (!isFinite(chapterInt) || chapterInt < 1) chapterInt = 1;
    if (chapterInt > chapterCount) chapterInt = chapterCount;
    const targetChapterIndex = chapterInt - 1;

    const includePrev = window.includePrev !== false;
    const includeNext = window.includeNext !== false;

    const indices: number[] = [];
    if (includePrev && targetChapterIndex > 0) indices.push(targetChapterIndex - 1);
    indices.push(targetChapterIndex);
    if (includeNext && targetChapterIndex < chapterCount - 1) indices.push(targetChapterIndex + 1);

    const windowIndices = Array.from(new Set(indices)).sort((a, b) => a - b);

    const callSeq = ++seq;
    ctx.bumpPagesVersion();

    const newContentOffsets = new Map<number, number>();
    const newLoadedChapters = new Set<number>();
    const newPages: PageRange[] = [];
    let combinedContent = '';
    let baseOffset = 0;
    let globalPageIndex = 0;

    for (const idx of windowIndices) {
      const chapter = await chapterCache.getChapter(idx);
      if (callSeq !== seq) return;

      newLoadedChapters.add(idx);
      newContentOffsets.set(idx, baseOffset);

      const estimated = ctx.estimatePages(chapter.content, idx, baseOffset);
      for (const p of estimated) {
        newPages.push({
          ...p,
          index: globalPageIndex,
          chapterIndex: idx,
          startOffset: p.startOffset + baseOffset,
          endOffset: p.endOffset + baseOffset,
        });
        globalPageIndex++;
      }

      combinedContent += chapter.content;
      baseOffset += chapter.content.length;
    }

    if (callSeq !== seq) return;

    ctx.setContent(combinedContent);
    ctx.setPages(newPages);
    ctx.setCurrentChapterIndex(targetChapterIndex);
    ctx.setBookPreciseProgress(clampedProgress);
    ctx.resetLoadedChapters(Array.from(newLoadedChapters));
    ctx.resetChapterContentOffsets(
      Array.from(newContentOffsets.entries()).map(([chapterIndex, offset]) => ({
        chapterIndex,
        offset,
      }))
    );
    ctx.invalidateTitleMapCache();

    await ctx.renderFullContent(container);
    if (callSeq !== seq) return;

    const viewportHeight = container.clientHeight;
    if (viewportHeight > 0) {
      const virtualPrecise = ctx.convertChapterPreciseToVirtualPrecise(clampedProgress);
      ctx.scrollToVirtualPage(virtualPrecise, viewportHeight);
    }

    ctx.preloadAdjacentChapters(targetChapterIndex).catch(() => {});
  };

  return {
    jumpToPreciseProgressWithWindow,
  };
}

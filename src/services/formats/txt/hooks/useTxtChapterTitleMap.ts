import type { TocItem } from '../../types';
import type { ChapterTitleMap } from './useTxtRendererCore';
import type { TxtBookMeta } from '../txtCacheService';

export interface TxtChapterTitleMapContext {
  getUseChapterMode: () => boolean;
  getBookMeta: () => TxtBookMeta | null;
  getToc: () => TocItem[];
  getContentLength: () => number;
  getCurrentChapterIndex: () => number;
  getChapterContentOffsetsPairs: () => Array<{ chapterIndex: number; offset: number }>;
  getCachedTitleMap: () => ChapterTitleMap | null;

  setCachedTitleMap: (value: ChapterTitleMap | null) => void;
  ensureChapterOffsetsInitialized: () => void;
}

export interface TxtChapterTitleMapHook {
  getFullTitleMap: () => ChapterTitleMap;
  getTitleMapForRange: (rangeStart: number, rangeEnd: number) => ChapterTitleMap;
  getTitleMapForRender: (params: {
    isVertical: boolean;
    contentStartOffset: number;
    contentLength: number;
  }) => ChapterTitleMap;
  invalidate: () => void;
}

function flattenTocOffsets(toc: TocItem[], map: ChapterTitleMap): void {
  for (const item of toc) {
    if (typeof item.location === 'number') {
      map.set(item.location, item.level);
    }
    if (item.children) {
      flattenTocOffsets(item.children, map);
    }
  }
}

function buildChapterModeTitleMap(
  bookMeta: TxtBookMeta,
  pairs: Array<{ chapterIndex: number; offset: number }>,
  map: ChapterTitleMap
): void {
  const chapters = bookMeta.chapters;
  for (const { chapterIndex, offset } of pairs) {
    if (chapterIndex < 0 || chapterIndex >= chapters.length) continue;
    const chapterMeta = chapters[chapterIndex];
    map.set(offset, chapterMeta.level);
  }
}

function extractTitlesForRange(
  fullMap: ChapterTitleMap,
  rangeStart: number,
  rangeEnd: number
): ChapterTitleMap {
  const sub: ChapterTitleMap = new Map();
  for (const [offset, level] of fullMap) {
    if (offset >= rangeStart && offset < rangeEnd) {
      sub.set(offset - rangeStart, level);
    }
  }
  return sub;
}

export function useTxtChapterTitleMap(ctx: TxtChapterTitleMapContext): TxtChapterTitleMapHook {
  const getFullTitleMap = (): ChapterTitleMap => {
    const cached = ctx.getCachedTitleMap();
    if (cached) return cached;

    const map: ChapterTitleMap = new Map();

    const bookMeta = ctx.getBookMeta();
    if (ctx.getUseChapterMode() && bookMeta) {
      ctx.ensureChapterOffsetsInitialized();
      buildChapterModeTitleMap(bookMeta, ctx.getChapterContentOffsetsPairs(), map);
    } else {
      flattenTocOffsets(ctx.getToc(), map);
    }

    ctx.setCachedTitleMap(map);
    return map;
  };

  const getTitleMapForRange = (rangeStart: number, rangeEnd: number): ChapterTitleMap => {
    return extractTitlesForRange(getFullTitleMap(), rangeStart, rangeEnd);
  };

  const getTitleMapForRender = (params: {
    isVertical: boolean;
    contentStartOffset: number;
    contentLength: number;
  }): ChapterTitleMap => {
    const fullMap = getFullTitleMap();
    const fullContentLength = ctx.getContentLength();

    if (
      params.contentStartOffset > 0 ||
      (!params.isVertical && params.contentLength < fullContentLength)
    ) {
      return extractTitlesForRange(
        fullMap,
        params.contentStartOffset,
        params.contentStartOffset + params.contentLength
      );
    }

    return fullMap;
  };

  const invalidate = (): void => {
    ctx.setCachedTitleMap(null);
  };

  return {
    getFullTitleMap,
    getTitleMapForRange,
    getTitleMapForRender,
    invalidate,
  };
}


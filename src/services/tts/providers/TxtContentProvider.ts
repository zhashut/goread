import type { BookFormat } from '../../formats/types';
import type { TTSReadingAnchor, TTSSegment } from '../types';
import type {
  TTSContentProvider,
  TTSContentProviderBatch,
  TTSContentProviderGetSegmentsRequest,
  BackendTTSRequest,
  TTSReadingPosition,
} from './TTSContentProvider';
import { AnchorLocator } from './AnchorLocator';
import {
  sliceTextToSegments,
  findAnchorStartOffset,
} from '../../../utils/ttsSegmentSlicer';
import {
  decodePageCursor,
  decodeSectionCursor,
  encodePageCursor,
  encodeSectionCursor,
} from '../../../utils/ttsSegment';
import { log } from '../../index';

/** TXT 横向分页页范围 */
export interface TxtPageRange {
  startOffset: number;
  endOffset: number;
}

/** TXT Provider 上下文 */
export interface TxtContentProviderContext {
  getBookId: () => string;
  getFilePath: () => string | null;
  isVerticalMode: () => boolean;
  /** 整本纯文本（横向 / 纵向兜底） */
  getContent: () => string;
  getPages: () => TxtPageRange[];
  /** 横向当前页码（1-based） */
  getCurrentPage: () => number;
  /** 当前章节索引（仅纵向章节模式有意义） */
  getCurrentChapterIndex?: () => number;
  /** 纵向滚动容器 */
  getContainer: () => HTMLElement | null;
  goToPage: (page: number) => Promise<void>;
  /** 取当前视口顶部位置（仅纵向模式有意义） */
  getVisibleStartPosition?: () => TTSReadingPosition | null;
}

const MAX_PAGES_PER_BATCH = 6;
const MAX_VERTICAL_WRAPPERS_PER_BATCH = 4;

/**
 * TXT 格式的 TTS 内容供给方
 * 横向模式：从 `getContent()` + `getPages()` 切片，cursor 用 `page:N`
 * 纵向模式：从 `[data-page-index]` wrapper 抽文本，cursor 继续使用 `wrapperIndex:chunkIndex`
 * 但对外暴露给 TTS 的 sectionIndex 统一为章节索引
 */
export class TxtContentProvider implements TTSContentProvider {
  readonly format: BookFormat = 'txt';

  #ctx: TxtContentProviderContext;
  #anchorLocator = new AnchorLocator();

  constructor(ctx: TxtContentProviderContext) {
    this.#ctx = ctx;
  }

  async getSegments(
    req: TTSContentProviderGetSegmentsRequest,
  ): Promise<TTSContentProviderBatch> {
    if (this.#ctx.isVerticalMode()) {
      return this.#getVerticalSegments(req);
    }
    return this.#getHorizontalSegments(req);
  }

  buildBackendRequest(
    req: TTSContentProviderGetSegmentsRequest,
  ): BackendTTSRequest | null {
    const filePath = this.#ctx.getFilePath();
    if (!filePath) return null;
    const startPosition = this.#resolveStartPosition(req);
    const fallbackSectionIndex =
      startPosition?.sectionIndex ??
      (this.#ctx.isVerticalMode()
        ? Math.max(0, this.#ctx.getCurrentChapterIndex?.() ?? 0)
        : Math.max(0, this.#ctx.getCurrentPage() - 1));
    return {
      bookId: this.#ctx.getBookId(),
      filePath,
      format: 'txt',
      cursor: req.cursor ?? null,
      maxSegments: req.maxSegments,
      startPosition,
      fallbackSectionIndex,
    };
  }

  locateAnchor(
    sectionIndex: number,
    anchor: TTSReadingAnchor | null | undefined,
  ): Range | null {
    if (!anchor) return null;
    if (!this.#ctx.isVerticalMode()) return null;
    for (const root of this.#resolveVerticalSectionRoots(sectionIndex)) {
      const range = this.#anchorLocator.locate(root, anchor);
      if (range) return range;
    }
    return null;
  }

  async restoreReadingPosition(position: TTSReadingPosition): Promise<void> {
    if (this.#ctx.isVerticalMode()) {
      const roots = this.#resolveVerticalSectionRoots(position.sectionIndex);
      if (roots.length === 0) return;
      const range = this.locateAnchor(position.sectionIndex, position.anchor);
      if (range) {
        this.#scrollRangeIntoView(range);
        return;
      }
      roots[0]?.scrollIntoView({ block: 'start', behavior: 'auto' });
      return;
    }
    const targetPage = position.sectionIndex + 1;
    if (targetPage <= 0) return;
    try {
      await this.#ctx.goToPage(targetPage);
    } catch (e) {
      log(`[TTS][Txt] restoreReadingPosition 失败: ${(e as Error).message ?? ''}`, 'warn');
    }
  }

  notifyDocumentUpdated(): void {
    this.#anchorLocator.invalidate();
  }

  #getHorizontalSegments(req: TTSContentProviderGetSegmentsRequest): TTSContentProviderBatch {
    const content = this.#ctx.getContent();
    const pages = this.#ctx.getPages();
    if (!content || pages.length === 0) {
      return { segments: [], cursor: null, hasMore: false };
    }
    const startPage = decodePageCursor(req.cursor) ?? Math.max(0, this.#ctx.getCurrentPage() - 1);

    const segments: TTSSegment[] = [];
    let nextPage = startPage;
    let hasMore = false;

    for (let i = 0; i < MAX_PAGES_PER_BATCH; i++) {
      const pageIndex = startPage + i;
      if (pageIndex >= pages.length) break;
      const remaining = req.maxSegments - segments.length;
      if (remaining <= 0) {
        hasMore = true;
        nextPage = pageIndex;
        break;
      }
      const range = pages[pageIndex]!;
      const text = content.slice(range.startOffset, range.endOffset).trim();
      if (!text) {
        nextPage = pageIndex + 1;
        continue;
      }
      const result = sliceTextToSegments({
        idPrefix: `txt-h:${pageIndex}`,
        text,
        sectionIndex: pageIndex,
        startChunkIndex: 0,
        maxSegments: remaining,
        encodeCursor: (sectionIndex) => encodePageCursor(sectionIndex + 1),
      });
      segments.push(...result.segments);
      if (result.hasMoreInText) {
        hasMore = true;
        nextPage = pageIndex;
        break;
      }
      nextPage = pageIndex + 1;
    }

    if (!hasMore) hasMore = nextPage < pages.length;
    const cursor = hasMore ? encodePageCursor(nextPage) : null;
    log(
      `[TTS][Txt][H] startPage=${startPage} nextPage=${nextPage} produced=${segments.length} hasMore=${hasMore}`,
      segments.length > 0 ? 'info' : 'warn',
    );
    return { segments, cursor, hasMore };
  }

  #getVerticalSegments(req: TTSContentProviderGetSegmentsRequest): TTSContentProviderBatch {
    const wrappers = this.#getVerticalWrappers();
    if (wrappers.length === 0) {
      return { segments: [], cursor: null, hasMore: false };
    }
    const startPosition = this.#resolveStartPosition(req);
    const { startWrapperIndex, startChunkIndex } = this.#resolveVerticalStart(
      req,
      wrappers,
      startPosition,
    );

    const segments: TTSSegment[] = [];
    let nextSectionIndex = startWrapperIndex;
    let nextChunkIndex = startChunkIndex;
    let hasMore = false;

    for (let i = 0; i < MAX_VERTICAL_WRAPPERS_PER_BATCH; i++) {
      const idx = startWrapperIndex + i;
      if (idx >= wrappers.length) break;
      const wrapper = wrappers[idx];
      const chapterIndex = this.#getWrapperChapterIndex(wrapper, idx);
      const remaining = req.maxSegments - segments.length;
      if (remaining <= 0) {
        hasMore = true;
        nextSectionIndex = idx;
        nextChunkIndex = idx === startWrapperIndex ? startChunkIndex : 0;
        break;
      }
      const rawText = (wrapper?.textContent || '').trim();
      const text = this.#trimByAnchorIfStart(rawText, idx, chapterIndex, startPosition, req.cursor);
      if (!text) {
        nextSectionIndex = idx + 1;
        nextChunkIndex = 0;
        continue;
      }
      const sliceStart = idx === startWrapperIndex ? startChunkIndex : 0;
      const result = sliceTextToSegments({
        idPrefix: `txt-v:${idx}`,
        text,
        sectionIndex: chapterIndex,
        startChunkIndex: sliceStart,
        maxSegments: remaining,
        encodeCursor: (_sectionIndex, chunkIndex) => encodeSectionCursor(idx, chunkIndex),
      });
      segments.push(...result.segments);
      if (result.hasMoreInText) {
        hasMore = true;
        nextSectionIndex = idx;
        nextChunkIndex = result.nextChunkIndex;
        break;
      }
      nextSectionIndex = idx + 1;
      nextChunkIndex = 0;
    }

    if (!hasMore) hasMore = nextSectionIndex < wrappers.length;
    const cursor = hasMore ? encodeSectionCursor(nextSectionIndex, nextChunkIndex) : null;
    log(
      `[TTS][Txt][V] startWrapper=${startWrapperIndex} startChunk=${startChunkIndex} produced=${segments.length} hasMore=${hasMore}`,
      segments.length > 0 ? 'info' : 'warn',
    );
    return { segments, cursor, hasMore };
  }

  /** cursor=null 时优先用调用方传入的 startPosition，否则用 ctx 提供的视口起点 */
  #resolveStartPosition(
    req: TTSContentProviderGetSegmentsRequest,
  ): TTSReadingPosition | null {
    if (req.cursor) return null;
    if (req.startPosition) return req.startPosition;
    return this.#ctx.getVisibleStartPosition?.() ?? null;
  }

  /** 仅当首章节命中 startPosition 时按 anchor 裁前缀 */
  #trimByAnchorIfStart(
    text: string,
    wrapperIndex: number,
    chapterIndex: number,
    startPosition: TTSReadingPosition | null,
    cursor: string | null,
  ): string {
    if (!text) return text;
    if (cursor) return text;
    if (!startPosition?.anchor) return text;
    if (startPosition.sectionIndex !== chapterIndex) return text;
    const startWrapperIndex = this.#findStartWrapperIndexByPosition(
      this.#getVerticalWrappers(),
      startPosition,
    );
    if (startWrapperIndex !== wrapperIndex) return text;
    const offset = findAnchorStartOffset(text, startPosition.anchor);
    if (offset <= 0 || offset >= text.length) return text;
    return text.slice(offset).trim();
  }

  #resolveVerticalStart(
    req: TTSContentProviderGetSegmentsRequest,
    wrappers: HTMLElement[],
    startPosition: TTSReadingPosition | null,
  ): { startWrapperIndex: number; startChunkIndex: number } {
    const cursor = decodeSectionCursor(req.cursor);
    if (cursor) {
      return {
        startWrapperIndex: Math.max(0, Math.min(cursor.sectionIndex, wrappers.length - 1)),
        startChunkIndex: Math.max(0, cursor.chunkIndex),
      };
    }
    const fallback =
      startPosition
        ? this.#findStartWrapperIndexByPosition(wrappers, startPosition)
        : this.#findVisibleWrapperIndex(wrappers);
    return {
      startWrapperIndex: Math.max(0, Math.min(fallback, wrappers.length - 1)),
      startChunkIndex: 0,
    };
  }

  #getVerticalWrappers(): HTMLElement[] {
    const container = this.#ctx.getContainer();
    if (!container) return [];
    return Array.from(
      container.querySelectorAll('[data-page-index]'),
    ) as HTMLElement[];
  }

  #findVisibleWrapperIndex(wrappers: HTMLElement[]): number {
    const container = this.#ctx.getContainer();
    if (!container) return 0;
    const scrollTop = container.scrollTop + 1;
    let best = 0;
    for (let i = 0; i < wrappers.length; i++) {
      const top = wrappers[i]?.offsetTop ?? 0;
      if (top <= scrollTop) best = i;
      else break;
    }
    return best;
  }

  #resolveVerticalSectionRoots(sectionIndex: number): HTMLElement[] {
    if (!this.#ctx.isVerticalMode()) return [];
    const container = this.#ctx.getContainer();
    if (!container) return [];
    return Array.from(
      container.querySelectorAll(`[data-chapter-index="${sectionIndex}"]`),
    ) as HTMLElement[];
  }

  #findStartWrapperIndexByPosition(
    wrappers: HTMLElement[],
    startPosition: TTSReadingPosition | null,
  ): number {
    if (!startPosition) return this.#findVisibleWrapperIndex(wrappers);
    const byChapter = wrappers
      .map((wrapper, index) => ({ wrapper, index }))
      .filter(({ wrapper, index }) => this.#getWrapperChapterIndex(wrapper, index) === startPosition.sectionIndex);
    if (byChapter.length === 0) {
      return this.#findVisibleWrapperIndex(wrappers);
    }
    if (!startPosition.anchor) {
      return byChapter[0]!.index;
    }
    for (const item of byChapter) {
      const range = this.#anchorLocator.locate(item.wrapper, startPosition.anchor);
      if (range) {
        return item.index;
      }
    }
    return byChapter[0]!.index;
  }

  #getWrapperChapterIndex(wrapper: HTMLElement | undefined, fallbackIndex: number): number {
    const raw = wrapper?.getAttribute('data-chapter-index');
    const parsed = raw == null ? Number.NaN : Number(raw);
    return Number.isFinite(parsed) ? parsed : fallbackIndex;
  }

  #scrollRangeIntoView(range: Range): void {
    const node = range.startContainer;
    const target =
      node.nodeType === Node.ELEMENT_NODE
        ? (node as Element)
        : node.parentElement;
    target?.scrollIntoView({ block: 'start', behavior: 'auto' });
  }
}


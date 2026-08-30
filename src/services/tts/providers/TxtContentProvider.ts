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
import { encodeSectionCursor, decodeSectionCursor } from '../../../utils/ttsSegment';
import { log } from '../../index';
import { txtCacheService, type TxtChapterContent } from '../../formats/txt/txtCacheService';
import { txtPreloader } from '../../formats/txt/txtPreloader';
import { getInvoke } from '../../index';

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
  /** 当前已加载文本（横向=当前章；纵向=已加载章节窗口拼接） */
  getContent: () => string;
  /** 当前内容的页范围（横向=当前章分页；纵向=窗口估算页） */
  getPages: () => TxtPageRange[];
  /** 当前页码（横向=章内页码，1-based） */
  getCurrentPage: () => number;
  /** 当前章节索引（0-based） */
  getCurrentChapterIndex?: () => number;
  /** 纵向滚动容器 */
  getContainer: () => HTMLElement | null;
  goToPage: (page: number) => Promise<void>;
  /** 横向：切章并渲染章内页（供恢复朗读位置使用） */
  goToChapterPage?: (chapterIndex: number, pageInChapter: number) => Promise<void>;
  /** 取当前视口顶部位置（横纵均返回 { sectionIndex: 章节索引, anchor }） */
  getVisibleStartPosition?: () => TTSReadingPosition | null;
}

/** 单批次最多跨越的 TXT 章节数（与后端 txt.rs 保持一致） */
const MAX_CHAPTERS_PER_BATCH = 4;

/**
 * TXT 格式的 TTS 内容供给方
 * 统一按章节粒度取片（与后端托管会话一致）：
 * - sectionIndex 恒为章节索引（横纵模式统一契约）
 * - cursor = sectionIndex:chunkIndex
 * - anchor 为章内文本引用，用于章内精确定位/裁前缀
 * 横向/纵向仅影响"起点定位"与"恢复定位"两个环节
 */
export class TxtContentProvider implements TTSContentProvider {
  readonly format: BookFormat = 'txt';

  #ctx: TxtContentProviderContext;
  #anchorLocator = new AnchorLocator();
  /** 会话内章节文本缓存（避免重复调用后端加载） */
  #chapterTextCache = new Map<number, string>();

  constructor(ctx: TxtContentProviderContext) {
    this.#ctx = ctx;
  }

  async getSegments(
    req: TTSContentProviderGetSegmentsRequest,
  ): Promise<TTSContentProviderBatch> {
    return await this.#getChapterSegments(req);
  }

  buildBackendRequest(
    req: TTSContentProviderGetSegmentsRequest,
  ): BackendTTSRequest | null {
    const filePath = this.#ctx.getFilePath();
    if (!filePath) return null;
    const startPosition = this.#resolveStartPosition(req);
    // 注意：fallbackSectionIndex 恒为章节索引（后端 txt.rs 按章节取片）
    const fallbackSectionIndex =
      startPosition?.sectionIndex ??
      (this.#ctx.getCurrentChapterIndex?.() ?? 0);
    return {
      bookId: this.#ctx.getBookId(),
      filePath,
      format: 'txt',
      cursor: req.cursor ?? null,
      maxSegments: req.maxSegments,
      startPosition,
      fallbackSectionIndex,
      readingMode: this.#ctx.isVerticalMode() ? 'vertical' : 'horizontal',
    };
  }

  locateAnchor(
    sectionIndex: number,
    anchor: TTSReadingAnchor | null | undefined,
  ): Range | null {
    if (!anchor) return null;
    if (this.#ctx.isVerticalMode()) {
      // 纵向：按章节对应的 DOM wrapper 定位（仅已加载窗口内可命中）
      for (const root of this.#resolveVerticalSectionRoots(sectionIndex)) {
        const range = this.#anchorLocator.locate(root, anchor);
        if (range) return range;
      }
      return null;
    }
    // 横向：当前章页已渲染，anchor 在当前页内则命中，否则返回 null（高亮跳过）
    const container = this.#ctx.getContainer();
    if (!container) return null;
    return this.#anchorLocator.locate(container, anchor);
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
    await this.#restoreHorizontal(position);
  }

  notifyDocumentUpdated(): void {
    this.#anchorLocator.invalidate();
  }

  /**
   * 朗读进度推进时的章节级对齐（横向模式专用）
   * - 跨章：自动切章并渲染章首页，实现听书跟读翻章
   * - 同章：朗读位置已越过当前渲染页时自动翻页
   * 返回 true 表示执行了翻页/切章
   */
  async followProgressPosition(
    position: TTSReadingPosition,
    previousSectionIndex: number,
  ): Promise<boolean> {
    if (this.#ctx.isVerticalMode()) return false;

    const chapterIndex = position.sectionIndex;
    const currentChapter = this.#ctx.getCurrentChapterIndex?.() ?? 0;

    // 跨章：朗读推进到新章节时切章（渲染章首页）
    if (chapterIndex !== currentChapter) {
      const goToChapterPage = this.#ctx.goToChapterPage;
      if (!goToChapterPage) return false;
      try {
        await goToChapterPage(chapterIndex, 1);
        return true;
      } catch (e) {
        log(`[TTS][Txt] 跟读切章失败: ${(e as Error).message ?? ''}`, 'warn');
        return false;
      }
    }

    // 同章：朗读位置所在页 > 当前渲染页时自动翻页（跨章由上层章节变化驱动）
    if (chapterIndex !== previousSectionIndex) return false;
    const pages = this.#ctx.getPages();
    const content = this.#ctx.getContent();
    if (pages.length <= 1 || !position.anchor) return false;
    const offset = findAnchorStartOffset(content, position.anchor);
    if (offset <= 0 || offset >= content.length) return false;
    let targetPage = 1;
    for (let i = 0; i < pages.length; i++) {
      if (offset < (pages[i]!.endOffset ?? 0)) {
        targetPage = i + 1;
        break;
      }
    }
    const currentPage = this.#ctx.getCurrentPage();
    if (targetPage > currentPage) {
      try {
        await this.#ctx.goToPage(targetPage);
        return true;
      } catch (e) {
        log(`[TTS][Txt] 跟读翻页失败: ${(e as Error).message ?? ''}`, 'warn');
      }
    }
    return false;
  }

  // ======================== 章节粒度取片 ========================

  /** 统一取片入口：逐章加载文本并切片，章末自动续下一章（跨章朗读） */
  async #getChapterSegments(
    req: TTSContentProviderGetSegmentsRequest,
  ): Promise<TTSContentProviderBatch> {
    const filePath = this.#ctx.getFilePath();
    if (!filePath) {
      return { segments: [], cursor: null, hasMore: false };
    }

    const bookId = this.#ctx.getBookId();
    // 元数据（章节总数）优先走缓存，未命中时从后端解析
    let meta = txtCacheService.getMetadata(bookId);
    if (!meta) {
      try {
        meta = await txtPreloader.getOrLoad(filePath);
      } catch {
        return { segments: [], cursor: null, hasMore: false };
      }
    }
    const totalChapters = meta.chapters.length;
    if (totalChapters === 0) {
      return { segments: [], cursor: null, hasMore: false };
    }

    // 起点解析：cursor 优先，其次 startPosition，最后当前阅读位置
    const cursor = decodeSectionCursor(req.cursor);
    let startChapter: number;
    let startChunk: number;
    if (cursor) {
      startChapter = Math.max(0, Math.min(cursor.sectionIndex, totalChapters - 1));
      startChunk = Math.max(0, cursor.chunkIndex);
    } else {
      const startPosition = this.#resolveStartPosition(req);
      const fallback = this.#ctx.getCurrentChapterIndex?.() ?? 0;
      startChapter = Math.max(
        0,
        Math.min(startPosition?.sectionIndex ?? fallback, totalChapters - 1),
      );
      startChunk = 0;
    }

    const segments: TTSSegment[] = [];
    let nextSection = startChapter;
    let nextChunk = startChunk;
    let hasMore = false;

    for (let i = 0; i < MAX_CHAPTERS_PER_BATCH; i++) {
      const idx = startChapter + i;
      if (idx >= totalChapters) break;
      const remaining = req.maxSegments - segments.length;
      if (remaining <= 0) {
        hasMore = true;
        nextSection = idx;
        nextChunk = idx === startChapter ? startChunk : 0;
        break;
      }

      const rawText = (await this.#loadChapterText(filePath, bookId, idx)).trim();
      if (!rawText) {
        nextSection = idx + 1;
        nextChunk = 0;
        continue;
      }

      const text = this.#trimByAnchorIfStart(rawText, idx, startChapter, startChunk, req);
      if (!text) {
        nextSection = idx + 1;
        nextChunk = 0;
        continue;
      }

      const sliceStart = idx === startChapter ? startChunk : 0;
      const result = sliceTextToSegments({
        idPrefix: `txt:${idx}`,
        text,
        sectionIndex: idx,
        startChunkIndex: sliceStart,
        maxSegments: remaining,
        encodeCursor: (sectionIndex, chunkIndex) =>
          encodeSectionCursor(sectionIndex, chunkIndex),
      });
      segments.push(...result.segments);
      if (result.hasMoreInText) {
        hasMore = true;
        nextSection = idx;
        nextChunk = result.nextChunkIndex;
        break;
      }
      nextSection = idx + 1;
      nextChunk = 0;
    }

    if (!hasMore) hasMore = nextSection < totalChapters;
    const outCursor = hasMore
      ? encodeSectionCursor(nextSection, nextChunk)
      : null;
    log(
      `[TTS][Txt] startChapter=${startChapter} startChunk=${startChunk} nextSection=${nextSection} produced=${segments.length} hasMore=${hasMore}`,
      segments.length > 0 ? 'info' : 'warn',
    );
    return { segments, cursor: outCursor, hasMore };
  }

  /** 加载指定章节文本：会话缓存 → 全局缓存 → 后端命令 */
  async #loadChapterText(
    filePath: string,
    bookId: string,
    chapterIndex: number,
  ): Promise<string> {
    const cached = this.#chapterTextCache.get(chapterIndex);
    if (cached !== undefined) return cached;

    const serviceCached = txtCacheService.getChapter(bookId, chapterIndex);
    if (serviceCached) {
      this.#chapterTextCache.set(chapterIndex, serviceCached.content);
      return serviceCached.content;
    }

    try {
      const invoke = await getInvoke();
      const chapters = await invoke<TxtChapterContent[]>('txt_load_chapter', {
        filePath,
        chapterIndex,
        extraChapters: null,
      });
      if (chapters.length > 0) {
        const chapter = chapters[0]!;
        txtCacheService.setChapter(bookId, chapter);
        this.#chapterTextCache.set(chapterIndex, chapter.content);
        return chapter.content;
      }
    } catch (e) {
      log(`[TTS][Txt] 章节 ${chapterIndex} 加载失败: ${String(e)}`, 'warn');
    }
    return '';
  }

  /** 仅当起点章命中 startPosition 时按 anchor 裁前缀（cursor 续读不裁） */
  #trimByAnchorIfStart(
    text: string,
    chapterIndex: number,
    startChapter: number,
    startChunk: number,
    req: TTSContentProviderGetSegmentsRequest,
  ): string {
    if (!text) return text;
    if (req.cursor) return text;
    if (startChunk > 0) return text;
    if (chapterIndex !== startChapter) return text;
    const startPosition = this.#resolveStartPosition(req);
    if (!startPosition?.anchor) return text;
    if (startPosition.sectionIndex !== chapterIndex) return text;
    const offset = findAnchorStartOffset(text, startPosition.anchor);
    if (offset <= 0 || offset >= text.length) return text;
    return text.slice(offset).trim();
  }

  /** cursor=null 时优先用调用方传入的 startPosition，否则用 ctx 提供的视口起点 */
  #resolveStartPosition(
    req: TTSContentProviderGetSegmentsRequest,
  ): TTSReadingPosition | null {
    if (req.cursor) return null;
    if (req.startPosition) return req.startPosition;
    return this.#ctx.getVisibleStartPosition?.() ?? null;
  }

  // ======================== 横向恢复定位 ========================

  /** 横向恢复：章节 + anchor → 章内字符偏移 → 章内页 → goToPage */
  async #restoreHorizontal(position: TTSReadingPosition): Promise<void> {
    const { sectionIndex } = position;
    if (sectionIndex < 0) return;

    // 目标章节与当前不同 → 先切章（渲染章首页）
    const currentChapter = this.#ctx.getCurrentChapterIndex?.() ?? 0;
    if (sectionIndex !== currentChapter) {
      const goToChapterPage = this.#ctx.goToChapterPage;
      if (!goToChapterPage) return;
      try {
        await goToChapterPage(sectionIndex, 1);
      } catch (e) {
        log(`[TTS][Txt] 横向恢复切章失败: ${(e as Error).message ?? ''}`, 'warn');
        return;
      }
    }

    const pages = this.#ctx.getPages();
    if (pages.length === 0) return;

    // anchor → 章内字符偏移 → 章内页码
    let targetPage = 1;
    if (position.anchor) {
      const content = this.#ctx.getContent();
      const offset = findAnchorStartOffset(content, position.anchor);
      if (offset > 0 && offset < content.length) {
        for (let i = 0; i < pages.length; i++) {
          if (offset < (pages[i]!.endOffset ?? 0)) {
            targetPage = i + 1;
            break;
          }
        }
        const lastEnd = pages[pages.length - 1]?.endOffset ?? 0;
        if (offset >= lastEnd) targetPage = pages.length;
      }
    }

    try {
      await this.#ctx.goToPage(targetPage);
    } catch (e) {
      log(`[TTS][Txt] 横向恢复失败: ${(e as Error).message ?? ''}`, 'warn');
    }
  }

  // ======================== 纵向 DOM 辅助（恢复定位/高亮） ========================

  #resolveVerticalSectionRoots(sectionIndex: number): HTMLElement[] {
    if (!this.#ctx.isVerticalMode()) return [];
    const container = this.#ctx.getContainer();
    if (!container) return [];
    return Array.from(
      container.querySelectorAll(`[data-chapter-index="${sectionIndex}"]`),
    ) as HTMLElement[];
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

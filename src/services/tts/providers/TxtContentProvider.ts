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
  findAnchorStartOffsetWithContext,
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
  /** 指定章节在拼接内容窗口中的字符区间（纵向窗口多章拼接时用于按内容偏移精确定位） */
  getChapterContentRange?: (chapterIndex: number) => { start: number; end: number } | null;
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
  /**
   * 上次成功定位的朗读位置（章内字符偏移）
   * 作为「朗读进度单调向前」的下界：同名句段在章内重复出现时，
   * 只接受不早于该偏移的命中，避免高亮/跟读滚动被拉回更早的重复句段
   */
  #lastLocatedOffset: { chapterIndex: number; offset: number } | null = null;

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
      // 纵向优先：按「章节内内容偏移」精确定位
      // 同名句段在章内（尤其是大页窗口）重复出现时，DOM 文本搜索只能取首次出现，
      // 会把高亮与跟读滚动拉回更早的重复句段（表现为“跳回上面”或“重读一个句段”）。
      // 这里用分片生成的上下文 + 进度下界换算真实偏移，再映射到段落 Range
      const offsetRange = this.#locateVerticalByOffset(sectionIndex, anchor);
      if (offsetRange) return offsetRange;

      // 兜底：容器/段落标注不可用（如非章节模式）时，沿用 DOM 文本搜索
      // 匹配顺序必须按视口重排，否则同一句话在更早页面出现时会把高亮与跟读滚动
      // 拉回那一页（表现为跳到章节开头，下一句才跳回朗读位置），详见 #orderRootsByViewport
      for (const root of this.#orderRootsByViewport(
        this.#resolveVerticalSectionRoots(sectionIndex),
      )) {
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

  /**
   * 纵向：换算 anchor 在章节文本中的偏移，并映射为已渲染段落的 DOM Range
   * 章节不在已加载窗口（无内容区间/无 data-char-offset）时返回 null，交由 DOM 搜索兜底
   */
  #locateVerticalByOffset(
    sectionIndex: number,
    anchor: TTSReadingAnchor,
  ): Range | null {
    const offset = this.#resolveAnchorOffset(sectionIndex, anchor);
    if (offset === null) return null;
    // 偏移解析成功后已记录进度下界；即使此次无法映射到已渲染段落，
    // 也保留该下界，保证窗口渲染出来后的下一句能落到正确位置
    return this.#rangeFromContentOffset(sectionIndex, offset, anchor.quote.length);
  }

  /**
   * 解析 anchor 在指定章节文本中的字符偏移（章节内坐标）
   * 内部按「上下文优先 + 进度下界」消歧，并把结果记为下一次定位的下界
   * @returns 命中偏移；章节文本不可用或无法命中时返回 null
   */
  #resolveAnchorOffset(
    chapterIndex: number,
    anchor: TTSReadingAnchor,
  ): number | null {
    const text = this.#getChapterText(chapterIndex);
    if (!text) return null;
    const floor =
      this.#lastLocatedOffset?.chapterIndex === chapterIndex
        ? this.#lastLocatedOffset.offset
        : 0;
    const offset = findAnchorStartOffsetWithContext(text, anchor, floor);
    if (offset < 0) return null;
    this.#lastLocatedOffset = { chapterIndex, offset };
    return offset;
  }

  /**
   * 取章节原文（章节内坐标 0 起）
   * 优先使用渲染器的拼接窗口区间（与 DOM 段落偏移同一坐标系），
   * 其次回退到会话/章节缓存
   */
  #getChapterText(chapterIndex: number): string | null {
    const range = this.#ctx.getChapterContentRange?.(chapterIndex);
    if (range) {
      const content = this.#ctx.getContent();
      if (range.end > range.start && range.end <= content.length) {
        return content.slice(range.start, range.end);
      }
      return null;
    }
    const cached = this.#chapterTextCache.get(chapterIndex);
    if (cached !== undefined) return cached;
    const serviceCached = txtCacheService.getChapter(this.#ctx.getBookId(), chapterIndex);
    return serviceCached ? serviceCached.content : null;
  }

  /**
   * 把「章节内偏移」映射为已渲染段落的 DOM Range
   * 依赖段落上的 data-char-offset（窗口绝对偏移）：取起始偏移不超过目标的最后一段
   */
  #rangeFromContentOffset(
    chapterIndex: number,
    offsetInChapter: number,
    quoteLength: number,
  ): Range | null {
    const chapterRange = this.#ctx.getChapterContentRange?.(chapterIndex);
    if (!chapterRange) return null;
    const target = chapterRange.start + offsetInChapter;
    const roots = this.#resolveVerticalSectionRoots(chapterIndex);
    if (roots.length === 0) return null;

    let paragraph: HTMLElement | null = null;
    let paragraphStart = -1;
    for (const root of roots) {
      const elements = root.querySelectorAll<HTMLElement>('[data-char-offset]');
      for (const el of elements) {
        const start = Number(el.dataset.charOffset);
        if (!Number.isFinite(start)) continue;
        if (start <= target && start > paragraphStart) {
          paragraphStart = start;
          paragraph = el;
        }
      }
    }
    if (!paragraph || paragraphStart < 0) return null;

    // TXT 段落为纯文本节点；结构异常时放弃，交由兜底逻辑处理
    const textNode = paragraph.firstChild;
    if (!textNode || textNode.nodeType !== Node.TEXT_NODE) return null;
    const text = textNode.textContent ?? '';
    const startInNode = target - paragraphStart;
    if (startInNode < 0 || startInNode >= text.length) return null;
    const endInNode = Math.min(text.length, startInNode + Math.max(1, quoteLength));
    const doc = paragraph.ownerDocument;
    if (!doc) return null;
    try {
      const range = doc.createRange();
      range.setStart(textNode, startInNode);
      range.setEnd(textNode, endInNode);
      return range;
    } catch {
      return null;
    }
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
        // 切章会全量重建容器 DOM（容器元素本身不变），
        // 必须失效 anchor 文本索引，否则后续高亮会命中已卸载的旧节点
        this.notifyDocumentUpdated();
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
    // 上下文优先 + 进度下界：同名句段重复时定位到朗读真正所在的那一次，
    // 否则会把偏移取到更早的重复句段而导致跟读不翻页/高亮倒退
    const offset = this.#resolveAnchorOffset(chapterIndex, position.anchor);
    if (offset === null || offset >= content.length) return false;
    // 章末边界（offset 落在最后一行行尾之后）兜底为最后一页，避免误翻第一页
    let targetPage = pages.length;
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
        // 翻页会全量重建容器 DOM（容器元素本身不变），必须失效 anchor 文本索引，
        // 否则紧随其后的高亮定位会失败或落在已卸载节点上（定位背景消失）
        this.notifyDocumentUpdated();
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
    // 上下文优先：起点句段在章内重复时，从正确那一次开始读，避免开篇重读一段
    const offset = findAnchorStartOffsetWithContext(text, startPosition.anchor, 0);
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
        // 切章重建容器 DOM，失效 anchor 索引以重新建立文本索引
        this.notifyDocumentUpdated();
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
      // 上下文优先 + 进度下界：同名句段重复时定位到真正朗读的那一次
      const offset = this.#resolveAnchorOffset(sectionIndex, position.anchor);
      if (offset !== null && offset < content.length) {
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
      // 恢复定位同样会重建容器 DOM，失效 anchor 索引
      this.notifyDocumentUpdated();
    } catch (e) {
      log(`[TTS][Txt] 横向恢复失败: ${(e as Error).message ?? ''}`, 'warn');
    }
  }

  // ======================== 纵向 DOM 辅助（恢复定位/高亮） ========================

  /**
   * 纵向页 wrapper 的匹配顺序：按「离当前视口由近及远」重排
   *
   * 动机：anchor 定位在前后文与 DOM 文本对不齐时会降级为「在该 root 内首次出现这句文本」
   * （见 utils/ttsDOM.ts 的候选式降级匹配）。若本章更早的页面出现过同一句话
   * （短句、常见对话很容易重复），按 DOM 顺序从章首页开始匹配就会命中那一页，
   * 高亮与跟读滚动被拉到更早的位置，下一句才回到朗读位置。
   * 朗读进度单调向前，正确命中页必在当前视口所在页或其之后，因此顺序取：
   * 视口所在页 → 其后各页（由近及远）→ 其前各页（由近及远）。
   */
  #orderRootsByViewport(roots: HTMLElement[]): HTMLElement[] {
    if (roots.length <= 1) return roots;
    const container = this.#ctx.getContainer();
    if (!container) return roots;
    const containerRect = container.getBoundingClientRect();
    // 容器不可见（尺寸为 0）时无法判断视口所在页，保持 DOM 顺序
    if (containerRect.height <= 0) return roots;
    const viewportTop = containerRect.top;
    // 视口所在页 = 顶部不超过视口顶部的最后一页；没有任何页命中时退回第一页
    let currentIndex = 0;
    for (let i = 0; i < roots.length; i++) {
      if (roots[i]!.getBoundingClientRect().top <= viewportTop + 1) {
        currentIndex = i;
      }
    }
    if (currentIndex === 0) return roots;
    const ordered: HTMLElement[] = [];
    for (let i = currentIndex; i < roots.length; i++) ordered.push(roots[i]!);
    for (let i = currentIndex - 1; i >= 0; i--) ordered.push(roots[i]!);
    return ordered;
  }

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

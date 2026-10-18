import type { BookFormat } from '../../formats/types';
import type { TTSReadingAnchor } from '../types';
import type {
  TTSContentProvider,
  TTSContentProviderBatch,
  TTSContentProviderGetSegmentsRequest,
  BackendTTSRequest,
  TTSReadingPosition,
} from './TTSContentProvider';
import { AnchorLocator } from './AnchorLocator';
import {
  EpubPositionRestorer,
  type EpubPositionRestorerContext,
} from './epub/EpubPositionRestorer';
import { invokeTTSGetSegments } from './backendBridge';
import { buildAnchorAtTextRatio, findTextOffsetByQuote } from '../../../utils/ttsAnchor';
import { log, logError } from '../../index';

/** EpubContentProvider 所需的上下文 */
export interface EpubContentProviderContext extends EpubPositionRestorerContext {
  /** 该书总章节数 */
  getTotalSections: () => number;
  /** 当前用户阅读到的章节索引 */
  getCurrentSectionIndex: () => number;
  /** Rust 端定位资源用的 bookId */
  getBookId: () => string | null;
  /** 原始书籍文件路径 */
  getFilePath: () => string;
  /** 取当前章节根 DOM，供 anchor 高亮 */
  getCurrentSectionRoot: () => Element | null;
  /** 取指定章节根 DOM（纵向模式多章节同时存在） */
  getSectionRootByIndex?: (sectionIndex: number) => Element | null;
  /** 取当前视口顶部位置（章节索引 + 起点 anchor），用于"从用户当前阅读处开始朗读" */
  getVisibleStartPosition?: () => TTSReadingPosition | null;
  /** 取不参与阅读顺序的章节下标（EPUB3 导航文档等），供后端跳过 */
  getHiddenSections?: () => number[];
  /** 章节标题（按 spine 索引，用于媒体通知） */
  getSectionTitle?: (sectionIndex: number) => string | null;
}

/**
 * EPUB 格式的 TTS 内容供给方
 * 内容拉取统一委托给 Rust 端 tts_get_segments；
 * 前端只保留 anchor 高亮定位与停止后的阅读位置回写。
 */
export class EpubContentProvider implements TTSContentProvider {
  readonly format: BookFormat = 'epub';

  #ctx: EpubContentProviderContext;
  #restorer: EpubPositionRestorer;
  #anchorLocator = new AnchorLocator();

  constructor(ctx: EpubContentProviderContext) {
    this.#ctx = ctx;
    this.#restorer = new EpubPositionRestorer({
      getReadingMode: ctx.getReadingMode,
      getContainer: ctx.getContainer,
      goToProgress: ctx.goToProgress,
      setSectionIndex: ctx.setSectionIndex,
      getCurrentSectionRoot: ctx.getCurrentSectionRoot,
    });
  }

  async getSegments(
    req: TTSContentProviderGetSegmentsRequest,
  ): Promise<TTSContentProviderBatch> {
    const request = this.buildBackendRequest(req);
    if (!request) return { segments: [], cursor: null, hasMore: false };
    try {
      const batch = await invokeTTSGetSegments(request);
      return {
        segments: batch.segments,
        cursor: batch.cursor,
        hasMore: batch.hasMore,
      };
    } catch (e) {
      logError('[TTS][EpubProvider] tts_get_segments 失败', e);
      return { segments: [], cursor: null, hasMore: false };
    }
  }

  buildBackendRequest(
    req: TTSContentProviderGetSegmentsRequest,
  ): BackendTTSRequest | null {
    const bookId = this.#ctx.getBookId();
    const filePath = this.#ctx.getFilePath();
    const totalSections = this.#ctx.getTotalSections();
    if (!bookId || !filePath || totalSections <= 0) {
      log(
        `[TTS][EpubProvider] backend skip: bookId=${bookId ?? ''} filePathLen=${filePath?.length ?? 0} totalSections=${totalSections}`,
        'warn',
      );
      return null;
    }
    const start = this.#resolveStartPosition(req);
    const hiddenSections = this.#ctx.getHiddenSections?.() ?? [];
    return {
      bookId,
      filePath,
      format: 'epub',
      cursor: req.cursor ?? null,
      maxSegments: req.maxSegments,
      startPosition: start,
      fallbackSectionIndex:
        start?.sectionIndex ?? this.#ctx.getCurrentSectionIndex(),
      totalSections,
      readingMode: this.#ctx.getReadingMode(),
      hiddenSections: hiddenSections.length > 0 ? hiddenSections : undefined,
    };
  }

  /**
   * cursor=null 且调用方未传 startPosition 时，从可视区域顶部计算起点
   */
  #resolveStartPosition(
    req: TTSContentProviderGetSegmentsRequest,
  ): TTSReadingPosition | null {
    if (req.cursor) return null;
    if (req.startPosition) return req.startPosition;
    return this.#ctx.getVisibleStartPosition?.() ?? null;
  }

  locateAnchor(
    sectionIndex: number,
    anchor: TTSReadingAnchor | null | undefined,
  ): Range | null {
    if (!anchor) return null;
    const root = this.#resolveSectionRoot(sectionIndex);
    return this.#anchorLocator.locate(root, anchor);
  }

  async restoreReadingPosition(position: TTSReadingPosition): Promise<void> {
    await this.#restorer.restore(position.sectionIndex, position.anchor);
  }

  async followProgressPosition(
    position: TTSReadingPosition,
    previousSectionIndex: number,
  ): Promise<boolean> {
    if (this.#ctx.getReadingMode() !== 'horizontal') return false;
    if (previousSectionIndex < 0) return false;
    if (position.sectionIndex === previousSectionIndex) return false;
    return this.#restorer.followHorizontalProgress(position.sectionIndex, position.anchor);
  }

  notifyDocumentUpdated(): void {
    this.#anchorLocator.invalidate();
  }

  /** 章节文本长度（用于媒体通知的章节时长估算） */
  getSectionTextLength(sectionIndex: number): number | null {
    const root = this.#resolveSectionRootExact(sectionIndex);
    const length = root?.textContent?.length ?? 0;
    return length > 0 ? length : null;
  }

  /** 把章节内比例换算成可朗读起点（进度条拖动） */
  buildAnchorAtRatio(sectionIndex: number, ratio: number): TTSReadingAnchor | null {
    const text = this.#resolveSectionRootExact(sectionIndex)?.textContent;
    return text ? buildAnchorAtTextRatio(text, ratio) : null;
  }

  /** 章节内可朗读字符数（去空白） */
  getSectionSpeakableLength(sectionIndex: number): number | null {
    const text = this.#resolveSectionRootExact(sectionIndex)?.textContent;
    if (!text) return null;
    const length = text.replace(/\s+/g, '').length;
    return length > 0 ? length : null;
  }

  /** 章节标题（媒体通知随朗读章节更新） */
  getSectionTitle(sectionIndex: number): string | null {
    const title = this.#ctx.getSectionTitle?.(sectionIndex)?.trim();
    return title ? title : null;
  }

  /** 相邻章节（跳过 EPUB3 隐藏章节） */
  getAdjacentSectionIndex(current: number, direction: 'prev' | 'next'): number | null {
    if (current < 0) return null;
    const total = this.#ctx.getTotalSections();
    if (total <= 0) return null;
    const hidden = new Set(this.#ctx.getHiddenSections?.() ?? []);
    let index = current + (direction === 'next' ? 1 : -1);
    while (index >= 0 && index < total) {
      if (!hidden.has(index)) return index;
      index += direction === 'next' ? 1 : -1;
    }
    return null;
  }

  /** 起播 anchor 在章节内的近似字符偏移（初始化进度条基准） */
  getAnchorTextOffset(
    sectionIndex: number,
    anchor: TTSReadingAnchor | null | undefined,
  ): number | null {
    if (!anchor?.quote) return null;
    const text = this.#resolveSectionRootExact(sectionIndex)?.textContent;
    return text ? findTextOffsetByQuote(text, anchor.quote) : null;
  }

  #resolveSectionRoot(sectionIndex: number): Element | null {
    if (this.#ctx.getSectionRootByIndex) {
      const byIndex = this.#ctx.getSectionRootByIndex(sectionIndex);
      if (byIndex) return byIndex;
    }
    return this.#ctx.getCurrentSectionRoot();
  }

  /**
   * 只返回“确实是该 index”的章节根。
   * 时长/进度/seek 不能用当前 root 兜底，否则章节切换瞬间会读到上一章文本；
   * 不支持按索引查询时才退回当前 root。
   */
  #resolveSectionRootExact(sectionIndex: number): Element | null {
    const byIndex = this.#ctx.getSectionRootByIndex?.(sectionIndex);
    if (byIndex) return byIndex;
    return this.#ctx.getSectionRootByIndex ? null : this.#ctx.getCurrentSectionRoot();
  }
}


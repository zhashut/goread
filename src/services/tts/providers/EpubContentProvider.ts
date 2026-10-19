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
import { fetchBackendSegmentsSafe } from './backendBridge';
import { resolveProviderStartPosition } from './TTSContentProvider';
import {
  buildAnchorAtTextRatio,
  findAnchorTextOffset,
  getSpeakableLength,
} from '../../../utils/ttsAnchor';
import { log } from '../../index';

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
 * 前端只保留 anchor 高亮定位与阅读位置恢复（章节对齐由 TTSSession 统一驱动）。
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
      isSectionRendered: ctx.isSectionRendered,
    });
  }

  async getSegments(
    req: TTSContentProviderGetSegmentsRequest,
  ): Promise<TTSContentProviderBatch> {
    const request = this.buildBackendRequest(req);
    if (!request) return { segments: [], cursor: null, hasMore: false };
    return fetchBackendSegmentsSafe(request, 'EpubProvider');
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
    const start = resolveProviderStartPosition(req, this.#ctx.getVisibleStartPosition);
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
   * 按 anchor 定位当前可高亮的 Range
   * 只在实际渲染了该章节时才定位；否则返回 null，交由上层先恢复章节
   */
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

  notifyDocumentUpdated(): void {
    this.#anchorLocator.invalidate();
  }

  /** 章节文本长度（用于媒体通知的章节时长估算） */
  getSectionTextLength(sectionIndex: number): number | null {
    const root = this.#resolveSectionRoot(sectionIndex);
    const length = root?.textContent?.length ?? 0;
    return length > 0 ? length : null;
  }

  /** 把章节内比例换算成可朗读起点（进度条拖动） */
  buildAnchorAtRatio(sectionIndex: number, ratio: number): TTSReadingAnchor | null {
    const text = this.#resolveSectionRoot(sectionIndex)?.textContent;
    return text ? buildAnchorAtTextRatio(text, ratio) : null;
  }

  getSectionSpeakableLength(sectionIndex: number): number | null {
    const text = this.#resolveSectionRoot(sectionIndex)?.textContent;
    if (!text) return null;
    const length = getSpeakableLength(text);
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
    const text = this.#resolveSectionRoot(sectionIndex)?.textContent;
    return findAnchorTextOffset(text, anchor);
  }

  /**
   * 取章节内容根
   * “确实是该 index”的判定统一在渲染器内（`EpubRenderer.getRenderedSectionShadowRoot`：
   * 横向比对实际渲染章节、纵向按已渲染章节集合），本方法不再重复判定，
   * 以免两处判据不同源（时长/进度/seek/高亮都不能用当前 root 兜底）。
   */
  #resolveSectionRoot(sectionIndex: number): Element | null {
    const byIndex = this.#ctx.getSectionRootByIndex?.(sectionIndex);
    if (byIndex) return byIndex;
    // 渲染器不支持按索引查询时（非 EPUB 上下文）才退回当前 root
    return this.#ctx.getSectionRootByIndex ? null : this.#ctx.getCurrentSectionRoot();
  }
}


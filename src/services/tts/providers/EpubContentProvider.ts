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

  #resolveSectionRoot(sectionIndex: number): Element | null {
    if (this.#ctx.getSectionRootByIndex) {
      const byIndex = this.#ctx.getSectionRootByIndex(sectionIndex);
      if (byIndex) return byIndex;
    }
    return this.#ctx.getCurrentSectionRoot();
  }
}


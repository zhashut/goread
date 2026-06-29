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
import { invokeTTSGetSegments } from './backendBridge';
import { log, logError } from '../../index';

/** MOBI Provider 上下文 */
export interface MobiContentProviderContext {
  /** Rust 端定位资源用的 bookId */
  getBookId: () => string | null;
  /** 原始书籍文件路径 */
  getFilePath: () => string | null;
  /** 章节总数 */
  getSectionCount: () => number;
  /** 当前 ShadowRoot，包含所有 .mobi-section 节点 */
  getShadowRoot: () => ShadowRoot | null;
  /** 滚动容器，回前台时定位高亮用 */
  getScrollContainer: () => HTMLElement | null;
  /** 取当前视口顶部位置（章节索引 + 起点 anchor），用于"从用户当前阅读处开始朗读" */
  getVisibleStartPosition?: () => TTSReadingPosition | null;
}

/**
 * MOBI 格式的 TTS 内容供给方
 * 内容拉取统一委托给 Rust 端 tts_get_segments；
 * 前端只保留 anchor 高亮定位与停止后的滚动回写。
 */
export class MobiContentProvider implements TTSContentProvider {
  readonly format: BookFormat = 'mobi';

  #ctx: MobiContentProviderContext;
  #anchorLocator = new AnchorLocator();

  constructor(ctx: MobiContentProviderContext) {
    this.#ctx = ctx;
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
      logError('[TTS][MobiProvider] tts_get_segments 失败', e);
      return { segments: [], cursor: null, hasMore: false };
    }
  }

  buildBackendRequest(
    req: TTSContentProviderGetSegmentsRequest,
  ): BackendTTSRequest | null {
    const bookId = this.#ctx.getBookId();
    const filePath = this.#ctx.getFilePath();
    const totalSections = this.#ctx.getSectionCount();
    if (!bookId || !filePath || totalSections <= 0) {
      log(
        `[TTS][MobiProvider] backend skip: bookId=${bookId ?? ''} filePathLen=${filePath?.length ?? 0} totalSections=${totalSections}`,
        'warn',
      );
      return null;
    }
    const start = this.#resolveStartPosition(req);
    const fallback = start?.sectionIndex ?? this.#findVisibleSectionIndex();
    return {
      bookId,
      filePath,
      format: 'mobi',
      cursor: req.cursor ?? null,
      maxSegments: req.maxSegments,
      startPosition: start,
      fallbackSectionIndex: fallback,
      totalSections,
    };
  }

  locateAnchor(
    sectionIndex: number,
    anchor: TTSReadingAnchor | null | undefined,
  ): Range | null {
    if (!anchor) return null;
    const sections = this.#getSections();
    const root = sections[sectionIndex] ?? null;
    return this.#anchorLocator.locate(root, anchor);
  }

  async restoreReadingPosition(position: TTSReadingPosition): Promise<void> {
    const sections = this.#getSections();
    const target = sections[position.sectionIndex];
    if (!target) return;
    target.scrollIntoView({ behavior: 'auto', block: 'start' });
  }

  notifyDocumentUpdated(): void {
    this.#anchorLocator.invalidate();
  }

  /** cursor=null 时优先用调用方传入的 startPosition，否则用 ctx 提供的视口起点 */
  #resolveStartPosition(
    req: TTSContentProviderGetSegmentsRequest,
  ): TTSReadingPosition | null {
    if (req.cursor) return null;
    if (req.startPosition) return req.startPosition;
    return this.#ctx.getVisibleStartPosition?.() ?? null;
  }

  #getSections(): HTMLElement[] {
    const shadow = this.#ctx.getShadowRoot();
    if (!shadow) return [];
    return Array.from(shadow.querySelectorAll('.mobi-section')) as HTMLElement[];
  }

  #findVisibleSectionIndex(): number {
    const sections = this.#getSections();
    if (sections.length === 0) return 0;
    const container = this.#ctx.getScrollContainer();
    if (!container) return 0;
    const center = container.scrollTop + container.clientHeight / 2;
    for (let i = 0; i < sections.length; i++) {
      const el = sections[i]!;
      const top = el.offsetTop;
      const bottom = top + el.offsetHeight;
      if (center >= top && center < bottom) return i;
    }
    return 0;
  }
}


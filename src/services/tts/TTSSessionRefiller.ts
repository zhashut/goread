import type {
  TTSContentProvider,
  IBackendSessionDriver,
} from './providers/TTSContentProvider';
import type { TTSSegment } from './types';
import { logError } from '../index';

/** Refill 的运行时回调 */
export interface TTSSessionRefillerOptions {
  provider: TTSContentProvider;
  driver: IBackendSessionDriver;
  /** 单批次最大 segment 数量 */
  batchSize: number;
}

/** Refill 状态对外只读快照 */
export interface TTSSessionRefillerSnapshot {
  cursor: string | null;
  endOfBook: boolean;
  pending: boolean;
}

/** Refill 触发提示：用于自适应放大批次 */
export interface TTSSessionRefillHint {
  /** Kotlin 上报的剩余朗读时长（秒）；越小越紧急 */
  estimatedSeconds?: number;
}

/** 紧急水位：剩余时长 ≤ 该值时一次拉双倍 */
const URGENT_REMAINING_SECONDS = 4;
/** 危险水位：剩余时长 ≤ 该值时一次拉三倍 */
const CRITICAL_REMAINING_SECONDS = 1.5;
/** 紧急倍率（双倍批次） */
const URGENT_MULTIPLIER = 2;
/** 危险倍率（三倍批次） */
const CRITICAL_MULTIPLIER = 3;

/**
 * 后台补给状态机：监听到 `request_more / waiting_more` 后从 Provider 拉取下一批
 * 并通过 driver.sessionPush 下发，结束时调用 sessionSetEndOfBook(true)
 * 与 TTSSession 解耦后，单元测试更容易，TTSSession 主类只关心生命周期与高亮
 */
export class TTSSessionRefiller {
  #options: TTSSessionRefillerOptions;
  /** 下次 refill 请求使用的 cursor（已拉取到的位置） */
  #fetchCursor: string | null = null;
  #endOfBook = false;
  #pending = false;
  #disposed = false;

  constructor(options: TTSSessionRefillerOptions) {
    this.#options = options;
  }

  /** 取首批 segments 并初始化 cursor / endOfBook */
  async loadFirst(
    maxSegments: number,
    explicitStart?: { sectionIndex: number; anchor: import('./types').TTSReadingAnchor | null },
  ): Promise<{
    segments: TTSSegment[];
    endOfBook: boolean;
  } | null> {
    const MAX_EMPTY_RETRIES = 8;
    let cursor: string | null = null;
    let startPositionForFirst:
      | { sectionIndex: number; anchor: import('./types').TTSReadingAnchor | null }
      | undefined = explicitStart;

    for (let attempt = 0; attempt <= MAX_EMPTY_RETRIES; attempt++) {
      try {
        const batch = await this.#options.provider.getSegments({
          cursor,
          maxSegments,
          startPosition: startPositionForFirst,
        });
        this.#fetchCursor = batch.cursor;
        this.#endOfBook = !batch.hasMore;

        if (batch.segments.length > 0) {
          return { segments: batch.segments, endOfBook: this.#endOfBook };
        }

        // 空批且已到书末，整本无可朗读内容
        if (this.#endOfBook) {
          return { segments: [], endOfBook: true };
        }

        // cursor 没有推进则视为卡住，避免死循环
        if (batch.cursor === null || batch.cursor === cursor) {
          return { segments: [], endOfBook: this.#endOfBook };
        }

        // cursor 已推进，用新 cursor 继续找下一段有内容的章节
        cursor = batch.cursor;
        startPositionForFirst = undefined;
      } catch (e) {
        logError('[TTSSession] 首批 getSegments 失败', e);
        return null;
      }
    }
    return { segments: [], endOfBook: this.#endOfBook };
  }

  /** 拉一批补给并 push 到 driver；endOfBook 已置则立即返回 */
  async refill(hint?: TTSSessionRefillHint): Promise<void> {
    if (this.#disposed || this.#endOfBook || this.#pending) return;
    this.#pending = true;
    // 补给从已预取的下一批起点继续，避免回退到已播放片段
    const cursorToFetch = this.#fetchCursor;
    const maxSegments = this.#computeBatchSize(hint);
    try {
      const batch = await this.#options.provider.getSegments({
        cursor: cursorToFetch,
        maxSegments,
      });
      if (this.#disposed) return;
      this.#fetchCursor = batch.cursor;
      if (batch.segments.length > 0) {
        try {
          await this.#options.driver.sessionPush(batch.segments);
        } catch (e) {
          logError('[TTSSession] sessionPush 失败', e);
        }
      }
      if (!batch.hasMore) {
        this.#endOfBook = true;
        try {
          await this.#options.driver.sessionSetEndOfBook(true);
        } catch (e) {
          logError('[TTSSession] sessionSetEndOfBook 失败', e);
        }
      }
    } catch (e) {
      logError('[TTSSession] refill 失败', e);
    } finally {
      this.#pending = false;
    }
  }

  /** 段播完事件：补给游标不依赖已播放位置 */
  notifySegmentDone(_cursor: string | undefined): void {}

  dispose(): void {
    this.#disposed = true;
  }

  snapshot(): TTSSessionRefillerSnapshot {
    return {
      cursor: this.#fetchCursor,
      endOfBook: this.#endOfBook,
      pending: this.#pending,
    };
  }

  /** 根据剩余朗读时长选择补给批次大小，越紧急一次拉得越多 */
  #computeBatchSize(hint?: TTSSessionRefillHint): number {
    const base = this.#options.batchSize;
    const remaining = hint?.estimatedSeconds;
    if (remaining == null || !Number.isFinite(remaining)) return base;
    if (remaining <= CRITICAL_REMAINING_SECONDS) return base * CRITICAL_MULTIPLIER;
    if (remaining <= URGENT_REMAINING_SECONDS) return base * URGENT_MULTIPLIER;
    return base;
  }
}

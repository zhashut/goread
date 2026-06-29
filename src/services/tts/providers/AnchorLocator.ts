import {
  createTextContentSearchCache,
  findRangeByTextQuote,
  type TextContentSearchCache,
  type TextQuote,
} from '../../../utils/ttsDOM';
import type { TTSReadingAnchor } from '../types';

/**
 * 基于 root DOM 缓存的 anchor 定位器
 * 三种格式 Provider 共用：根据 anchor 在指定 root 中查找 Range
 */
export class AnchorLocator {
  #cache: TextContentSearchCache | null = null;
  #cacheRoot: Element | null = null;

  /** 当前缓存的 root 发生变化时重建索引 */
  locate(root: Element | null, anchor: TTSReadingAnchor | null | undefined): Range | null {
    if (!root || !anchor) return null;
    if (this.#cacheRoot !== root) {
      this.#cache = createTextContentSearchCache(root);
      this.#cacheRoot = root;
    }
    if (!this.#cache) return null;
    const quote: TextQuote = {
      quote: anchor.quote,
      prefix: anchor.prefix,
      suffix: anchor.suffix,
    };
    return findRangeByTextQuote(this.#cache, quote);
  }

  /** 文档发生变化时调用，强制下一次 locate 重建缓存 */
  invalidate(): void {
    this.#cache = null;
    this.#cacheRoot = null;
  }
}


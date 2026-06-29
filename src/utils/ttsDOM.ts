/**
 * TTS DOM 工具函数
 * 提供在 DOM 中定位当前可见文本起始位置的能力，供 EPUB / MOBI 渲染器共用
 */

/**
 * 在指定 DOM 元素中查找视口顶部第一个可见的文本 Range
 * 横向模式（CSS columns 布局）：按当前内页可视区域扫描首个可见字符
 * 纵向模式：TreeWalker 遍历文本节点，按底部超过 viewport top 判定
 * @param contentEl 内容根元素（如 .epub-section-content 或 .mobi-section）
 * @param scrollContainer 滚动容器
 */
export function findFirstVisibleTextRange(
  contentEl: Element,
  scrollContainer: Element,
  axis: 'vertical' | 'horizontal' = 'vertical',
): Range | null {
  const ownerDoc = contentEl.ownerDocument;
  if (!ownerDoc) return null;

  const containerRect = scrollContainer.getBoundingClientRect();

  if (axis === 'horizontal') {
    return findFirstVisibleTextRangeHorizontal(ownerDoc, contentEl, containerRect);
  }

  return findFirstVisibleTextRangeVertical(ownerDoc, contentEl, containerRect);
}

/** 横向（columns 布局）下按当前内页可视区域定位首个可见字符 */
const findFirstVisibleTextRangeHorizontal = (
  ownerDoc: Document,
  contentEl: Element,
  containerRect: DOMRect,
): Range | null => {
  const walker = createVisibleTextWalker(ownerDoc, contentEl);
  let bestRange: Range | null = null;
  let bestTop = Number.POSITIVE_INFINITY;
  let bestLeft = Number.POSITIVE_INFINITY;

  let node: Node | null;
  while ((node = walker.nextNode())) {
    const range = findVisibleTextStartInNode(ownerDoc, node, containerRect);
    if (!range) continue;
    const rect = range.getBoundingClientRect();
    if (!isRectVisibleInHorizontalViewport(rect, containerRect)) continue;
    if (
      rect.top < bestTop ||
      (Math.abs(rect.top - bestTop) < 1 && rect.left < bestLeft)
    ) {
      bestRange = range;
      bestTop = rect.top;
      bestLeft = rect.left;
    }
  }
  return bestRange;
};

/** 纵向滚动下沿 TreeWalker 找第一个底部越过 viewport top 的文本节点 */
const findFirstVisibleTextRangeVertical = (
  ownerDoc: Document,
  contentEl: Element,
  containerRect: DOMRect,
): Range | null => {
  const walker = ownerDoc.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      if (!node.textContent?.trim()) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (parent) {
        const tag = parent.tagName.toLowerCase();
        if (tag === 'script' || tag === 'style') return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let node: Node | null;
  while ((node = walker.nextNode())) {
    const range = ownerDoc.createRange();
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    if (rect.bottom > containerRect.top) {
      range.setStart(node, 0);
      return range;
    }
  }
  return null;
};

const createVisibleTextWalker = (ownerDoc: Document, root: Element) => {
  return ownerDoc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      if (!node.textContent?.trim()) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (parent) {
        const tag = parent.tagName.toLowerCase();
        if (tag === 'script' || tag === 'style') return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
};

const findVisibleTextStartInNode = (
  ownerDoc: Document,
  node: Node,
  containerRect: DOMRect,
): Range | null => {
  const text = node.textContent ?? '';
  for (let i = 0; i < text.length; i++) {
    if (!text[i]?.trim()) continue;
    const range = ownerDoc.createRange();
    try {
      range.setStart(node, i);
      range.setEnd(node, Math.min(text.length, i + 1));
    } catch {
      continue;
    }
    const rect = range.getBoundingClientRect();
    if (!isRectVisibleInHorizontalViewport(rect, containerRect)) continue;
    return range;
  }
  return null;
};

const isRectVisibleInHorizontalViewport = (
  rect: DOMRect,
  containerRect: DOMRect,
): boolean => {
  if (!isFinite(rect.left) || !isFinite(rect.top)) return false;
  if (rect.width <= 0 || rect.height <= 0) return false;
  if (rect.right <= containerRect.left || rect.left >= containerRect.right) return false;
  if (rect.bottom <= containerRect.top || rect.top >= containerRect.bottom) return false;
  return true;
};

export type TextQuote = {
  quote: string;
  prefix?: string;
  suffix?: string;
};

export type TextContentSearchCache = {
  root: Element;
  rawText: string;
  normalizedText: string;
  normToRaw: number[];
};

const normalizeWhitespace = (text: string): string => {
  return text.replace(/\s+/g, ' ').trim();
};

const normalizeWhitespaceWithMap = (text: string): { normalizedText: string; normToRaw: number[] } => {
  let normalizedText = '';
  const normToRaw: number[] = [];

  let inWs = false;
  for (let rawIndex = 0; rawIndex < text.length; rawIndex++) {
    const ch = text[rawIndex]!;
    const isWs = /\s/.test(ch);

    if (isWs) {
      if (inWs) continue;
      inWs = true;
      normalizedText += ' ';
      normToRaw.push(rawIndex);
      continue;
    }

    inWs = false;
    normalizedText += ch;
    normToRaw.push(rawIndex);
  }

  if (normalizedText.length === 0) return { normalizedText: '', normToRaw: [] };

  let start = 0;
  while (start < normalizedText.length && normalizedText[start] === ' ') start++;

  let end = normalizedText.length;
  while (end > start && normalizedText[end - 1] === ' ') end--;

  if (start >= end) return { normalizedText: '', normToRaw: [] };

  return {
    normalizedText: normalizedText.slice(start, end),
    normToRaw: normToRaw.slice(start, end),
  };
};

const createTextWalker = (ownerDoc: Document, root: Element) => {
  return ownerDoc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = (node as any).parentElement as Element | null;
      if (parent) {
        const tag = parent.tagName.toLowerCase();
        if (tag === 'script' || tag === 'style') return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
};

export const createTextContentSearchCache = (root: Element): TextContentSearchCache | null => {
  const ownerDoc = root.ownerDocument;
  if (!ownerDoc) return null;

  const walker = createTextWalker(ownerDoc, root);
  const parts: string[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    parts.push(node.textContent ?? '');
  }

  const rawText = parts.join('');
  if (!rawText.trim()) return null;

  const { normalizedText, normToRaw } = normalizeWhitespaceWithMap(rawText);
  if (!normalizedText) return null;

  return { root, rawText, normalizedText, normToRaw };
};

const findTextQuoteOffsetsInCache = (
  cache: TextContentSearchCache,
  quote: TextQuote,
): { start: number; end: number } | null => {
  const prefix = normalizeWhitespace(quote.prefix ?? '');
  const q = normalizeWhitespace(quote.quote);
  const suffix = normalizeWhitespace(quote.suffix ?? '');
  if (!q) return null;

  const candidates: Array<{ pattern: string; quoteOffsetInPattern: number }> = [
    {
      pattern: [prefix, q, suffix].filter(Boolean).join(' '),
      quoteOffsetInPattern: prefix ? prefix.length + 1 : 0,
    },
    {
      pattern: [q, suffix].filter(Boolean).join(' '),
      quoteOffsetInPattern: 0,
    },
    {
      pattern: [prefix, q].filter(Boolean).join(' '),
      quoteOffsetInPattern: prefix ? prefix.length + 1 : 0,
    },
    { pattern: q, quoteOffsetInPattern: 0 },
  ].filter((c) => c.pattern.trim().length > 0);

  for (const { pattern, quoteOffsetInPattern } of candidates) {
    const idx = cache.normalizedText.indexOf(pattern);
    if (idx < 0) continue;

    const quoteNormStart = idx + quoteOffsetInPattern;
    const quoteNormEnd = quoteNormStart + q.length;
    if (quoteNormStart < 0 || quoteNormEnd > cache.normToRaw.length) continue;

    const rawStart = cache.normToRaw[quoteNormStart];
    const rawEnd = cache.normToRaw[Math.max(0, quoteNormEnd - 1)] + 1;
    if (rawStart == null || rawEnd == null) continue;
    if (rawStart >= rawEnd) continue;

    return { start: rawStart, end: rawEnd };
  }

  return null;
};

export const rangeFromTextOffsets = (
  root: Element,
  start: number,
  end: number,
): Range | null => {
  const ownerDoc = root.ownerDocument;
  if (!ownerDoc) return null;
  if (start < 0 || end <= start) return null;

  const walker = createTextWalker(ownerDoc, root);

  let node: Node | null;
  let cursor = 0;
  let startNode: Node | null = null;
  let startOffset = 0;
  let endNode: Node | null = null;
  let endOffset = 0;

  while ((node = walker.nextNode())) {
    const text = node.textContent ?? '';
    const nextCursor = cursor + text.length;

    if (!startNode && start >= cursor && start <= nextCursor) {
      startNode = node;
      startOffset = Math.max(0, Math.min(text.length, start - cursor));
    }

    if (end >= cursor && end <= nextCursor) {
      endNode = node;
      endOffset = Math.max(0, Math.min(text.length, end - cursor));
      break;
    }

    cursor = nextCursor;
  }

  if (!startNode || !endNode) return null;

  const range = ownerDoc.createRange();
  try {
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    return range;
  } catch {
    return null;
  }
};

/**
 * 把 DOM Range 转成 TextQuote 形态的 anchor
 * 取 quote 长度上限内的可读文字，并用前后 contextLength 字符作为 prefix/suffix
 */
export const rangeToTextQuote = (
  range: Range,
  options?: { quoteLength?: number; contextLength?: number; searchRoot?: Element | null },
): TextQuote | null => {
  const quoteLength = options?.quoteLength ?? 24;
  const contextLength = options?.contextLength ?? 24;

  const startNode = range.startContainer;
  const ownerDoc = startNode.ownerDocument;
  if (!ownerDoc) return null;

  const searchRoot = options?.searchRoot ?? inferSearchRootFromRange(range);
  if (!searchRoot) return null;

  const cache = createTextContentSearchCache(searchRoot);
  if (!cache) return null;

  const offset = locateRangeStartOffset(cache, range);
  if (offset == null) return null;

  const raw = cache.rawText;
  const quoteEnd = Math.min(raw.length, offset + quoteLength);
  const quote = raw.slice(offset, quoteEnd).trim();
  if (!quote) return null;
  const prefix = raw.slice(Math.max(0, offset - contextLength), offset);
  const suffix = raw.slice(quoteEnd, Math.min(raw.length, quoteEnd + contextLength));
  return { quote, prefix, suffix };
};

/** 未显式指定 searchRoot 时，从 range 起点向上推断一个范围尽量大的搜索根 */
const inferSearchRootFromRange = (range: Range): Element | null => {
  const startNode = range.startContainer;
  const root = startNode.getRootNode?.();
  const ownerDoc = startNode.ownerDocument;
  if (!ownerDoc) return null;

  const rootElement = (root instanceof ShadowRoot ? root : ownerDoc) as ParentNode;
  const containerEl =
    range.commonAncestorContainer.nodeType === 1
      ? (range.commonAncestorContainer as Element)
      : (range.commonAncestorContainer.parentElement ?? null);
  const candidate = containerEl ?? (rootElement as Element);
  return candidate instanceof Element ? candidate : null;
};

/** 计算 Range.startContainer + startOffset 在 cache.rawText 中的字符偏移 */
const locateRangeStartOffset = (
  cache: TextContentSearchCache,
  range: Range,
): number | null => {
  const ownerDoc = cache.root.ownerDocument;
  if (!ownerDoc) return null;
  const walker = createTextWalker(ownerDoc, cache.root);
  let node: Node | null;
  let cursor = 0;
  while ((node = walker.nextNode())) {
    if (node === range.startContainer) {
      const offsetInNode = Math.max(
        0,
        Math.min(range.startOffset, (node.textContent ?? '').length),
      );
      return cursor + offsetInNode;
    }
    cursor += (node.textContent ?? '').length;
  }
  return null;
};

export const findRangeByTextQuote = (
  cache: TextContentSearchCache,
  quote: TextQuote,
): Range | null => {
  const offsets = findTextQuoteOffsetsInCache(cache, quote);
  if (!offsets) return null;
  return rangeFromTextOffsets(cache.root, offsets.start, offsets.end);
};


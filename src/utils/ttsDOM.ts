/**
 * TTS DOM 工具函数
 * 提供在 DOM 中定位当前可见文本起始位置的能力，供 EPUB / MOBI 渲染器共用
 */

/**
 * 在指定 DOM 元素中查找视口顶部第一个可见的文本 Range
 * 使用 TreeWalker 遍历文本节点，通过 getBoundingClientRect 判断是否进入视口
 * @param contentEl 内容根元素（如 .epub-section-content 或 .mobi-section）
 * @param scrollContainer 滚动容器
 * @returns 指向第一个可见文本节点的 Range，或 null
 */
export function findFirstVisibleTextRange(
  contentEl: Element,
  scrollContainer: Element,
): Range | null {
  const containerRect = scrollContainer.getBoundingClientRect();
  const viewportTop = containerRect.top;

  const ownerDoc = contentEl.ownerDocument;
  if (!ownerDoc) return null;

  const walker = ownerDoc.createTreeWalker(
    contentEl,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) => {
        if (!node.textContent?.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (parent) {
          const tag = parent.tagName.toLowerCase();
          if (tag === 'script' || tag === 'style') return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    },
  );

  let node: Node | null;
  while ((node = walker.nextNode())) {
    const range = ownerDoc.createRange();
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();

    // 文本节点底部超过视口顶部，说明这是第一个可见（或部分可见）的文本
    if (rect.bottom > viewportTop) {
      range.setStart(node, 0);
      return range;
    }
  }

  return null;
}

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

export const findRangeByTextQuote = (
  cache: TextContentSearchCache,
  quote: TextQuote,
): Range | null => {
  const offsets = findTextQuoteOffsetsInCache(cache, quote);
  if (!offsets) return null;
  return rangeFromTextOffsets(cache.root, offsets.start, offsets.end);
};

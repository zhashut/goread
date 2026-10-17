import type { TTSReadingAnchor } from '../services/tts/types';

/**
 * 文本比例 → 可朗读起点 anchor。
 *
 * 用于媒体通知进度条拖动：给定章节文本和 0~1 比例，切出一段带上下文的
 * quote（尽量从句子边界开始），供 TTS 会话从该位置重新起播。
 *
 * 说明：
 * - 只负责“挑一段合适朗读的文本”，不保证与 DOM 完全一致；
 * - quote 会做空白归一化，便于 AnchorLocator 在渲染文本中匹配。
 */

const SENTENCE_BOUNDARY = /[。！？!?.;；\n\r]/;
const MAX_FORWARD_SCAN = 120;
const QUOTE_LENGTH = 36;
const MAX_QUOTE_EXTEND = 12;
const CONTEXT_LENGTH = 20;
const MIN_QUOTE_LENGTH = 4;

const clampRatio = (ratio: number): number => {
  if (!Number.isFinite(ratio)) return 0;
  return Math.min(0.999, Math.max(0, ratio));
};

const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();

export const buildAnchorAtTextRatio = (
  text: string,
  ratio: number,
): TTSReadingAnchor | null => {
  if (!text) return null;
  const length = text.length;
  const target = Math.floor(clampRatio(ratio) * length);

  // 1) 尽量从 target 之后的第一个句末标点后开始，避免切在句中
  let start = target;
  const scanEnd = Math.min(length, target + MAX_FORWARD_SCAN);
  while (start < scanEnd && !SENTENCE_BOUNDARY.test(text[start] ?? '')) start++;
  if (start < scanEnd) {
    start += 1;
  } else {
    // 扫描范围内没有句末标点：退回 target，并向前对齐到词/空白边界
    start = target;
    while (start > 0 && !/\s/.test(text[start - 1] ?? '')) start--;
  }

  // 2) 跳过起始空白
  while (start < length && /\s/.test(text[start] ?? '')) start++;
  if (start >= length - MIN_QUOTE_LENGTH) return null;

  // 3) 截取 quote，尽量在词/标点边界结束，避免截断单词
  let end = Math.min(length, start + QUOTE_LENGTH);
  while (
    end < length &&
    end - start < QUOTE_LENGTH + MAX_QUOTE_EXTEND &&
    !/[\s。！？!?.;；，、]/.test(text[end] ?? '')
  ) {
    end++;
  }

  const quote = normalize(text.slice(start, end));
  if (quote.length < MIN_QUOTE_LENGTH) return null;

  const prefix = normalize(text.slice(Math.max(0, start - CONTEXT_LENGTH), start));
  const suffix = normalize(text.slice(end, Math.min(length, end + CONTEXT_LENGTH)));
  return {
    quote,
    ...(prefix ? { prefix } : {}),
    ...(suffix ? { suffix } : {}),
  };
};


/**
 * 在章节文本中查找 anchor.quote 的近似字符偏移。
 * 用于把“起播位置”换算成章节进度基准；找不到时返回 null。
 */
export const findTextOffsetByQuote = (
  text: string,
  quote: string | undefined,
): number | null => {
  if (!text || !quote) return null;
  const direct = text.indexOf(quote);
  if (direct >= 0) return direct;
  // 空白归一化后再查一次，并按比例映射回原文本长度（仅用于估算进度）
  const normalized = text.replace(/\s+/g, ' ');
  const normalizedQuote = quote.replace(/\s+/g, ' ').trim();
  if (!normalizedQuote) return null;
  const index = normalized.indexOf(normalizedQuote);
  if (index < 0) return null;
  return Math.floor((index / Math.max(1, normalized.length)) * text.length);
};

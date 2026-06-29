import type { TTSReadingAnchor, TTSSegment } from '../services/tts/types';
import { splitTextToSentences } from './ttsSentenceSplitter';
import { encodeSectionCursor } from './ttsSegment';

/** 单句最大长度阈值，超过此长度的句子会被进一步硬拆 */
const SENTENCE_HARD_SPLIT_LENGTH = 200;
/** anchor 上下文窗口长度，便于在 DOM 中精准定位 */
const ANCHOR_CONTEXT_LENGTH = 24;

/**
 * 在整段文本中根据 anchor 计算起始偏移量
 * 三层匹配策略，逐级降级：
 * 1. 直接按 quote indexOf 命中
 * 2. prefix+quote+suffix 拼接后 indexOf
 * 3. 规范化空白后再 indexOf，映射回原文偏移（应对 DOM 与 rawHtml textContent 的空白差异）
 * 三种格式 Provider 共用
 */
export const findAnchorStartOffset = (
  text: string,
  anchor: TTSReadingAnchor | null | undefined,
): number => {
  if (!anchor?.quote) return 0;

  const directIndex = text.indexOf(anchor.quote);
  if (directIndex >= 0) return directIndex;

  const prefix = anchor.prefix?.trim();
  const suffix = anchor.suffix?.trim();
  const pattern = [prefix, anchor.quote, suffix].filter(Boolean).join(' ');
  const patternIndex = pattern ? text.indexOf(pattern) : -1;
  if (patternIndex >= 0) {
    const quoteIndex = pattern.indexOf(anchor.quote);
    if (quoteIndex >= 0) return patternIndex + quoteIndex;
  }

  return findAnchorOffsetByNormalizedWhitespace(text, anchor.quote);
};

/** 规范化空白后匹配：克服 DOM 与 rawHtml 之间细微的空白差异 */
const findAnchorOffsetByNormalizedWhitespace = (text: string, quote: string): number => {
  const normalizedQuote = quote.replace(/\s+/g, '');
  if (!normalizedQuote) return 0;

  let normalizedText = '';
  const normToRaw: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (/\s/.test(ch)) continue;
    normalizedText += ch;
    normToRaw.push(i);
  }

  const idx = normalizedText.indexOf(normalizedQuote);
  if (idx < 0) return 0;
  return normToRaw[idx] ?? 0;
};

/** 在指定区间生成 anchor，附带前后上下文用于 DOM 定位 */
const createAnchor = (text: string, start: number, end: number): TTSReadingAnchor => {
  return {
    quote: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - ANCHOR_CONTEXT_LENGTH), start),
    suffix: text.slice(end, Math.min(text.length, end + ANCHOR_CONTEXT_LENGTH)),
  };
};

/** 把 chunk 添加进数组，自动 trim 并跳过空串 */
const pushChunk = (chunks: string[], chunk: string): void => {
  const trimmed = chunk.trim();
  if (trimmed) {
    chunks.push(trimmed);
  }
};

/** 长文本兜底拆分：按标点优先，否则按硬切 */
const splitLongText = (text: string, maxLength: number): string[] => {
  const chunks: string[] = [];
  let remaining = text.trim();

  while (remaining.length > maxLength) {
    const slice = remaining.slice(0, maxLength);
    const breakAt = Math.max(
      slice.lastIndexOf('，'),
      slice.lastIndexOf('、'),
      slice.lastIndexOf('；'),
      slice.lastIndexOf('：'),
      slice.lastIndexOf(', '),
      slice.lastIndexOf('; '),
      slice.lastIndexOf(': '),
    );
    const cutAt = breakAt > 0 ? breakAt + 1 : maxLength;
    pushChunk(chunks, remaining.slice(0, cutAt));
    remaining = remaining.slice(cutAt).trim();
  }

  pushChunk(chunks, remaining);
  return chunks;
};

/**
 * 按句切片：每一句作为独立 chunk，超长句子用 splitLongText 进一步硬拆
 * 切片单位即朗读单位即高亮单位，三者保持一致
 */
export const splitTextToChunks = (
  text: string,
  hardSplitLength = SENTENCE_HARD_SPLIT_LENGTH,
): string[] => {
  const sentences = splitTextToSentences(text);
  if (sentences.length === 0) {
    return splitLongText(text, hardSplitLength);
  }

  const chunks: string[] = [];
  for (const sentence of sentences) {
    if (sentence.length > hardSplitLength) {
      chunks.push(...splitLongText(sentence, hardSplitLength));
    } else {
      pushChunk(chunks, sentence);
    }
  }
  return chunks;
};

/** 切片结果 */
export interface SliceTextResult {
  segments: TTSSegment[];
  nextChunkIndex: number;
  hasMoreInText: boolean;
}

/** 切片选项 */
export interface SliceTextOptions {
  /** 段 id 前缀（如 `epub:0` / `mobi:3` / `txt-h:5`） */
  idPrefix: string;
  /** 待切的整段文本 */
  text: string;
  /** 该段所属的章节索引（用于 anchor 定位与 cursor 编码） */
  sectionIndex: number;
  /** 起始 chunk 序号，用于 cursor 续传 */
  startChunkIndex?: number;
  /** 单批次允许产出的最大 segment 数量 */
  maxSegments?: number;
  /** 朗读语言（透传到 segment 上） */
  lang?: string;
  /** 自定义 cursor 编码方式，默认 sectionIndex:chunkIndex */
  encodeCursor?: (sectionIndex: number, chunkIndex: number) => string;
}

/**
 * 把整段文本切成 TTSSegment 数组
 * 支持中途暂停：若达到 maxSegments 上限则返回 hasMoreInText=true 和续传位置
 */
export const sliceTextToSegments = (options: SliceTextOptions): SliceTextResult => {
  const {
    idPrefix,
    text,
    sectionIndex,
    startChunkIndex = 0,
    maxSegments,
    lang,
    encodeCursor,
  } = options;
  const cursorEncoder = encodeCursor ?? encodeSectionCursor;
  const chunks = splitTextToChunks(text);
  const segments: TTSSegment[] = [];
  let searchOffset = 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const foundAt = text.indexOf(chunk, searchOffset);
    const start = foundAt >= 0 ? foundAt : searchOffset;
    const end = Math.min(text.length, start + chunk.length);
    searchOffset = end;

    if (i < startChunkIndex) continue;
    if (maxSegments != null && segments.length >= maxSegments) {
      return {
        segments,
        nextChunkIndex: i,
        hasMoreInText: true,
      };
    }

    segments.push({
      id: `${idPrefix}:${i}`,
      text: chunk,
      lang,
      sectionIndex,
      chunkIndex: i,
      cursor: cursorEncoder(sectionIndex, i),
      anchor: createAnchor(text, start, end),
    });
  }

  return {
    segments,
    nextChunkIndex: chunks.length,
    hasMoreInText: false,
  };
};


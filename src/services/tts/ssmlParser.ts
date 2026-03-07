import type { TTSMark } from './types';

/** 清理文本中的换行和多余空白 */
const cleanTextContent = (text: string) =>
  text.replace(/\r\n/g, '  ').replace(/\r/g, ' ').replace(/\n/g, ' ').trimStart();

/** 简单的中英文推断 */
const inferLang = (text: string, defaultLang: string): string => {
  if (/[\u4e00-\u9fff]/.test(text)) return 'zh';
  return defaultLang || 'en';
};

/** 判断 mark 文本是否有效（非纯标点/符号） */
const isValidMark = (mark: string) => {
  const trimmed = mark.trim();
  if (!trimmed || trimmed.length === 0) return false;
  if (/^[\p{P}\p{S}]+$/u.test(trimmed)) return false;
  return true;
};

/** 从 SSML 中提取主语言 */
export const parseSSMLLang = (ssml: string, primaryLang?: string): string => {
  let lang = 'en';
  const match = ssml.match(/xml:lang\s*=\s*"([^"]+)"/);
  if (match && match[1]) {
    const parts = match[1].split('-');
    lang = parts[0]!.toLowerCase();
  }
  // 如果 SSML 声明为 en，但实际主语言不同，使用主语言
  if (lang === 'en' && primaryLang && primaryLang.substring(0, 2).toLowerCase() !== 'en') {
    lang = primaryLang.substring(0, 2).toLowerCase();
  }
  // 从文本内容推断
  const textOnly = ssml.replace(/<[^>]+>/g, '');
  return inferLang(textOnly, lang);
};

/**
 * 解析 SSML 为 TTSMark 数组
 * 参照 readest 的 parseSSMLMarks 实现
 */
export const parseSSMLMarks = (ssml: string, primaryLang?: string): { plainText: string; marks: TTSMark[] } => {
  const defaultLang = parseSSMLLang(ssml, primaryLang) || 'en';
  ssml = ssml.replace(/<speak[^>]*>/i, '').replace(/<\/speak>/i, '');

  let plainText = '';
  const marks: TTSMark[] = [];
  let activeMark: string | null = null;
  let currentLang = defaultLang;
  const langStack: string[] = [];

  const tagRegex = /<(\/?)(\w+)([^>]*)>|([^<]+)/g;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(ssml)) !== null) {
    if (match[4]) {
      // 文本节点
      const rawText = match[4];
      const text = cleanTextContent(rawText);
      if (text && activeMark && isValidMark(text)) {
        const offset = plainText.length;
        plainText += text;
        marks.push({
          offset,
          name: activeMark,
          text,
          language: inferLang(text, currentLang),
        });
      } else {
        plainText += cleanTextContent(rawText);
      }
    } else {
      const isEnd = match[1] === '/';
      const tagName = match[2];
      const attr = match[3];

      if (tagName === 'mark' && !isEnd) {
        const nameMatch = attr?.match(/name="([^"]+)"/);
        if (nameMatch) {
          activeMark = nameMatch[1]!;
        }
      } else if (tagName === 'lang') {
        if (!isEnd) {
          langStack.push(currentLang);
          const langMatch = attr?.match(/xml:lang="([^"]+)"/);
          if (langMatch) {
            currentLang = langMatch[1]!;
          }
        } else {
          currentLang = langStack.pop() ?? defaultLang;
        }
      }
    }
  }

  return { plainText, marks };
};

/**
 * SSML 预处理：清理特殊字符
 * 参照 readest TTSController 的 preprocessSSML
 */
export const preprocessSSML = (ssml: string): string => {
  return ssml
    .replace(/<emphasis[^>]*>([^<]+)<\/emphasis>/g, '$1')
    .replace(/[–—]/g, ',')
    .replace('<break/>', ' ')
    .replace(/\.{3,}/g, '   ')
    .replace(/……/g, '  ')
    .replace(/\*/g, ' ')
    .replace(/·/g, ' ');
};

/**
 * 将纯文本转为简单 SSML（TXT 格式使用）
 */
export const textToSSML = (text: string, lang?: string): string => {
  const resolvedLang = lang || inferLang(text, 'en');
  const sentences = splitTextToSentences(text);
  let ssml = `<speak xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${resolvedLang}">`;
  sentences.forEach((sentence, i) => {
    ssml += `<mark name="${i}"/>${escapeXml(sentence)} `;
  });
  ssml += '</speak>';
  return ssml;
};

/** 按句子分割纯文本 */
export const splitTextToSentences = (text: string): string[] => {
  const paragraphs = text.split(/\n+/).filter(p => p.trim());
  const sentences: string[] = [];
  for (const para of paragraphs) {
    const parts = para.split(/(?<=[。！？；.!?;])\s*/);
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed) sentences.push(trimmed);
    }
  }
  return sentences;
};

/** XML 转义 */
const escapeXml = (str: string): string => {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
};

/** 段落分割的回退字符阈值，无明确段落时按此长度分块 */
const FALLBACK_CHUNK_SIZE = 500;

/**
 * 纯文本按段落迭代器
 * 将大段纯文本按段落切分，每次 start()/next() 返回单个段落的 SSML，
 * 与 foliate-js TTS 的 DOM 路径统一迭代接口
 */
export class TextBlockIterator {
  #blocks: string[];
  #index = -1;
  #lang: string;

  constructor(text: string, lang?: string) {
    this.#lang = lang || inferLang(text, 'en');
    this.#blocks = this.#splitToBlocks(text);
  }

  /** 开始迭代，返回第一个段落的 SSML */
  start(): string | null {
    this.#index = 0;
    return this.#currentSSML();
  }

  /**
   * 从指定字符偏移位置开始迭代
   * 定位到包含 offset 的段落，截取该段落剩余文本作为首段 SSML
   * offset 超出范围时降级为从头开始
   */
  startFrom(charOffset: number): string | null {
    let accumulated = 0;
    for (let i = 0; i < this.#blocks.length; i++) {
      const blockLen = this.#blocks[i]!.length;
      if (accumulated + blockLen > charOffset) {
        const withinOffset = charOffset - accumulated;
        const remaining = this.#blocks[i]!.substring(withinOffset).trim();
        if (remaining) {
          this.#index = i;
          return textToSSML(remaining, this.#lang);
        }
        // 当前 block 剩余为空，跳到下一个
        this.#index = i + 1;
        return this.#currentSSML();
      }
      accumulated += blockLen + 1; // +1 段落分隔符
    }
    // offset 超出范围，降级为从头开始
    return this.start();
  }

  /** 前进到下一个段落，返回 SSML；无更多段落时返回 null */
  next(): string | null {
    this.#index++;
    return this.#currentSSML();
  }

  /** 当前段落生成 SSML */
  #currentSSML(): string | null {
    if (this.#index < 0 || this.#index >= this.#blocks.length) return null;
    const block = this.#blocks[this.#index]!;
    return textToSSML(block, this.#lang);
  }

  /**
   * 将文本按段落分割为 block 数组
   * 无明确段落分隔时按固定字符数分块
   */
  #splitToBlocks(text: string): string[] {
    const paragraphs = text.split(/\n+/).map(p => p.trim()).filter(Boolean);

    // 有多个段落，直接使用
    if (paragraphs.length > 1) return paragraphs;

    // 只有一段或没有换行，按句子边界 + 字符阈值分块
    const single = paragraphs[0] ?? text.trim();
    if (!single) return [];
    if (single.length <= FALLBACK_CHUNK_SIZE) return [single];

    return this.#splitBySize(single, FALLBACK_CHUNK_SIZE);
  }

  /** 按句子边界和字符阈值对长文本分块 */
  #splitBySize(text: string, maxSize: number): string[] {
    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxSize) {
        chunks.push(remaining);
        break;
      }
      // 在 maxSize 范围内寻找最后一个句子结束符
      const slice = remaining.slice(0, maxSize);
      const lastBreak = Math.max(
        slice.lastIndexOf('。'),
        slice.lastIndexOf('！'),
        slice.lastIndexOf('？'),
        slice.lastIndexOf('. '),
        slice.lastIndexOf('! '),
        slice.lastIndexOf('? '),
        slice.lastIndexOf('；'),
      );
      const cutAt = lastBreak > 0 ? lastBreak + 1 : maxSize;
      chunks.push(remaining.slice(0, cutAt).trim());
      remaining = remaining.slice(cutAt).trim();
    }
    return chunks.filter(Boolean);
  }
}

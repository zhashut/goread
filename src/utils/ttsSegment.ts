import type { TTSSegment, TTSReadingAnchor } from '../services/tts/types';

/** 章节级 cursor 结构：sectionIndex + chunkIndex */
export interface SectionCursor {
  sectionIndex: number;
  chunkIndex: number;
}

/** 把 sectionIndex + chunkIndex 编码成稳定字符串 */
export const encodeSectionCursor = (sectionIndex: number, chunkIndex: number): string => {
  return `${sectionIndex}:${chunkIndex}`;
};

/** 解析章节级 cursor，无效返回 null */
export const decodeSectionCursor = (cursor: string | null | undefined): SectionCursor | null => {
  if (!cursor) return null;
  const [sectionPart, chunkPart] = cursor.split(':');
  const sectionIndex = Number.parseInt(sectionPart ?? '', 10);
  const chunkIndex = Number.parseInt(chunkPart ?? '0', 10);
  if (!Number.isFinite(sectionIndex) || !Number.isFinite(chunkIndex)) return null;
  return { sectionIndex, chunkIndex };
};

/** 单页级 cursor：用于 TXT 横向分页等扁平结构 */
export const encodePageCursor = (pageIndex: number): string => {
  return `page:${pageIndex}`;
};

/** 解析单页级 cursor，返回页码索引 */
export const decodePageCursor = (cursor: string | null | undefined): number | null => {
  if (!cursor || !cursor.startsWith('page:')) return null;
  const value = Number.parseInt(cursor.slice('page:'.length), 10);
  return Number.isFinite(value) ? value : null;
};

/** 把后台 segment 旧结构转成新会话 segment */
export const toSessionSegment = (params: {
  id: string;
  text: string;
  lang?: string;
  sectionIndex: number;
  chunkIndex: number;
  cursor: string;
  anchor?: TTSReadingAnchor | null;
}): TTSSegment => {
  return {
    id: params.id,
    text: params.text,
    lang: params.lang,
    sectionIndex: params.sectionIndex,
    chunkIndex: params.chunkIndex,
    cursor: params.cursor,
    anchor: params.anchor ?? null,
  };
};


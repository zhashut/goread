import { useState, useEffect, useCallback, useMemo } from 'react';
import { TocNode } from '../types';
import { IBook } from '../../../types';
import { bookService } from '../../../services/bookService';
import { logError } from '../../../services/commonService';

// 排序方式
export type TocSortMode = 'default' | 'name';

const STORAGE_KEY_PREFIX = 'book_toc_sort:';

// 位运算编码规则：bit0 = 排序方式(0=默认,1=名称)，bit1 = 倒序(0=正序,1=倒序)
const encodeTocSort = (mode: TocSortMode, reversed: boolean): number => {
    return (mode === 'name' ? 1 : 0) | (reversed ? 2 : 0);
};

const decodeTocSort = (value: number | null | undefined): { mode: TocSortMode; reversed: boolean } => {
    const v = value ?? 0;
    return {
        mode: (v & 1) === 1 ? 'name' : 'default',
        reversed: (v & 2) === 2,
    };
};

// 中文数字映射
const CN_NUM: Record<string, number> = {
    '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4,
    '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10,
    '百': 100, '千': 1000, '万': 10000, '亿': 100000000,
};

const isCnNum = (ch: string) => ch in CN_NUM;

/** 中文数字转阿拉伯数字（反向解析），如 "二百五十一" → 251，"十三" → 13 */
const cnToNum = (s: string): number => {
    if (s.length === 0) return NaN;
    // 校验：全部字符都是合法中文数字
    for (const ch of s) if (!isCnNum(ch)) return NaN;

    let result = 0, temp = 0, unit = 1;
    for (let i = s.length - 1; i >= 0; i--) {
        const v = CN_NUM[s[i]];
        if (v >= 10) {
            unit = v > unit ? v : unit * v;
            if (i === 0) result += unit; // 处理 "十三" 这种省略 "一" 的写法
        } else {
            temp = v * unit;
            result += temp;
            unit = unit >= 10 ? unit : 1; // 重置低位 unit
        }
    }
    return result || NaN;
};

// 将标题拆分为交替的「文本段 / 数字段」，数字段包含阿拉伯数字和中文数字
const SEGMENT_RE = /(\d+)|([零〇一二两三四五六七八九十百千万亿]+)/g;

type Segment = { text: string } | { num: number };

/** 将字符串拆分为文本和数字交替的片段序列（自然排序核心） */
const tokenize = (s: string): Segment[] => {
    const segments: Segment[] = [];
    let lastIdx = 0;

    for (const m of s.matchAll(SEGMENT_RE)) {
        // 匹配位置前的纯文本
        if (m.index! > lastIdx) {
            segments.push({ text: s.slice(lastIdx, m.index!) });
        }
        if (m[1]) {
            // 阿拉伯数字
            segments.push({ num: parseInt(m[1], 10) });
        } else if (m[2]) {
            const n = cnToNum(m[2]);
            // 有效中文数字作为数字段，否则当作文本
            segments.push(!isNaN(n) ? { num: n } : { text: m[2] });
        }
        lastIdx = m.index! + m[0].length;
    }
    if (lastIdx < s.length) {
        segments.push({ text: s.slice(lastIdx) });
    }
    return segments;
};

const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });

/** 自然排序比较：逐段对比数字和文本 */
const naturalCompare = (a: string, b: string): number => {
    const sa = tokenize(a), sb = tokenize(b);
    const len = Math.min(sa.length, sb.length);

    for (let i = 0; i < len; i++) {
        const pa = sa[i], pb = sb[i];
        const aIsNum = 'num' in pa, bIsNum = 'num' in pb;

        // 类型不同：数字段排在文本段前面
        if (aIsNum !== bIsNum) return aIsNum ? -1 : 1;

        if (aIsNum && bIsNum) {
            const diff = (pa as { num: number }).num - (pb as { num: number }).num;
            if (diff !== 0) return diff;
        } else {
            const diff = collator.compare((pa as { text: string }).text, (pb as { text: string }).text);
            if (diff !== 0) return diff;
        }
    }
    return sa.length - sb.length;
};

/** 只对顶层目录排序，子目录保持原始顺序 */
const sortTocNodes = (nodes: TocNode[], mode: TocSortMode, reversed: boolean): TocNode[] => {
    if (!nodes || nodes.length === 0) return nodes;

    let sorted = [...nodes];

    if (mode === 'name') {
        sorted.sort((a, b) => naturalCompare(a.title, b.title));
    }

    if (reversed) sorted.reverse();

    return sorted;
};

export interface UseTocSortResult {
    sortedToc: TocNode[];
    sortMode: TocSortMode;
    isReversed: boolean;
    setSortMode: (mode: TocSortMode) => void;
    toggleReverse: () => void;
}

/**
 * 管理目录排序配置的 Hook
 * 支持按名称排序和倒序排列，配置按书籍粒度持久化
 */
export const useTocSort = (toc: TocNode[], book?: IBook | null): UseTocSortResult => {
    const [sortMode, setSortModeState] = useState<TocSortMode>('default');
    const [isReversed, setIsReversed] = useState(false);

    // 从 book 或 localStorage 初始化
    useEffect(() => {
        if (!book) return;

        const { mode, reversed } = decodeTocSort(book.toc_sort);
        setSortModeState(mode);
        setIsReversed(reversed);
    }, [book?.id, book?.toc_sort]);

    // 持久化排序配置
    const persistSort = useCallback(async (mode: TocSortMode, reversed: boolean) => {
        if (!book) return;
        const encoded = encodeTocSort(mode, reversed);

        try {
            if (book.id) {
                await bookService.updateBookTocSort(book.id, encoded);
            }
            // localStorage 兜底（外部文件场景）
            const key = book.id
                ? `${STORAGE_KEY_PREFIX}${book.id}`
                : `${STORAGE_KEY_PREFIX}external:${book.file_path}`;
            localStorage.setItem(key, String(encoded));
        } catch (error) {
            logError('Failed to save toc_sort', { error: String(error) });
        }
    }, [book]);

    const setSortMode = useCallback((mode: TocSortMode) => {
        setSortModeState(mode);
        persistSort(mode, isReversed);
    }, [isReversed, persistSort]);

    const toggleReverse = useCallback(() => {
        const next = !isReversed;
        setIsReversed(next);
        persistSort(sortMode, next);
    }, [isReversed, sortMode, persistSort]);

    // 计算排序后的目录
    const sortedToc = useMemo(() => {
        if (sortMode === 'default' && !isReversed) return toc;
        return sortTocNodes(toc, sortMode, isReversed);
    }, [toc, sortMode, isReversed]);

    return {
        sortedToc,
        sortMode,
        isReversed,
        setSortMode,
        toggleReverse,
    };
};

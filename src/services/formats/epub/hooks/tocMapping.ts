import { TocItem } from '../../types';
import { log } from '../../../index';

/** 已知未匹配的 sectionIndex 集合，避免重复日志 */
const unmatchedSections = new Set<string>();

/** 去除锚点，返回纯路径 */
const stripAnchor = (href: string): string => href.split('#')[0];

/** 提取文件名部分（最后一段路径） */
const getFileName = (href: string): string => href.split('/').pop() || '';

/**
 * 根据 spine 索引查找对应的 TOC href
 * 匹配策略（优先级递减）：
 *   1. 精确匹配（含锚点）
 *   2. 去锚点后精确匹配
 *   3. endsWith 匹配（处理路径前缀不一致，如 OEBPS/Text/x.xhtml vs Text/x.xhtml）
 *   4. 文件名匹配（兜底）
 */
export const getTocHrefForSection = (
  sectionIndex: number,
  toc?: TocItem[],
  spine?: string[],
): string | null => {
  if (!toc || toc.length === 0 || !spine || !spine[sectionIndex]) return null;

  const currentHref = spine[sectionIndex];
  const spineBase = stripAnchor(currentHref);
  const spineFileName = getFileName(spineBase);

  // 扁平化 TOC 树
  const flat: TocItem[] = [];
  const walk = (items: TocItem[]) => {
    for (const item of items) {
      flat.push(item);
      if (item.children && item.children.length > 0) {
        walk(item.children);
      }
    }
  };
  walk(toc);

  // 按优先级查找：精确 -> 去锚点精确 -> endsWith -> 文件名
  let matched: TocItem | undefined;

  // 优先级 1 & 2：精确匹配 / 去锚点精确匹配
  matched = flat.find((item) => {
    if (!item.location) return false;
    const locStr = String(item.location);
    if (locStr === currentHref) return true;
    const locBase = stripAnchor(locStr);
    return locBase === spineBase;
  });

  // 优先级 3：endsWith 匹配（处理路径前缀差异）
  if (!matched) {
    matched = flat.find((item) => {
      if (!item.location) return false;
      const locBase = stripAnchor(String(item.location));
      return spineBase.endsWith(locBase) || locBase.endsWith(spineBase);
    });
  }

  // 优先级 4：文件名匹配（兜底，注意可能误匹配同名文件）
  if (!matched && spineFileName) {
    matched = flat.find((item) => {
      if (!item.location) return false;
      const locFileName = getFileName(stripAnchor(String(item.location)));
      return locFileName === spineFileName;
    });
  }

  if (matched && matched.location) {
    return String(matched.location);
  }

  // 匹配失败属于正常情况（cover/titlepage 等非正文章节不在 TOC 中），仅首次记录
  const logKey = `${sectionIndex}:${currentHref}`;
  if (!unmatchedSections.has(logKey)) {
    unmatchedSections.add(logKey);
    log(
      `[Epub] TOC 未匹配: spine[${sectionIndex}]=${currentHref}`,
    ).catch(() => {});
  }
  return null;
};

/**
 * 根据 TOC href 查找 spine 索引
 * 用于目录跳转：点击目录项(href) → 找到对应 spine 章节索引
 */
export const getSpineIndexForHref = (
  href: string,
  spine?: string[],
): number => {
  if (!spine || spine.length === 0 || !href) return -1;

  const hrefBase = stripAnchor(href);
  const hrefFileName = getFileName(hrefBase);

  // 精确匹配 / 去锚点精确匹配
  let idx = spine.findIndex((s) => {
    if (s === href) return true;
    return stripAnchor(s) === hrefBase;
  });
  if (idx >= 0) return idx;

  // endsWith 匹配（处理路径前缀差异）
  idx = spine.findIndex((s) => {
    const sBase = stripAnchor(s);
    return sBase.endsWith(hrefBase) || hrefBase.endsWith(sBase);
  });
  if (idx >= 0) return idx;

  // 文件名匹配
  if (hrefFileName) {
    idx = spine.findIndex((s) => getFileName(stripAnchor(s)) === hrefFileName);
    if (idx >= 0) return idx;
  }

  return -1;
};


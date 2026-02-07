import { TocItem } from '../../types';
import { logError } from '../../../index';

export const getTocHrefForSection = (
  sectionIndex: number,
  toc?: TocItem[],
  spine?: string[],
): string | null => {
  if (!toc || toc.length === 0 || !spine || !spine[sectionIndex]) return null;

  const currentHref = spine[sectionIndex];

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

  const matched = flat.find((item) => {
    if (!item.location) return false;
    const locStr = String(item.location);
    const itemPath = locStr.split('#')[0];
    return locStr === currentHref || itemPath === currentHref;
  });

  if (matched && matched.location) {
    const matchedLoc = String(matched.location);
    return matchedLoc;
  }

  logError(
    `[EpubHorizontal] TOC 匹配失败: spine[${sectionIndex}]=${currentHref}`,
  ).catch(() => {});
  return null;
};


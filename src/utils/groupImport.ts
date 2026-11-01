import { groupService } from "../services";
import { waitNextFrame } from "../services/importUtils";
import type { IGroup, IBook } from "../types";
import { getBookFormat } from "../constants/fileTypes";
import {
  MARKDOWN_COVER_PLACEHOLDER,
  HTML_COVER_PLACEHOLDER,
  TXT_COVER_PLACEHOLDER,
} from "../constants/ui";

export const buildGroupCoversFromBooks = (books: IBook[] | null | undefined): string[] => {
  const covers: string[] = [];
  for (const b of books || []) {
    if (covers.length >= 4) break;
    let img = b.cover_image || "";
    if (!img) {
      const fmt = getBookFormat(b.file_path);
      if (fmt === "markdown") {
        img = MARKDOWN_COVER_PLACEHOLDER;
      } else if (fmt === "html") {
        img = HTML_COVER_PLACEHOLDER;
      } else if (fmt === "txt") {
        img = TXT_COVER_PLACEHOLDER;
      }
    }
    if (img) {
      covers.push(img);
    }
  }
  return covers;
};

export const loadGroupsWithPreviews = async (): Promise<{ groups: IGroup[]; previews: Record<number, string[]> }> => {
  const gs = await groupService.getAllGroups();
  const groups: IGroup[] = gs || [];
  const previews: Record<number, string[]> = {};
  for (const g of groups) {
    try {
      const books = await groupService.getBooksByGroup(g.id);
      const covers = buildGroupCoversFromBooks(books || []);
      previews[g.id] = covers;
    } catch {
      previews[g.id] = [];
    }
  }
  return { groups, previews };
};

/**
 * 将待导入路径分配到指定分组并完成导入（先回调 onFinished 关闭抽屉，下一帧再执行导入）。
 *
 * 参数：pendingPaths 待导入路径列表；groupId 目标分组 id，null 表示不分组（书籍留在书架根目录）；onFinished 导入开始前回调
 * 返回值：导入完成后 resolve；失败由调用方捕获处理
 */
export const assignToExistingGroupAndFinish = async (
  pendingPaths: string[],
  groupId: number | null,
  onFinished: () => void
): Promise<void> => {
  onFinished();
  await waitNextFrame();
  const { importPathsToExistingGroup } = await import("../services/importRunner");
  await importPathsToExistingGroup(pendingPaths, groupId);
};

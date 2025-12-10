import { groupService } from "../services";
import { waitNextFrame } from "../services/importUtils";
import type { IGroup } from "../types";
import { getBookFormat } from "../constants/fileTypes";
import { MARKDOWN_COVER_PLACEHOLDER } from "../constants/ui";

export const loadGroupsWithPreviews = async (): Promise<{ groups: IGroup[]; previews: Record<number, string[]> }> => {
  const gs = await groupService.getAllGroups();
  const groups: IGroup[] = gs || [];
  const previews: Record<number, string[]> = {};
  for (const g of groups) {
    try {
      const books = await groupService.getBooksByGroup(g.id);
      const covers: string[] = [];
      for (const b of books || []) {
        if (covers.length >= 4) break;
        if (b.cover_image) covers.push(b.cover_image);
      }
      if (covers.length < 4) {
        for (const b of books || []) {
          if (covers.length >= 4) break;
          if (!b.cover_image && getBookFormat(b.file_path) === "markdown") {
            covers.push(MARKDOWN_COVER_PLACEHOLDER);
          }
        }
      }
      previews[g.id] = covers;
    } catch {}
  }
  return { groups, previews };
};

export const assignToExistingGroupAndFinish = async (
  pendingPaths: string[],
  groupId: number,
  onFinished: () => void
): Promise<void> => {
  onFinished();
  await waitNextFrame();
  const { importPathsToExistingGroup } = await import("../services/importRunner");
  await importPathsToExistingGroup(pendingPaths, groupId);
};

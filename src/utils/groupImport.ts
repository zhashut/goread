import { groupService } from "../services";
import { waitNextFrame } from "../services/importUtils";
import type { IGroup } from "../types";

export const loadGroupsWithPreviews = async (): Promise<{ groups: IGroup[]; previews: Record<number, string[]> }> => {
  const gs = await groupService.getAllGroups();
  const groups: IGroup[] = gs || [];
  const previews: Record<number, string[]> = {};
  for (const g of groups) {
    try {
      const books = await groupService.getBooksByGroup(g.id);
      previews[g.id] = (books || [])
        .map((b) => b.cover_image)
        .filter(Boolean)
        .slice(0, 4) as string[];
    } catch {}
  }
  return { groups, previews };
};

export const assignToExistingGroupAndFinish = async (
  pendingPaths: string[],
  groupId: number,
  navigate: (path: string) => void
): Promise<void> => {
  navigate("/?tab=all");
  await waitNextFrame();
  const { importPathsToExistingGroup } = await import("../services/importRunner");
  await importPathsToExistingGroup(pendingPaths, groupId);
};

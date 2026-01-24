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

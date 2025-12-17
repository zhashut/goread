import { useState } from "react";
import { IGroup } from "../types";
import { loadGroupsWithPreviews, assignToExistingGroupAndFinish } from "../utils/groupImport";
import { waitNextFrame } from "../services/importUtils";
import { logError } from "../services";

type UseImportGroupingOptions = {
  onFinishImport: () => void;
};

export const useImportGrouping = (options: UseImportGroupingOptions) => {
  const [groupingOpen, setGroupingOpen] = useState(false);
  const [chooseGroupOpen, setChooseGroupOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [pendingImportPaths, setPendingImportPaths] = useState<string[]>([]);
  const [allGroups, setAllGroups] = useState<IGroup[]>([]);
  const [groupPreviews, setGroupPreviews] = useState<Record<number, string[]>>(
    {}
  );
  const [groupingLoading, setGroupingLoading] = useState(false);

  const openGroupingWithPaths = (paths: string[]) => {
    if (!paths.length) return;
    setPendingImportPaths(paths);
    setGroupingOpen(true);
  };

  const openChooseGroup = async () => {
    try {
      const { groups, previews } = await loadGroupsWithPreviews();
      setAllGroups(groups || []);
      setGroupPreviews(previews);
      setChooseGroupOpen(true);
    } catch (e) {
      console.error("Load groups failed", e);
      setAllGroups([]);
      setChooseGroupOpen(true);
    }
  };

  const assignToGroupAndFinish = async (groupId: number) => {
    try {
      setGroupingLoading(true);
      setGroupingOpen(false);
      setChooseGroupOpen(false);
      await assignToExistingGroupAndFinish(pendingImportPaths, groupId, () => {
        options.onFinishImport();
      });
      setGroupingLoading(false);
    } catch (e) {
      setGroupingLoading(false);
      alert("分组保存失败，请重试");
      await logError("assignToGroupAndFinish failed", {
        error: String(e),
        pendingImportPaths,
        groupId,
      });
    }
  };

  const createGroupAndFinish = async (name: string) => {
    if (!name.trim()) return;
    try {
      setGroupingLoading(true);
      setGroupingOpen(false);
      setChooseGroupOpen(false);
      options.onFinishImport();
      await waitNextFrame();
      const { createGroupAndImport } = await import("../services/importRunner");
      await createGroupAndImport(pendingImportPaths, name.trim());
      setGroupingLoading(false);
    } catch (e) {
      setGroupingLoading(false);
      alert("创建分组失败，请重试");
      await logError("createGroupAndFinish failed", {
        error: String(e),
        name: name.trim(),
      });
    }
  };

  return {
    groupingOpen,
    chooseGroupOpen,
    newGroupName,
    setNewGroupName,
    pendingImportPaths,
    allGroups,
    groupPreviews,
    groupingLoading,
    setGroupingOpen,
    setChooseGroupOpen,
    openGroupingWithPaths,
    openChooseGroup,
    assignToGroupAndFinish,
    createGroupAndFinish,
  };
};


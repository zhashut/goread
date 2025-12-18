import { useState, useEffect, useRef } from "react";
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

  // 历史记录管理：GroupingDrawer
  const isGroupingPopping = useRef(false);
  useEffect(() => {
    if (groupingOpen) {
      const currentState = window.history.state;
      const state =
        typeof currentState === "object" && currentState !== null
          ? { ...currentState, drawer: "grouping" }
          : { drawer: "grouping" };
      window.history.pushState(state, "");

      const onPop = (e: PopStateEvent) => {
        // 如果回退后依然是 grouping 状态（说明是从更深层回退回来的），则不关闭
        if (e.state?.drawer === "grouping") return;

        isGroupingPopping.current = true;
        setGroupingOpen(false);
        setTimeout(() => (isGroupingPopping.current = false), 0);
      };

      window.addEventListener("popstate", onPop);
      return () => {
        window.removeEventListener("popstate", onPop);
        if (!isGroupingPopping.current) {
          window.history.back();
        }
      };
    }
  }, [groupingOpen]);

  // 历史记录管理：ChooseExistingGroupDrawer
  const isChoosePopping = useRef(false);
  useEffect(() => {
    if (chooseGroupOpen) {
      const currentState = window.history.state;
      const state =
        typeof currentState === "object" && currentState !== null
          ? { ...currentState, drawer: "choose" }
          : { drawer: "choose" };
      window.history.pushState(state, "");

      const onPop = (_e: PopStateEvent) => {
        isChoosePopping.current = true;
        setChooseGroupOpen(false);
        setTimeout(() => (isChoosePopping.current = false), 0);
      };

      window.addEventListener("popstate", onPop);
      return () => {
        window.removeEventListener("popstate", onPop);
        if (!isChoosePopping.current) {
          window.history.back();
        }
      };
    }
  }, [chooseGroupOpen]);

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


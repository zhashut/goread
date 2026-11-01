import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { IGroup } from "../types";
import { loadGroupsWithPreviews, assignToExistingGroupAndFinish } from "../utils/groupImport";
import { waitNextFrame } from "../services/importUtils";
import { logError } from "../services";

type UseImportGroupingOptions = {
  onFinishImport: () => void;
  /** WiFi 接收文件暂存成功后回调（携带原路径列表，用于上层同步清除“待导入”记录） */
  onWifiStaged?: (originalPaths: string[]) => void;
};

export const useImportGrouping = (options: UseImportGroupingOptions) => {
  const { t: tCommon } = useTranslation('common');
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
      await logError('加载分组失败', { error: String(e) });
      setAllGroups([]);
      setChooseGroupOpen(true);
    }
  };

  /**
   * WiFi 接收文件入库暂存：确认导入后把 wifi_uploads 内的文件移动到
   * 应用书库目录 library/（书籍以新路径入库），实现传输完成后上传目录不留历史。
   *
   * 参数：paths 待导入路径列表（可能混合多种来源）
   * 返回值：实际用于导入的路径列表；暂存失败时降级返回原路径（不影响导入）
   */
  const stageWifiUploads = async (paths: string[]): Promise<string[]> => {
    try {
      const staged = await invoke<Array<{ from: string; to: string }>>(
        "wifi_stage_to_library",
        { paths }
      );
      const movedFrom = staged
        .filter((s) => s.from !== s.to)
        .map((s) => s.from);
      if (movedFrom.length) {
        options.onWifiStaged?.(movedFrom);
      }
      return staged.map((s) => s.to);
    } catch (e) {
      // 降级：暂存失败不阻断导入，文件保留在 wifi_uploads 原路径
      await logError("wifi_stage_to_library failed", { error: String(e) });
      return paths;
    }
  };

  /**
   * 分配到指定分组并完成导入（含 WiFi 上传文件暂存）。
   *
   * 参数：groupId 目标分组 id；null 表示不分组，书籍直接落在书架根目录
   * 返回值：无（异步执行导入，失败时弹窗提示并记录日志）
   */
  const assignToGroupAndFinish = async (groupId: number | null) => {
    try {
      setGroupingLoading(true);
      setGroupingOpen(false);
      setChooseGroupOpen(false);
      const importPaths = await stageWifiUploads(pendingImportPaths);
      await assignToExistingGroupAndFinish(importPaths, groupId, () => {
        options.onFinishImport();
      });
      setGroupingLoading(false);
    } catch (e) {
      setGroupingLoading(false);
      alert(tCommon('groupSaveFailed'));
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
      const importPaths = await stageWifiUploads(pendingImportPaths);
      const { createGroupAndImport } = await import("../services/importRunner");
      await createGroupAndImport(importPaths, name.trim());
      setGroupingLoading(false);
    } catch (e) {
      setGroupingLoading(false);
      alert(tCommon('groupCreateFailed'));
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


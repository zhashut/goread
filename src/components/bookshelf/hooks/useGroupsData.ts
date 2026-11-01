import { useState, useEffect, useMemo, useCallback } from "react";
import { IGroup } from "../../../types";
import { groupService, logError } from "../../../services";

/**
 * 管理分组数据的 Hook
 * 负责分组列表加载、过滤（分组卡片为文件夹图标占位，不再加载封面）
 */
export const useGroupsData = (query: string) => {
    const [groups, setGroups] = useState<IGroup[]>([]);

    const loadGroups = useCallback(async () => {
        try {
            const allGroups = await groupService.getAllGroups();
            // 分组统一按名称 A→Z 排序（中文按拼音），不再使用 sort_order 手动排序
            const collator = new Intl.Collator("zh-Hans-CN");
            setGroups((allGroups || []).sort((a, b) => collator.compare(a.name || "", b.name || "")));
        } catch (error) {
            await logError('加载分组列表失败', { error: String(error) });
            setGroups([]);
        }
    }, []);

    // 监听分组变化事件
    useEffect(() => {
        const onGroupsChanged = () => {
            loadGroups();
        };
        window.addEventListener("goread:groups:changed", onGroupsChanged as any);
        return () =>
            window.removeEventListener(
                "goread:groups:changed",
                onGroupsChanged as any
            );
    }, [loadGroups]);

    // 基于搜索关键词过滤
    const filteredGroups = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return groups;
        return groups.filter((g) => (g.name || "").toLowerCase().includes(q));
    }, [groups, query]);

    return {
        groups,
        setGroups,
        loadGroups,
        filteredGroups,
    };
};

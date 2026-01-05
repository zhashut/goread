import { useState, useEffect, useMemo, useCallback } from "react";
import { IGroup } from "../../../types";
import { groupService, logError } from "../../../services";
import { getBookFormat } from "../../../constants/fileTypes";
import {
    MARKDOWN_COVER_PLACEHOLDER,
    HTML_COVER_PLACEHOLDER,
} from "../../../constants/ui";

/**
 * 管理分组数据的 Hook
 * 负责分组列表加载、封面获取、过滤
 */
export const useGroupsData = (query: string) => {
    const [groups, setGroups] = useState<IGroup[]>([]);
    const [groupCovers, setGroupCovers] = useState<Record<number, string[]>>({});

    const loadGroups = useCallback(async () => {
        try {
            const allGroups = await groupService.getAllGroups();
            // 后端已按 sort_order 排序，直接使用
            setGroups(allGroups || []);
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

    // 加载分组封面
    useEffect(() => {
        const run = async () => {
            try {
                const entries = await Promise.all(
                    (groups || []).map(async (g) => {
                        try {
                            const list = await groupService.getBooksByGroup(g.id);
                            const covers: string[] = [];
                            for (const b of list || []) {
                                if (covers.length >= 4) break;
                                if (b.cover_image) {
                                    covers.push(b.cover_image);
                                }
                            }
                            if (covers.length < 4) {
                                for (const b of list || []) {
                                    if (covers.length >= 4) break;
                                    if (!b.cover_image) {
                                        const fmt = getBookFormat(b.file_path);
                                        if (fmt === "markdown") {
                                            covers.push(MARKDOWN_COVER_PLACEHOLDER);
                                        } else if (fmt === "html") {
                                            covers.push(HTML_COVER_PLACEHOLDER);
                                        }
                                    }
                                }
                            }
                            return [g.id, covers] as [number, string[]];
                        } catch {
                            return [g.id, []] as [number, string[]];
                        }
                    })
                );
                const map: Record<number, string[]> = {};
                entries.forEach(([id, covers]) => {
                    map[id] = covers;
                });
                setGroupCovers(map);
            } catch (e) {
                setGroupCovers({});
            }
        };
        if (groups && groups.length > 0) run();
        else setGroupCovers({});
    }, [groups]);

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
        groupCovers,
        filteredGroups,
    };
};

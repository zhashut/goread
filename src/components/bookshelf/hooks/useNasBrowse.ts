import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { NasConnection, NasDirLevel, NasEntry } from "../../../utils/nasConnections";

/**
 * 归一化目录路径
 * 功能描述：去除首尾空白，保证路径以 / 结尾（空值或 "/" 统一归为根目录 "/"）。
 * 参数说明：path - 原始目录路径。
 * 返回值类型及用途：返回归一化后的路径字符串，用于 WebDAV 目录请求。
 */
function normalizeDirPath(path: string): string {
    const trimmed = path.trim();
    if (!trimmed || trimmed === "/") return "/";
    return trimmed.endsWith("/") ? trimmed : trimmed + "/";
}

/**
 * NAS 远程目录浏览 Hook
 * 功能描述：管理单个 NAS 连接的远程目录浏览状态，包括目录条目加载、面包屑层级栈维护、
 *          进入子目录、跳转层级与刷新；连接切换（按连接 id 判断）时自动从起始路径重新加载，
 *          起始路径加载失败时回退到根目录。
 * 参数说明：connection - NAS 连接配置对象；为 null 时清空浏览状态且不发起请求。
 * 返回值类型及用途：返回 entries（当前目录条目列表）、loading（是否加载中）、
 *          error（加载失败信息，null 表示正常）、dirStack（目录层级栈，供面包屑渲染）、
 *          goInto（进入子目录）、goToDepth（跳转到层级栈指定深度）、reload（刷新当前目录）。
 */
export function useNasBrowse(connection: NasConnection | null) {
    const [entries, setEntries] = useState<NasEntry[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [dirStack, setDirStack] = useState<NasDirLevel[]>([]);
    // 以 ref 保存最新连接与层级栈，避免对象引用变化进入依赖导致重复加载
    const connRef = useRef<NasConnection | null>(connection);
    connRef.current = connection;
    const dirStackRef = useRef<NasDirLevel[]>([]);
    dirStackRef.current = dirStack;

    /**
     * 加载指定目录条目
     * 功能描述：调用后端 webdav_list 命令拉取目录内容，失败时记录错误并置空列表。
     * 参数说明：conn - NAS 连接配置；dirPath - 目标目录路径。
     * 返回值类型及用途：无返回（异步更新 entries / error / loading 状态）。
     */
    const loadDir = useCallback(async (conn: NasConnection, dirPath: string) => {
        setLoading(true);
        setError(null);
        try {
            const list = await invoke<NasEntry[]>("webdav_list", {
                baseUrl: conn.url,
                username: conn.username,
                password: conn.password,
                dirPath,
            });
            setEntries(list ?? []);
        } catch (e) {
            setEntries([]);
            setError(String(e));
        } finally {
            setLoading(false);
        }
    }, []);

    // 连接切换时从起始路径浏览，起始路径失效则回退根目录
    useEffect(() => {
        const conn = connRef.current;
        if (!conn) {
            setEntries([]);
            setDirStack([]);
            setError(null);
            return;
        }
        let cancelled = false;
        (async () => {
            const startPath = normalizeDirPath(conn.startPath || "/");
            setLoading(true);
            setError(null);
            try {
                const list = await invoke<NasEntry[]>("webdav_list", {
                    baseUrl: conn.url,
                    username: conn.username,
                    password: conn.password,
                    dirPath: startPath,
                });
                if (cancelled) return;
                setEntries(list ?? []);
                setDirStack([{ name: conn.name || "/", path: startPath }]);
            } catch {
                if (cancelled) return;
                // 起始路径失效，回退到根目录重试
                try {
                    const list = await invoke<NasEntry[]>("webdav_list", {
                        baseUrl: conn.url,
                        username: conn.username,
                        password: conn.password,
                        dirPath: "/",
                    });
                    if (cancelled) return;
                    setEntries(list ?? []);
                    setDirStack([{ name: conn.name || "/", path: "/" }]);
                } catch (e2) {
                    if (cancelled) return;
                    setEntries([]);
                    setDirStack([]);
                    setError(String(e2));
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [connection?.id]);

    /**
     * 进入子目录
     * 功能描述：将目标子目录压入层级栈并加载其条目；非目录条目忽略。
     * 参数说明：entry - 目标目录条目（is_dir 为 true 时生效）。
     * 返回值类型及用途：无返回（异步更新状态）。
     */
    const goInto = useCallback(async (entry: NasEntry) => {
        const conn = connRef.current;
        if (!conn || !entry.is_dir) return;
        const target = normalizeDirPath(entry.path);
        setDirStack((prev) => [...prev, { name: entry.name, path: target }]);
        await loadDir(conn, target);
    }, [loadDir]);

    /**
     * 跳转到层级栈指定深度
     * 功能描述：面包屑点击时裁剪层级栈并加载对应目录；深度越界时忽略。
     * 参数说明：depth - 目标层级在栈中的下标（0 为根层级）。
     * 返回值类型及用途：无返回（异步更新状态）。
     */
    const goToDepth = useCallback(async (depth: number) => {
        const conn = connRef.current;
        if (!conn || depth < 0) return;
        const target = dirStackRef.current[depth]?.path;
        if (!target) return;
        setDirStack((prev) => prev.slice(0, depth + 1));
        await loadDir(conn, target);
    }, [loadDir]);

    /**
     * 刷新当前目录
     * 功能描述：按层级栈栈顶路径重新加载条目；栈为空时忽略。
     * 参数说明：无。
     * 返回值类型及用途：无返回（异步更新状态）。
     */
    const reload = useCallback(() => {
        return goToDepth(dirStackRef.current.length - 1);
    }, [goToDepth]);

    return { entries, loading, error, dirStack, goInto, goToDepth, reload };
}

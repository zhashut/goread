import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { NasConnection, NasEntry } from "../utils/nasConnections";
import { isSupportedFile } from "../constants/fileTypes";
import { loadNasConnections } from "../utils/nasConnections";

/** 搜索输入防抖时长（毫秒） */
const NAS_SEARCH_DEBOUNCE_MS = 500;
/** 递归遍历最大目录层数（起始目录为第 0 层，共访问 0~3 层） */
const NAS_SEARCH_MAX_DEPTH = 4;
/** 单连接单次搜索允许访问的目录数上限（防止大容量 NAS 长时间遍历） */
const NAS_SEARCH_MAX_DIRS_PER_CONN = 300;
/** 单连接单次搜索命中的结果数上限 */
const NAS_SEARCH_MAX_RESULTS_PER_CONN = 30;

/** 网络书架搜索结果项（连接配置 + 命中的远端文件条目） */
export interface NasSearchResult {
  /** 命中文件所在的 NAS 连接 */
  connection: NasConnection;
  /** 命中的远端文件条目 */
  entry: NasEntry;
}

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
 * 搜索单个 NAS 连接（BFS 递归遍历）
 * 功能描述：从连接起始目录开始广度优先逐目录调用 webdav_list，收集文件名包含关键词
 *          的受支持书籍文件；命中结果即时经 onHits 回调上报（渐进展示）；
 *          目录访问数或结果数达到上限即提前终止；任一目录请求失败即放弃该连接；
 *          通过代际 token 感知取消（新搜索发起后旧遍历自动停止）。
 * 参数说明：conn - NAS 连接配置；q - 小写搜索关键词；
 *          gen - 本次搜索的代际号；genRef - 保存最新代际号的可变引用；
 *          onHits - 命中回调，接收该连接新命中的条目数组。
 * 返回值类型及用途：无返回（异步遍历，结果经 onHits 渐进上报）。
 */
async function searchConnection(
  conn: NasConnection,
  q: string,
  gen: number,
  genRef: { current: number },
  onHits: (hits: NasEntry[]) => void
): Promise<void> {
  const startPath = normalizeDirPath(conn.startPath || "/");
  // BFS 队列：元素为待访问目录路径及其层数（起始目录为第 0 层）
  const queue: Array<{ path: string; depth: number }> = [{ path: startPath, depth: 0 }];
  const visited = new Set<string>([startPath]);
  let dirsVisited = 0;
  let hitCount = 0;

  try {
    while (queue.length > 0) {
      // 搜索已被更新的代际取代时立即取消
      if (genRef.current !== gen) return;
      // 目录访问数达到上限时提前终止该连接的遍历
      if (dirsVisited >= NAS_SEARCH_MAX_DIRS_PER_CONN) return;
      if (hitCount >= NAS_SEARCH_MAX_RESULTS_PER_CONN) return;

      const cur = queue.shift()!;
      dirsVisited += 1;
      const list = await invoke<NasEntry[]>("webdav_list", {
        baseUrl: conn.url,
        username: conn.username,
        password: conn.password,
        dirPath: cur.path,
      });
      if (genRef.current !== gen) return;

      // 命中条件：受支持的书籍格式且文件名包含关键词
      const found = (list ?? []).filter(
        (e) => !e.is_dir && isSupportedFile(e.path) && e.name.toLowerCase().includes(q)
      );
      if (found.length > 0) {
        const remaining = NAS_SEARCH_MAX_RESULTS_PER_CONN - hitCount;
        const hits = found.slice(0, remaining);
        hitCount += hits.length;
        onHits(hits);
        if (hitCount >= NAS_SEARCH_MAX_RESULTS_PER_CONN) return;
      }

      // 子目录入队（层数受限，visited 防止软链/循环路径导致的死循环）
      for (const e of list ?? []) {
        if (!e.is_dir) continue;
        const childPath = normalizeDirPath(e.path);
        if (!visited.has(childPath) && cur.depth + 1 < NAS_SEARCH_MAX_DEPTH) {
          visited.add(childPath);
          queue.push({ path: childPath, depth: cur.depth + 1 });
        }
      }
    }
  } catch {
    // 任一目录请求失败（网络异常、权限不足等）即放弃该连接的搜索
  }
}

/**
 * 网络书架搜索 Hook
 * 功能描述：对关键词防抖后，并行遍历全部 NAS 连接（从各自起始目录起 BFS 递归），
 *          搜索文件名包含关键词的未入库受支持书籍文件；每个连接的结果独立累积、
 *          按连接顺序合并后渐进更新；无连接配置时直接返回空结果；
 *          关键词变化时旧搜索通过代际 token 自动取消。
 * 参数说明：query - 用户输入的搜索关键词（原始大小写）。
 * 返回值类型及用途：返回 results（全部命中的 NAS 文件结果，按连接顺序排列）
 *          与 searching（是否仍在遍历中）。
 */
export function useNasSearch(
  query: string
): { results: NasSearchResult[]; searching: boolean } {
  const [results, setResults] = useState<NasSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  // 代际 token：每次发起新搜索自增，用于取消仍在进行的旧遍历
  const genRef = useRef(0);

  useEffect(() => {
    const q = query.trim().toLowerCase();
    const gen = ++genRef.current;
    if (!q) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(async () => {
      // 防抖期间关键词又发生变化时取消本次搜索
      if (genRef.current !== gen) return;
      const connections = loadNasConnections();
      if (connections.length === 0) {
        setResults([]);
        setSearching(false);
        return;
      }
      // 每个连接独立累积命中结果，保证各连接进度互不阻塞
      const perConn = new Map<string, NasEntry[]>();
      /**
       * 合并各连接结果并更新状态
       * 功能描述：按连接顺序将各连接累积的命中条目扁平化为结果快照。
       * 参数说明：无。
       * 返回值类型及用途：无返回（更新 results 状态）。
       */
      const flush = () => {
        const merged: NasSearchResult[] = [];
        for (const conn of connections) {
          const hits = perConn.get(conn.id);
          if (hits) {
            for (const entry of hits) merged.push({ connection: conn, entry });
          }
        }
        setResults(merged);
      };
      await Promise.allSettled(
        connections.map((conn) =>
          searchConnection(conn, q, gen, genRef, (hits) => {
            const acc = perConn.get(conn.id) ?? [];
            acc.push(...hits);
            perConn.set(conn.id, acc);
            flush();
          })
        )
      );
      // 全部连接遍历完成且代际仍有效时结束 searching 状态
      if (genRef.current === gen) setSearching(false);
    }, NAS_SEARCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      // 使本次搜索代际失效，取消仍在进行的遍历
      genRef.current += 1;
    };
  }, [query]);

  return { results, searching };
}

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FileRow } from "./FileRow";
import { Loading } from "./Loading";
import { ImportBottomBar } from "./ImportBottomBar";
import { getSafeAreaInsets } from "../utils/layout";
import { isSupportedFile } from "../constants/fileTypes";
import type { NasConnection, NasDirLevel, NasEntry } from "../utils/nasConnections";
import { loadNasConnections, saveNasConnections } from "../utils/nasConnections";

/** 下载进度事件 payload（与后端 DownloadProgress 对应） */
type DownloadProgress = {
  name: string;
  downloaded: number;
  total?: number | null;
};

/** 格式化时间展示 */
const fmtDate = (t?: number | null) => {
  if (!t) return "";
  const d = new Date(t);
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  const hh = `${d.getHours()}`.padStart(2, "0");
  const mm = `${d.getMinutes()}`.padStart(2, "0");
  return `${y}/${m}/${day} ${hh}:${mm}`;
};

/** 主题玫红色（与 WiFi 传书页一致） */
const ACCENT = "#e2556b";

/** 输入框通用样式（className nas-btn/nas-input 用于豁免 App.css 的 .import-page 全局重置） */
const inputStyle: React.CSSProperties = {
  width: "100%",
  height: 44,
  padding: "0 14px",
  border: "1px solid #e5e5e5",
  borderRadius: 10,
  fontSize: 14,
  color: "#333",
  background: "#fafafa",
  outline: "none",
  boxSizing: "border-box",
};

interface NasBrowserProps {
  /** 下载完成后将本地文件路径交给上层复用导入分组流程 */
  onImportPaths: (paths: string[]) => void;
}

/**
 * NAS 获取书籍页——通过 WebDAV 连接 NAS 浏览并下载书籍。
 * 三个视图：连接列表 →（添加连接表单）→ 目录浏览；
 * 下载串行执行并展示单文件进度，完成后复用导入分组流程入库。
 * 连接配置（含账号密码）保存在本机 localStorage。
 *
 * @param props.onImportPaths 下载完成后回调本地路径列表
 * @returns NAS 获取书籍页组件
 */
export const NasBrowser: React.FC<NasBrowserProps> = ({ onImportPaths }) => {
  const { t } = useTranslation("bookshelf");

  // 视图状态：list 连接列表 / form 添加连接 / browse 目录浏览
  const [view, setView] = useState<"list" | "form" | "browse">("list");
  const [connections, setConnections] = useState<NasConnection[]>(loadNasConnections);
  // 当前连接（browse 视图必非空）
  const [conn, setConn] = useState<NasConnection | null>(null);
  // 编辑模式：非空表示正在修改该 id 的已存连接（表单预填、保存时原位替换）
  const [editingId, setEditingId] = useState<string | null>(null);

  // 表单状态
  const [formName, setFormName] = useState("");
  const [formUrl, setFormUrl] = useState("");
  const [formUsername, setFormUsername] = useState("");
  const [formPassword, setFormPassword] = useState("");
  const [formStartPath, setFormStartPath] = useState("");
  const [connecting, setConnecting] = useState(false);
  // 测试连接状态：null 未测试 / pending 进行中 / ok 成功 / 失败（含原因）
  const [testState, setTestState] = useState<
    { status: "pending" } | { status: "ok" } | { status: "failed"; message: string } | null
  >(null);

  // 浏览状态
  const [dirStack, setDirStack] = useState<NasDirLevel[]>([{ name: "/", path: "/" }]);
  const [entries, setEntries] = useState<NasEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<NasEntry[]>([]);

  // 下载状态（串行逐个下载：第 index 个，共 total 个）
  const [downloading, setDownloading] = useState<{ index: number; total: number } | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  // 下载期间允许卸载后不再 setState 的防护标记
  const cancelledRef = useRef(false);

  useEffect(() => {
    const unlisten = listen<DownloadProgress>("goread:nas:download", (e) => {
      setProgress(e.payload);
    });
    return () => {
      cancelledRef.current = true;
      unlisten.then((fn) => fn());
    };
  }, []);

  /** 加载指定目录条目（含 loading 状态管理） */
  const loadEntries = useCallback(
    async (connection: NasConnection, path: string) => {
      setLoading(true);
      try {
        const list = await invoke<NasEntry[]>("webdav_list", {
          baseUrl: connection.url,
          username: connection.username,
          password: connection.password,
          dirPath: path,
        });
        setEntries(list);
        setSelected([]);
      } catch (e) {
        alert(`${t("nas.connectFailed")}\n${String(e)}`);
        // 列目录失败时退回该目录层级之前（连接可能已失效）
        throw e;
      } finally {
        setLoading(false);
      }
    },
    [t]
  );

  /** 归一初始文件路径：trim，空则根目录，确保以 / 开头（尾斜杠由后端归一） */
  const normalizeStartPath = (p: string): string => {
    const s = p.trim();
    if (!s || s === "/") return "/";
    return s.startsWith("/") ? s : `/${s}`;
  };

  /** 连接测试并进入浏览视图（优先进入初始文件路径，失效自动回退根目录） */
  const connectAndBrowse = useCallback(
    async (connection: NasConnection) => {
      setConnecting(true);
      try {
        let rootPath = normalizeStartPath(connection.startPath || "/");
        try {
          await loadEntries(connection, rootPath);
        } catch (e) {
          if (rootPath !== "/") {
            // 初始路径在 NAS 上不存在/失效：回退根目录重试
            rootPath = "/";
            await loadEntries(connection, rootPath);
          } else {
            throw e;
          }
        }
        setConn(connection);
        setDirStack([{ name: connection.name || "/", path: rootPath }]);
        setView("browse");
      } catch {
        // 错误已由 loadEntries 弹出
      } finally {
        setConnecting(false);
      }
    },
    [loadEntries]
  );

  /** 测试连接：按当前表单参数请求目录列表（含初始路径），仅验证不保存 */
  const testConnection = useCallback(async () => {
    const url = formUrl.trim();
    if (!url) {
      setTestState({ status: "failed", message: t("nas.connectFailed") });
      return;
    }
    setTestState({ status: "pending" });
    try {
      await invoke<NasEntry[]>("webdav_list", {
        baseUrl: url,
        username: formUsername,
        password: formPassword,
        dirPath: normalizeStartPath(formStartPath || "/"),
      });
      setTestState({ status: "ok" });
    } catch (e) {
      setTestState({ status: "failed", message: String(e) });
    }
  }, [formUrl, formUsername, formPassword, formStartPath, t]);

  /** 表单提交：校验、连接测试、保存连接并进入浏览 */
  const submitForm = useCallback(async () => {
    const url = formUrl.trim();
    if (!url) {
      alert(t("nas.connectFailed"));
      return;
    }
    const connection: NasConnection = {
      id: `${Date.now()}`,
      name: formName.trim() || url.replace(/^https?:\/\//, ""),
      url,
      username: formUsername,
      password: formPassword,
      startPath: normalizeStartPath(formStartPath || "/"),
    };
    await connectAndBrowse(connection);
    // 连接成功才持久化：编辑模式原位替换（URL 冲突的其他连接移除），新建置顶
    const next = editingId
      ? connections
          .filter((c) => c.url !== url || c.id === editingId)
          .map((c) => (c.id === editingId ? connection : c))
      : [connection, ...connections.filter((c) => c.url !== url)];
    setConnections(next);
    saveNasConnections(next);
    // 清空表单
    setEditingId(null);
    setFormName("");
    setFormUrl("");
    setFormUsername("");
    setFormPassword("");
    setFormStartPath("");
    setTestState(null);
  }, [editingId, formName, formUrl, formUsername, formPassword, formStartPath, connections, connectAndBrowse, t]);

  /** 进入编辑模式：预填已存连接到表单 */
  const editConnection = useCallback((c: NasConnection) => {
    setEditingId(c.id);
    setFormName(c.name);
    setFormUrl(c.url);
    setFormUsername(c.username);
    setFormPassword(c.password);
    setFormStartPath(
      c.startPath && c.startPath !== "/" ? c.startPath : ""
    );
    setTestState(null);
    setView("form");
  }, []);

  /** 删除已保存连接 */
  const removeConnection = useCallback(
    (id: string) => {
      const next = connections.filter((c) => c.id !== id);
      setConnections(next);
      saveNasConnections(next);
    },
    [connections]
  );

  /** 进入子目录 */
  const goInto = useCallback(
    async (entry: NasEntry) => {
      if (!conn || entry.path === "/") return;
      try {
        await loadEntries(conn, entry.path);
        setDirStack((stack) => [...stack, { name: entry.name, path: entry.path }]);
      } catch {
        // 错误已弹出，保持当前层级
      }
    },
    [conn, loadEntries]
  );

  /** 面包屑跳转到指定层级 */
  const goToDepth = useCallback(
    async (idx: number) => {
      if (!conn || idx < 0 || idx >= dirStack.length) return;
      const target = dirStack[idx];
      try {
        await loadEntries(conn, target.path);
        setDirStack((stack) => stack.slice(0, idx + 1));
      } catch {
        // 错误已弹出
      }
    },
    [conn, dirStack, loadEntries]
  );

  /** 断开连接返回连接列表 */
  const disconnect = useCallback(() => {
    setConn(null);
    setEntries([]);
    setSelected([]);
    setDirStack([{ name: "/", path: "/" }]);
    setView("list");
  }, []);

  /** 选中/取消选中一个文件条目 */
  const toggleSelect = useCallback(
    (path: string) => {
      setSelected((prev) => {
        const exists = prev.find((e) => e.path === path);
        if (exists) return prev.filter((e) => e.path !== path);
        const entry = entries.find((e) => e.path === path);
        return entry ? [...prev, entry] : prev;
      });
    },
    [entries]
  );

  /** 串行下载选中文件，全部完成后交由上层导入 */
  const downloadAndImport = useCallback(async () => {
    if (!conn) return;
    if (selected.length === 0) {
      alert(t("nas.selectFilesToDownload"));
      return;
    }
    const files = [...selected];
    setDownloading({ index: 0, total: files.length });
    const localPaths: string[] = [];
    let failed = 0;
    for (let i = 0; i < files.length; i++) {
      if (cancelledRef.current) return;
      setDownloading({ index: i, total: files.length });
      setProgress({ name: files[i].name, downloaded: 0, total: null });
      try {
        const local = await invoke<string>("webdav_download", {
          baseUrl: conn.url,
          username: conn.username,
          password: conn.password,
          remotePath: files[i].path,
          fileName: files[i].name,
        });
        localPaths.push(local);
      } catch (e) {
        failed += 1;
        alert(`${t("nas.downloadFailed")}: ${files[i].name}\n${String(e)}`);
      }
    }
    setDownloading(null);
    setProgress(null);
    if (localPaths.length === 0) return;
    if (failed > 0) {
      alert(t("nas.downloadPartial", { count: localPaths.length, failed }));
    }
    setSelected([]);
    onImportPaths(localPaths);
  }, [conn, selected, onImportPaths, t]);

  /** 底部栏标签：下载中显示进度，否则显示待下载数量 */
  const bottomLabel = downloading
    ? (() => {
        const pct =
          progress?.total && progress.total > 0
            ? ` ${Math.floor((progress.downloaded / progress.total) * 100)}%`
            : "";
        return `${t("nas.downloading", {
          index: downloading.index + 1,
          total: downloading.total,
          name: progress?.name ?? "",
        })}${pct}`;
      })()
    : t("nas.downloadAndImport", { count: selected.length });

  // ============ 视图：添加/编辑连接表单 ============
  const renderForm = () => (
    <div style={{ padding: "16px 20px" }}>
      <div style={{ fontSize: 15, color: "#333", marginBottom: 14 }}>
        {editingId ? t("nas.editSubtitle") : t("nas.subtitle")}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <input
          className="nas-input"
          style={inputStyle}
          value={formName}
          onChange={(e) => setFormName(e.target.value)}
          placeholder={t("nas.formNamePlaceholder")}
        />
        <input
          className="nas-input"
          style={inputStyle}
          value={formUrl}
          onChange={(e) => setFormUrl(e.target.value)}
          placeholder={t("nas.formUrlPlaceholder")}
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
        />
        <input
          className="nas-input"
          style={inputStyle}
          value={formUsername}
          onChange={(e) => setFormUsername(e.target.value)}
          placeholder={t("nas.formUsername")}
          autoCapitalize="off"
          autoCorrect="off"
        />
        <input
          className="nas-input"
          style={inputStyle}
          type="password"
          value={formPassword}
          onChange={(e) => setFormPassword(e.target.value)}
          placeholder={t("nas.formPassword")}
        />
        <input
          className="nas-input"
          style={inputStyle}
          value={formStartPath}
          onChange={(e) => {
            setFormStartPath(e.target.value);
            // 参数变化后旧测试结果失效
            setTestState(null);
          }}
          placeholder={t("nas.formStartPathPlaceholder")}
          autoCapitalize="off"
          autoCorrect="off"
        />
      </div>
      {/* 测试连接：白底玫红描边，内联结果反馈（成功/失败原因） */}
      <button
        className="nas-btn"
        onClick={testConnection}
        disabled={testState?.status === "pending" || connecting}
        style={{
          marginTop: 14,
          width: "100%",
          height: 44,
          border: `1px solid ${ACCENT}`,
          borderRadius: 22,
          background: "#fff",
          color: ACCENT,
          fontSize: 15,
          cursor: testState?.status === "pending" ? "wait" : "pointer",
          opacity: testState?.status === "pending" ? 0.7 : 1,
        }}
      >
        {testState?.status === "pending" ? t("nas.testing") : t("nas.testConnection")}
      </button>
      {testState?.status === "ok" && (
        <div style={{ marginTop: 10, textAlign: "center", fontSize: 13, color: "#3a8f3a" }}>
          ✓ {t("nas.testOk")}
        </div>
      )}
      {testState?.status === "failed" && (
        <div
          style={{
            marginTop: 10,
            textAlign: "center",
            fontSize: 12,
            color: "#d23c3c",
            wordBreak: "break-all",
          }}
        >
          ✗ {t("nas.testFailed")}
          {testState.message ? `\n${testState.message}` : ""}
        </div>
      )}
      <div style={{ fontSize: 12, color: "#9a9a9a", lineHeight: 1.7, marginTop: 12 }}>
        {t("nas.note")}
      </div>
      <div style={{ display: "flex", gap: 12, marginTop: 20 }}>
        <button
          className="nas-btn"
          onClick={() => {
            setEditingId(null);
            setView("list");
          }}
          style={{
            flex: 1,
            height: 46,
            border: "none",
            borderRadius: 23,
            background: "#f0f0f0",
            color: "#666",
            fontSize: 15,
            cursor: "pointer",
          }}
        >
          {t("nas.cancel")}
        </button>
        <button
          className="nas-btn"
          onClick={submitForm}
          disabled={connecting}
          style={{
            flex: 2,
            height: 46,
            border: "none",
            borderRadius: 23,
            background: ACCENT,
            color: "#fff",
            fontSize: 15,
            cursor: connecting ? "wait" : "pointer",
            opacity: connecting ? 0.7 : 1,
          }}
        >
          {connecting ? t("nas.connecting") : t("nas.save")}
        </button>
      </div>
    </div>
  );

  // ============ 视图：连接列表 ============
  const renderList = () => (
    <div style={{ padding: "16px 20px" }}>
      <div style={{ fontSize: 15, color: "#333", marginBottom: 14 }}>
        {t("nas.subtitle")}
      </div>
      {connections.length === 0 && (
        <div style={{ fontSize: 13, color: "#b5b5b5", textAlign: "center", padding: "28px 0" }}>
          {t("nas.noConnections")}
        </div>
      )}
      {connections.map((c) => (
        <div
          key={c.id}
          style={{
            display: "flex",
            alignItems: "center",
            background: "#fff",
            borderRadius: 12,
            padding: "12px 14px",
            marginBottom: 10,
          }}
        >
          <div
            style={{ flex: 1, overflow: "hidden", cursor: "pointer" }}
            onClick={() => connectAndBrowse(c)}
          >
            <div
              style={{
                fontSize: 14,
                color: "#333",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {c.name}
            </div>
            <div
              style={{
                fontSize: 12,
                color: "#b5b5b5",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                marginTop: 2,
              }}
            >
              {c.url}
            </div>
          </div>
          <div style={{ display: "flex", flexShrink: 0 }}>
            <button
              className="nas-btn"
              onClick={() => editConnection(c)}
              style={{
                background: "none",
                border: "none",
                color: "#666",
                fontSize: 13,
                cursor: "pointer",
                padding: "4px 8px",
              }}
            >
              {t("nas.edit")}
            </button>
            <button
              className="nas-btn"
              onClick={() => removeConnection(c.id)}
              style={{
                background: "none",
                border: "none",
                color: "#d23c3c",
                fontSize: 13,
                cursor: "pointer",
                padding: "4px 8px",
              }}
            >
              {t("nas.delete")}
            </button>
          </div>
        </div>
      ))}
      <button
        className="nas-btn"
        onClick={() => setView("form")}
        style={{
          marginTop: 12,
          width: "100%",
          height: 50,
          border: "none",
          borderRadius: 25,
          background: ACCENT,
          color: "#fff",
          fontSize: 16,
          cursor: "pointer",
        }}
      >
        {t("nas.addConnection")}
      </button>
      <div style={{ fontSize: 12, color: "#9a9a9a", lineHeight: 1.7, marginTop: 14, textAlign: "center" }}>
        {t("nas.note")}
      </div>
    </div>
  );

  // ============ 视图：目录浏览 ============
  const renderBrowse = () => (
    <div style={{ paddingBottom: 90 }}>
      {/* 返回连接列表 */}
      <div style={{ padding: "8px 16px 0 16px" }}>
        <button
          className="nas-btn"
          onClick={disconnect}
          disabled={loading || downloading != null}
          style={{
            background: "none",
            border: "none",
            boxShadow: "none",
            borderRadius: 0,
            padding: 0,
            color: "#999",
            fontSize: 13,
            cursor: loading || downloading ? "default" : "pointer",
          }}
        >
          ‹ {t("nas.backToList")}
        </button>
      </div>
      {/* 面包屑 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          color: "#666",
          fontSize: 13,
          padding: "6px 16px 8px 16px",
        }}
      >
        {dirStack.map((seg, idx) => (
          <React.Fragment key={seg.path + idx}>
            <button
              className="nas-btn"
              onClick={() => {
                if (!loading && !downloading) goToDepth(idx);
              }}
              style={{
                background: "none",
                border: "none",
                boxShadow: "none",
                borderRadius: 0,
                padding: 0,
                cursor:
                  idx === dirStack.length - 1 || loading || downloading
                    ? "default"
                    : "pointer",
                color: idx === dirStack.length - 1 ? "#999" : "#555",
                maxWidth: 160,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                marginRight: 6,
              }}
              title={seg.path}
              disabled={loading || downloading != null}
            >
              {seg.name}
            </button>
            {idx < dirStack.length - 1 && (
              <span style={{ color: "#999", marginRight: 6 }}>›</span>
            )}
          </React.Fragment>
        ))}
      </div>
      {/* 条目列表 */}
      {loading && entries.length === 0 ? (
        <Loading
          visible
          overlay={false}
          text=""
          showSpinner={false}
          style={{ height: 120 }}
          textStyle={{ color: "#999" }}
        />
      ) : (
        entries
          .filter((e) => e.is_dir || isSupportedFile(e.path))
          .map((entry) =>
            entry.is_dir ? (
              <div
                key={entry.path}
                onClick={() => !loading && !downloading && goInto(entry)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  height: 60,
                  padding: "0 16px",
                  borderBottom: "1px solid #f0f0f0",
                  cursor: loading || downloading ? "wait" : "pointer",
                  opacity: loading ? 0.6 : 1,
                }}
              >
                <svg width={51} height={51} viewBox="0 0 24 24" fill="#f29b00" style={{ marginRight: 14, flexShrink: 0 }}>
                  <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
                </svg>
                <div style={{ flex: 1, overflow: "hidden" }}>
                  <div
                    style={{
                      color: "#333",
                      fontSize: 14,
                      whiteSpace: "nowrap",
                      textOverflow: "ellipsis",
                      overflow: "hidden",
                    }}
                  >
                    {entry.name}
                  </div>
                  <div style={{ color: "#888", fontSize: 12 }}>{fmtDate(entry.mtime)}</div>
                </div>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                  <path d="M9 6l6 6-6 6" stroke="#999" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
            ) : (
              <FileRow
                key={entry.path}
                name={entry.name}
                path={entry.path}
                size={entry.size ?? undefined}
                mtime={entry.mtime ?? undefined}
                selected={selected.some((s) => s.path === entry.path)}
                onToggle={toggleSelect}
                rowHeight={60}
                mode="select"
              />
            )
          )
      )}
    </div>
  );

  return (
    <div
      style={{
        minHeight: "100%",
        background: "#f5f5f5",
        boxSizing: "border-box",
      }}
    >
      {view === "form"
        ? renderForm()
        : view === "list"
        ? renderList()
        : renderBrowse()}

      {/* 底部操作栏：仅浏览视图显示（fixed 悬浮于全局菜单栏之上，内容区已预留 paddingBottom） */}
      {view === "browse" && (
        <div
          style={{
            position: "fixed",
            left: 0,
            right: 0,
            bottom: "var(--goread-navbar-h)",
            zIndex: 10,
          }}
        >
          <ImportBottomBar
            label={bottomLabel}
            disabled={loading || downloading != null}
            onClick={downloadAndImport}
          />
        </div>
      )}
      {/* 表单/列表视图底部安全区留白 */}
      {view !== "browse" && (
        <div style={{ height: 24 + getSafeAreaInsets().bottom }} />
      )}
    </div>
  );
};

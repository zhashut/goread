import React, { useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { FileRow } from "./FileRow";
import { bookService, groupService } from "../services";
import { IBook, IGroup } from "../types";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import GroupingDrawer from "./GroupingDrawer";

export interface FileEntry {
  type: "file" | "dir";
  name: string;
  path: string;
  size?: number;
  mtime?: number;
}

export interface ScanResultItem extends FileEntry {
  imported?: boolean;
  type: "file";
}

const bytesToSize = (n?: number) => {
  if (!n || n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

const fmtDate = (t?: number) => {
  if (!t) return "";
  const d = new Date(t);
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  const hh = `${d.getHours()}`.padStart(2, "0");
  const mm = `${d.getMinutes()}`.padStart(2, "0");
  return `${y}/${m}/${day} ${hh}:${mm}`;
};

export const ScanResults: React.FC = () => {
  const navigate = useNavigate();
  const { state } = useLocation() as { state?: { results?: ScanResultItem[] } };
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [globalSearch, setGlobalSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  // 列表行高度（用于按比例缩放左侧图标尺寸）
  const ROW_HEIGHT = 60; // px

  const results: ScanResultItem[] = useMemo(
    () => state?.results || [],
    [state]
  );
  const filtered = useMemo(() => {
    const kw = globalSearch.trim().toLowerCase();
    return results.filter((it) => it.name.toLowerCase().includes(kw));
  }, [results, globalSearch]);

  const toggleSelect = (path: string) => {
    setSelectedPaths((prev) =>
      prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path]
    );
  };

  // 分组抽屉状态
  const [groupingOpen, setGroupingOpen] = useState(false);
  const [chooseGroupOpen, setChooseGroupOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [importedBooks, setImportedBooks] = useState<IBook[]>([]);
  const [allGroups, setAllGroups] = useState<IGroup[]>([]);
  const [groupPreviews, setGroupPreviews] = useState<Record<number, string[]>>(
    {}
  );
  const [groupingLoading, setGroupingLoading] = useState(false);

  const defaultNameFromFiles = useMemo(() => {
    const first = importedBooks[0];
    return (first?.title || "").trim();
  }, [importedBooks]);

  const handleImportClick = async () => {
    try {
      const [{ open }, { readFile }] = await Promise.all([
        import("@tauri-apps/plugin-dialog"),
        import("@tauri-apps/plugin-fs"),
      ]);

      const selected = await open({
        multiple: true,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });

      const paths: string[] = Array.isArray(selected)
        ? selected.map((s: any) => (typeof s === "string" ? s : s.path))
        : selected
        ? [
            typeof selected === "string"
              ? (selected as string)
              : (selected as any).path,
          ]
        : [];

      if (!paths.length) return;

      (pdfjs as any).GlobalWorkerOptions.workerSrc = workerUrl;
      let success = 0;
      const imported: IBook[] = [];
      for (const filePath of paths) {
        try {
          const fileName = filePath.split("\\").pop()?.split("/").pop();
          const fileData = await readFile(filePath);
          let pdf: any;
          try {
            pdf = await (pdfjs as any).getDocument({ data: fileData }).promise;
          } catch (e: any) {
            const msg = String(e?.message || e);
            if (msg.includes("GlobalWorkerOptions.workerSrc")) {
              pdf = await (pdfjs as any).getDocument({
                data: fileData,
                disableWorker: true,
              }).promise;
            } else {
              throw e;
            }
          }
          const page = await pdf.getPage(1);
          const viewport = page.getViewport({ scale: 0.5 });
          const canvas = document.createElement("canvas");
          const context = canvas.getContext("2d")!;
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          await page.render({ canvasContext: context, viewport }).promise;
          const coverImage = canvas.toDataURL("image/jpeg", 0.8).split(",")[1];
          const title = fileName?.replace(/\.pdf$/i, "") || "Unknown";
          const saved = await bookService.addBook(
            filePath,
            title,
            coverImage,
            pdf.numPages
          );
          imported.push(saved);
          success += 1;
        } catch (e) {
          console.error("Import failed for", filePath, e);
        }
      }

      if (success > 0) {
        setImportedBooks(imported);
        setGroupingOpen(true);
      } else {
        alert("未导入任何文件");
      }
    } catch (error: any) {
      console.error("Import dialog failed:", error);
      const msg =
        typeof error?.message === "string" ? error.message : String(error);
      alert(`导入失败，请重试\n\n原因：${msg}`);
    }
  };

  const openChooseGroup = async () => {
    try {
      const gs = await groupService.getAllGroups();
      setAllGroups(gs || []);
      const previews: Record<number, string[]> = {};
      for (const g of gs || []) {
        try {
          const books = await groupService.getBooksByGroup(g.id);
          previews[g.id] = (books || [])
            .map((b) => b.cover_image)
            .filter(Boolean)
            .slice(0, 4) as string[];
        } catch {}
      }
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
      for (const b of importedBooks) {
        await groupService.moveBookToGroup(b.id, groupId);
      }
      setGroupingLoading(false);
      setGroupingOpen(false);
      setChooseGroupOpen(false);
      navigate("/?tab=all");
    } catch (e) {
      setGroupingLoading(false);
      alert("分组保存失败，请重试");
      console.error(e);
    }
  };

  const createGroupAndFinish = async (name: string) => {
    if (!name.trim()) return;
    try {
      setGroupingLoading(true);
      const g = await groupService.addGroup(name.trim());
      for (const b of importedBooks) {
        await groupService.moveBookToGroup(b.id, g.id);
      }
      setGroupingLoading(false);
      setGroupingOpen(false);
      setChooseGroupOpen(false);
      navigate("/?tab=all");
    } catch (e) {
      setGroupingLoading(false);
      alert("创建分组失败，请重试");
      console.error(e);
    }
  };

  return (
    <div
      className="import-page"
      style={{ height: "100vh", display: "flex", flexDirection: "column" }}
    >
      {/* Header / Search overlay */}
      {searchOpen ? (
        <div style={{ padding: "10px 12px" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              background: "#efefef",
              borderRadius: 12,
              height: 40,
              padding: "0 8px",
              overflow: "hidden",
            }}
          >
            <button
              onClick={() => setSearchOpen(false)}
              aria-label="返回"
              title="返回"
              style={{
                background: "transparent",
                border: "none",
                width: 32,
                height: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: 0,
                margin: 0,
                cursor: "pointer",
                color: "#666",
                boxShadow: "none",
                borderRadius: 0,
              }}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                <path
                  d="M15 18l-6-6 6-6"
                  stroke="#666"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <input
              value={globalSearch}
              onChange={(e) => setGlobalSearch(e.target.value)}
              placeholder="搜索扫描结果中的文件…"
              autoFocus
              style={{
                flex: 1,
                padding: "0 6px",
                border: "none",
                background: "transparent",
                outline: "none",
                fontSize: 14,
                color: "#333",
                caretColor: "#d15158",
                height: "100%",
                boxShadow: "none",
                WebkitAppearance: "none",
                appearance: "none",
                borderRadius: 0,
              }}
            />
            {globalSearch && (
              <button
                onClick={() => setGlobalSearch("")}
                title="清除"
                aria-label="清除"
                style={{
                  background: "transparent",
                  border: "none",
                  padding: "0 4px",
                  height: "100%",
                  display: "flex",
                  alignItems: "center",
                  cursor: "pointer",
                  boxShadow: "none",
                  borderRadius: 0,
                }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                  <circle
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="#999"
                    strokeWidth="2"
                  />
                  <path
                    d="M9 9l6 6m0-6l-6 6"
                    stroke="#999"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            )}
          </div>
        </div>
      ) : (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            padding: "12px 12px",
          }}
        >
          <button
            aria-label="返回"
            onClick={() => navigate(-1)}
            style={{
              background: "none",
              border: "none",
              boxShadow: "none",
              borderRadius: 0,
              cursor: "pointer",
              padding: 0,
            }}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
              <path
                d="M15 18l-6-6 6-6"
                stroke="#333"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <span style={{ fontSize: 16, color: "#333", marginLeft: 8 }}>
            扫描结果({results.length})
          </span>
          <div style={{ flex: 1 }} />
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <button
              aria-label="搜索"
              title="搜索"
              style={{
                background: "none",
                border: "none",
                boxShadow: "none",
                borderRadius: 0,
                cursor: "pointer",
                padding: 0,
              }}
              onClick={() => setSearchOpen(true)}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                <circle cx="11" cy="11" r="7" stroke="#333" strokeWidth="2" />
                <path
                  d="M21 21l-4-4"
                  stroke="#333"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </button>
            <button
              aria-label="全选"
              title="全选"
              style={{
                background: "none",
                border: "none",
                boxShadow: "none",
                borderRadius: 0,
                cursor: "pointer",
                padding: 0,
              }}
              onClick={() => {
                const candidates = filtered
                  .filter((it) => !it.imported)
                  .map((it) => it.path);
                const allSelected =
                  candidates.length > 0 &&
                  candidates.every((p) => selectedPaths.includes(p));
                setSelectedPaths(
                  allSelected
                    ? selectedPaths.filter((p) => !candidates.includes(p))
                    : Array.from(new Set([...selectedPaths, ...candidates]))
                );
              }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                <rect
                  x="3"
                  y="3"
                  width="7"
                  height="7"
                  stroke="#333"
                  strokeWidth="2"
                />
                <rect
                  x="14"
                  y="3"
                  width="7"
                  height="7"
                  stroke="#333"
                  strokeWidth="2"
                />
                <rect
                  x="3"
                  y="14"
                  width="7"
                  height="7"
                  stroke="#333"
                  strokeWidth="2"
                />
                <rect
                  x="14"
                  y="14"
                  width="7"
                  height="7"
                  stroke="#333"
                  strokeWidth="2"
                />
                <path
                  d="M6 8l2-2"
                  stroke="#333"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
                <path
                  d="M17 19l2-2"
                  stroke="#333"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* 搜索输入已在顶部覆盖栏显示 */}

      {/* List */}
      <div
        style={{ flex: 1, overflowY: "auto", padding: "8px 12px 56px 12px" }}
      >
        {filtered.map((item) => (
          <FileRow
            key={item.path}
            name={item.name}
            path={item.path}
            size={item.size}
            mtime={item.mtime}
            imported={item.imported}
            selected={selectedPaths.includes(item.path)}
            onToggle={toggleSelect}
            rowHeight={ROW_HEIGHT}
          />
        ))}
      </div>

      {/* 分组抽屉*/}
      {groupingOpen && (
        <GroupingDrawer
          open={groupingOpen}
          onClose={() => setGroupingOpen(false)}
          newGroupName={newGroupName}
          onNewGroupNameChange={(val) => setNewGroupName(val)}
          onChooseExistingGroup={openChooseGroup}
          onConfirmName={() => createGroupAndFinish(newGroupName)}
          loading={groupingLoading}
        />
      )}

      {/* 选择现有分组抽屉 */}
      {chooseGroupOpen && (
        <div
          aria-live="polite"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.35)",
            display: "flex",
            alignItems: "flex-end",
            zIndex: 1001,
          }}
          onClick={() => setChooseGroupOpen(false)}
        >
          <div
            role="dialog"
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "100%",
              background: "#fff",
              borderTopLeftRadius: 20,
              borderTopRightRadius: 20,
              padding: "18px 16px 24px 16px",
              boxSizing: "border-box",
              maxHeight: "70vh",
              overflowY: "auto",
            }}
          >
            <div style={{ color: "#333", fontSize: 16, marginBottom: 12 }}>
              现有分组
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(2, 1fr)",
                gap: 12,
              }}
            >
              {allGroups.map((g) => (
                <button
                  key={g.id}
                  onClick={() => assignToGroupAndFinish(g.id)}
                  style={{
                    background: "none",
                    border: "1px solid #eee",
                    borderRadius: 8,
                    padding: 8,
                    textAlign: "left",
                    cursor: "pointer",
                  }}
                >
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(2, 1fr)",
                      gap: 4,
                      marginBottom: 6,
                    }}
                  >
                    {(groupPreviews[g.id] || []).map((img, idx) => (
                      <div
                        key={idx}
                        style={{
                          width: "100%",
                          aspectRatio: "2 / 3",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          backgroundColor: "#fff",
                          border: "1px solid #dcdcdc",
                          borderRadius: 4,
                          overflow: "hidden",
                        }}
                      >
                        <img
                          src={`data:image/jpeg;base64,${img}`}
                          alt="cover"
                          style={{
                            width: "100%",
                            height: "100%",
                            objectFit: "cover",
                            objectPosition: "center",
                          }}
                        />
                      </div>
                    ))}
                  </div>
                  <div style={{ color: "#333", fontSize: 14 }}>{g.name}</div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Bottom bar: centered import count (Figure 2 style) */}
      <div
        style={{
          position: "fixed",
          bottom: 0,
          left: 0,
          right: 0,
          padding: "10px 16px",
          background: "#d23c3c",
          color: "#fff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
        }}
        onClick={handleImportClick}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span>导入({selectedPaths.length})</span>
        </div>
      </div>
    </div>
  );
};

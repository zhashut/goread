import React, { useMemo, useState, useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { FileRow } from "./FileRow";
import { groupService, bookService } from "../services";
import { IGroup, IBook } from "../types";
import GroupingDrawer from "./GroupingDrawer";
import ChooseExistingGroupDrawer from "./ChooseExistingGroupDrawer";
import { waitNextFrame } from "../services/importUtils";

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

//

export const ScanResults: React.FC = () => {
  const navigate = useNavigate();
  const { state } = useLocation() as { state?: { results?: ScanResultItem[]; fromTab?: "recent" | "all" } };
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [globalSearch, setGlobalSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  // 列表行高度（用于按比例缩放左侧图标尺寸）
  const ROW_HEIGHT = 60; // px

  const results: ScanResultItem[] = useMemo(
    () => state?.results || [],
    [state]
  );

  const toggleSelect = (path: string) => {
    setSelectedPaths((prev) =>
      prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path]
    );
  };

  // 分组抽屉状态
  const [groupingOpen, setGroupingOpen] = useState(false);
  const [chooseGroupOpen, setChooseGroupOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  // 改为仅记录待导入的文件路径，分组确认后才执行导入
  const [pendingImportPaths, setPendingImportPaths] = useState<string[]>([]);
  const [allGroups, setAllGroups] = useState<IGroup[]>([]);
  const [groupPreviews, setGroupPreviews] = useState<Record<number, string[]>>(
    {}
  );
  const [groupingLoading, setGroupingLoading] = useState(false);

  // 从数据库获取所有已导入的书籍路径
  const [allImportedBooks, setAllImportedBooks] = useState<IBook[]>([]);
  const importedPaths = useMemo(
    () => new Set(allImportedBooks.map((b) => b.file_path)),
    [allImportedBooks]
  );

  // 加载已导入的书籍列表
  useEffect(() => {
    const loadImportedBooks = async () => {
      try {
        await bookService.initDatabase();
        const books = await bookService.getAllBooks();
        setAllImportedBooks(books);
      } catch (error) {
        console.error("加载已导入书籍失败:", error);
      }
    };
    loadImportedBooks();
  }, []);

  // 更新结果中的已导入标记
  const resultsWithImported: ScanResultItem[] = useMemo(() => {
    return results.map((item) => ({
      ...item,
      imported: importedPaths.has(item.path),
    }));
  }, [results, importedPaths]);

  const filtered = useMemo(() => {
    const kw = globalSearch.trim().toLowerCase();
    return resultsWithImported.filter((it) => it.name.toLowerCase().includes(kw));
  }, [resultsWithImported, globalSearch]);

  const handleImportClick = async () => {
    // 直接使用已选中的文件路径，不再弹出文件选择对话框
    if (selectedPaths.length === 0) {
      alert("请先选择要导入的文件");
      return;
    }
    // 不立即导入，仅保存路径并打开分组抽屉
    setPendingImportPaths(selectedPaths);
    setGroupingOpen(true);
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
        } catch { }
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

      // 立即跳转到“全部”，并关闭抽屉
      setGroupingOpen(false);
      setChooseGroupOpen(false);
      navigate("/?tab=all");
      // 等待下一帧，确保首页（Bookshelf）已挂载并开始监听事件
      await waitNextFrame();

      const { importPathsToExistingGroup } = await import("../services/importRunner");
      await importPathsToExistingGroup(pendingImportPaths, groupId);
      setGroupingLoading(false);
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
      await groupService.addGroup(name.trim());

      // 立即跳转到“全部”，并关闭抽屉
      setGroupingOpen(false);
      setChooseGroupOpen(false);
      navigate("/?tab=all");
      // 等待下一帧，确保首页（Bookshelf）已挂载并开始监听事件
      await waitNextFrame();

      const { createGroupAndImport } = await import("../services/importRunner");
      await createGroupAndImport(pendingImportPaths, name.trim());
      setGroupingLoading(false);
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
            onClick={() => {
              if (state?.fromTab === "all") navigate("/?tab=all");
              else navigate(-1);
            }}
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
                padding: 0,
                cursor: (() => {
                  const candidates = filtered
                    .filter((it) => !it.imported && it.type === "file")
                    .map((it) => it.path);
                  return candidates.length > 0 ? "pointer" : "not-allowed";
                })(),
                opacity: (() => {
                  const candidates = filtered
                    .filter((it) => !it.imported && it.type === "file")
                    .map((it) => it.path);
                  return candidates.length > 0 ? 1 : 0.45;
                })(),
              }}
              disabled={(() => {
                const candidates = filtered
                  .filter((it) => !it.imported && it.type === "file")
                  .map((it) => it.path);
                return candidates.length === 0;
              })()}
              onClick={() => {
                const candidates = filtered
                  .filter((it) => !it.imported && it.type === "file")
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
              {(() => {
                const candidates = filtered
                  .filter((it) => !it.imported && it.type === "file")
                  .map((it) => it.path);
                const canSelectAll = candidates.length > 0;
                const allSelected = canSelectAll && candidates.every((p) => selectedPaths.includes(p));
                const strokeColor = canSelectAll ? (allSelected ? "#d23c3c" : "#333") : "#bbb";
                return (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                    <rect x="3" y="3" width="7" height="7" stroke={strokeColor} strokeWidth="2" />
                    <rect x="14" y="3" width="7" height="7" stroke={strokeColor} strokeWidth="2" />
                    <rect x="3" y="14" width="7" height="7" stroke={strokeColor} strokeWidth="2" />
                    <rect x="14" y="14" width="7" height="7" stroke={strokeColor} strokeWidth="2" />
                    <path d="M6 8l2-2" stroke={strokeColor} strokeWidth="2" strokeLinecap="round" />
                    <path d="M17 19l2-2" stroke={strokeColor} strokeWidth="2" strokeLinecap="round" />
                  </svg>
                );
              })()}
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
      <ChooseExistingGroupDrawer
        open={chooseGroupOpen}
        groups={allGroups}
        groupPreviews={groupPreviews}
        onClose={() => setChooseGroupOpen(false)}
        onSelectGroup={assignToGroupAndFinish}
      />

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

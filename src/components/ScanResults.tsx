import React, { useMemo, useState, useEffect } from "react";
import { useAppNav } from "../router/useAppNav";
import { FileRow } from "./FileRow";
import { bookService } from "../services";
import { IGroup, IBook } from "../types";
import GroupingDrawer from "./GroupingDrawer";
import ChooseExistingGroupDrawer from "./ChooseExistingGroupDrawer";
import { waitNextFrame } from "../services/importUtils";
import { logError } from "../services";
import { loadGroupsWithPreviews, assignToExistingGroupAndFinish } from "../utils/groupImport";
import { getSafeAreaInsets } from "../utils/layout";
import { FORMAT_DISPLAY_NAMES, getBookFormat } from "../constants/fileTypes";
import { BookFormat } from "../services/formats/types";
import { PageHeader } from "./PageHeader";

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

/** 搜索模式下的顶部栏 */
const SearchHeader: React.FC<{
  globalSearch: string;
  onSearchChange: (val: string) => void;
  onClose: () => void;
}> = ({ globalSearch, onSearchChange, onClose }) => (
  <div style={{ padding: "10px 12px", paddingTop: `calc(${getSafeAreaInsets().top} + 10px)` }}>
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
        onClick={onClose}
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
        onChange={(e) => onSearchChange(e.target.value)}
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
          onClick={() => onSearchChange("")}
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
            <circle cx="12" cy="12" r="10" stroke="#999" strokeWidth="2" />
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
);

/** 普通模式下的顶部栏，使用 PageHeader 组件 */
const Header: React.FC<{
  title: string;
  onBack: () => void;
  filterFormat: 'ALL' | BookFormat;
  filterMenuOpen: boolean;
  onFilterClick: (e: React.MouseEvent) => void;
  onFilterSelect: (fmt: 'ALL' | BookFormat) => void;
  onFilterMenuClose: () => void;
  onSearchClick: () => void;
  filtered: ScanResultItem[];
  selectedPaths: string[];
  onSelectAll: () => void;
}> = ({
  title,
  onBack,
  filterFormat,
  filterMenuOpen,
  onFilterClick,
  onFilterSelect,
  onFilterMenuClose,
  onSearchClick,
  filtered,
  selectedPaths,
  onSelectAll,
}) => {
  const candidates = filtered
    .filter((it) => !it.imported && it.type === "file")
    .map((it) => it.path);
  const canSelectAll = candidates.length > 0;
  const allSelected = canSelectAll && candidates.every((p) => selectedPaths.includes(p));
  const strokeColor = canSelectAll ? (allSelected ? "#d23c3c" : "#333") : "#bbb";

  return (
    <PageHeader
      title={title}
      onBack={onBack}
      rightContent={
        <div style={{ display: "flex", alignItems: "center" }}>
          {/* 筛选按钮 */}
          <div style={{ position: 'relative' }}>
            <button
              aria-label="筛选"
              title="筛选格式"
              style={{
                background: "none",
                border: "none",
                boxShadow: "none",
                borderRadius: 4,
                cursor: "pointer",
                padding: 0,
                marginRight: 16,
                width: 32,
                height: 32,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: filterMenuOpen || filterFormat !== 'ALL' ? '#f5f5f5' : 'transparent',
              }}
              onClick={onFilterClick}
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill={filterFormat !== 'ALL' ? '#d43d3d' : '#333'}>
                <path d="M10 18h4v-2h-4v2zM3 6v2h18V6H3zm3 7h12v-2H6v2z"/>
              </svg>
            </button>

            {/* 下拉菜单 */}
            {filterMenuOpen && (
              <>
                <div 
                  style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 999 }}
                  onClick={onFilterMenuClose}
                />
                <div style={{
                  position: 'absolute',
                  top: 40,
                  right: -8, 
                  background: '#fff',
                  borderRadius: 8,
                  boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
                  width: 140,
                  padding: '8px 0',
                  border: '1px solid #f0f0f0',
                  zIndex: 1000,
                  maxHeight: 400,
                  overflowY: 'auto',
                  animation: 'fadeIn 0.1s ease-out',
                }}>
                  <style>{`
                    @keyframes fadeIn {
                      from { opacity: 0; transform: scale(0.95); }
                      to { opacity: 1; transform: scale(1); }
                    }
                  `}</style>
                  <div 
                    style={{
                      padding: '10px 16px',
                      fontSize: 14,
                      color: filterFormat === 'ALL' ? '#d43d3d' : '#333',
                      backgroundColor: filterFormat === 'ALL' ? '#fffbfb' : 'transparent',
                      cursor: 'pointer',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      fontWeight: filterFormat === 'ALL' ? 500 : 400
                    }}
                    onClick={() => onFilterSelect('ALL')}
                  >
                    全部格式
                    {filterFormat === 'ALL' && <span style={{ color: '#d43d3d', fontSize: 12 }}>✓</span>}
                  </div>
                  {(Object.keys(FORMAT_DISPLAY_NAMES) as BookFormat[]).map(fmt => (
                    <div 
                      key={fmt}
                      style={{
                        padding: '10px 16px',
                        fontSize: 14,
                        color: filterFormat === fmt ? '#d43d3d' : '#333',
                        backgroundColor: filterFormat === fmt ? '#fffbfb' : 'transparent',
                        cursor: 'pointer',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        fontWeight: filterFormat === fmt ? 500 : 400
                      }}
                      onClick={() => onFilterSelect(fmt)}
                    >
                      {FORMAT_DISPLAY_NAMES[fmt]}
                      {filterFormat === fmt && <span style={{ color: '#d43d3d', fontSize: 12 }}>✓</span>}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* 搜索按钮 */}
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
              marginRight: 24,
            }}
            onClick={onSearchClick}
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

          {/* 全选按钮 */}
          <button
            aria-label="全选"
            title="全选"
            style={{
              background: "none",
              border: "none",
              boxShadow: "none",
              borderRadius: 0,
              padding: 0,
              cursor: canSelectAll ? "pointer" : "not-allowed",
              opacity: canSelectAll ? 1 : 0.45,
            }}
            disabled={!canSelectAll}
            onClick={onSelectAll}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <rect x="3" y="3" width="7" height="7" stroke={strokeColor} strokeWidth="2" />
              <rect x="14" y="3" width="7" height="7" stroke={strokeColor} strokeWidth="2" />
              <rect x="3" y="14" width="7" height="7" stroke={strokeColor} strokeWidth="2" />
              <rect x="14" y="14" width="7" height="7" stroke={strokeColor} strokeWidth="2" />
              <path d="M6 8l2-2" stroke={strokeColor} strokeWidth="2" strokeLinecap="round" />
              <path d="M17 19l2-2" stroke={strokeColor} strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      }
    />
  );
};

export const ScanResults: React.FC = () => {
  const nav = useAppNav();
  const { state } = nav.location as { state?: { results?: ScanResultItem[]; fromTab?: "recent" | "all" } };
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [globalSearch, setGlobalSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  // Filter state
  const [filterFormat, setFilterFormat] = useState<'ALL' | BookFormat>('ALL');
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);

  // Handle search open/close with history API to support back gesture
  useEffect(() => {
    const handlePopState = () => {
      if (searchOpen) {
        setSearchOpen(false);
        setGlobalSearch("");
      }
    };

    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, [searchOpen]);

  // 路由变化时关闭筛选菜单，避免遮罩层阻挡返回按钮
  useEffect(() => {
    setFilterMenuOpen(false);
  }, [nav.location.pathname]);

  const openSearch = () => {
    setSearchOpen(true);
    window.history.pushState({ overlay: "search" }, "");
  };

  const closeSearch = () => {
    // If search is open, going back will trigger popstate which closes it
    if (searchOpen) {
      window.history.back();
    }
  };

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
    return resultsWithImported.filter((it) => {
      if (!it.name.toLowerCase().includes(kw)) return false;
      if (filterFormat !== 'ALL') {
        const fmt = getBookFormat(it.path);
        if (fmt !== filterFormat) return false;
      }
      return true;
    });
  }, [resultsWithImported, globalSearch, filterFormat]);

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
      
      // 执行分配到现有分组的逻辑，完成后调用 finishImportFlow
      await assignToExistingGroupAndFinish(pendingImportPaths, groupId, () => {
        nav.finishImportFlow();
      });
      
      setGroupingLoading(false);
    } catch (e) {
      setGroupingLoading(false);
      alert("分组保存失败，请重试");
      await logError('assignToGroupAndFinish failed', 
        { error: String(e), pendingImportPaths: pendingImportPaths, groupId: groupId });
    }
  };

  const createGroupAndFinish = async (name: string) => {
    if (!name.trim()) return;
    try {
      setGroupingLoading(true);

      // 立即跳转/回退到“全部”，并关闭抽屉
      setGroupingOpen(false);
      setChooseGroupOpen(false);

      nav.finishImportFlow();

      // 等待下一帧，确保首页（Bookshelf）已挂载并开始监听事件
      await waitNextFrame();

      const { createGroupAndImport } = await import("../services/importRunner");
      await createGroupAndImport(pendingImportPaths, name.trim());
      setGroupingLoading(false);
    } catch (e) {
      setGroupingLoading(false);
      alert("创建分组失败，请重试");
      await logError('createGroupAndFinish failed', { error: String(e), name: name.trim() });
    }
  };

  return (
    <div
      className="import-page"
      style={{
        height: "100vh",
        width: "100vw",
        display: "flex",
        flexDirection: "column",
        boxSizing: "border-box",
        overflow: "hidden",
        background: "#fff",
      }}
    >
      {/* Header / Search overlay */}
      {searchOpen ? (
        <SearchHeader
          globalSearch={globalSearch}
          onSearchChange={setGlobalSearch}
          onClose={closeSearch}
        />
      ) : (
        <Header
          title={`扫描结果(${results.length})`}
          onBack={() => {
            // 先关闭筛选菜单，避免遮罩层阻挡导航
            setFilterMenuOpen(false);
            
            if (state?.fromTab === "all") nav.toBookshelf('all');
            else nav.goBack();
          }}
          filterFormat={filterFormat}
          filterMenuOpen={filterMenuOpen}
          onFilterClick={(e) => {
            e.stopPropagation();
            setFilterMenuOpen(!filterMenuOpen);
          }}
          onFilterSelect={(fmt) => { setFilterFormat(fmt); setFilterMenuOpen(false); }}
          onFilterMenuClose={() => setFilterMenuOpen(false)}
          onSearchClick={openSearch}
          filtered={filtered}
          selectedPaths={selectedPaths}
          onSelectAll={() => {
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
        />
      )}

      {/* 搜索输入已在顶部覆盖栏显示 */}

      {/* List */}
      <div
        style={{ flex: 1, overflowY: "auto", padding: "8px 12px" }}
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
          flex: "none",
          paddingBottom: getSafeAreaInsets().bottom,
          background: "#d23c3c",
          zIndex: 10,
          boxSizing: "border-box",
        }}
      >
        <div
          style={{
            padding: "10px 16px",
            color: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
          }}
          onClick={handleImportClick}
        >
          <div style={{ display: "flex", alignItems: "center" }}>
            <span>导入({selectedPaths.length})</span>
          </div>
        </div>
      </div>
    </div>
  );
};

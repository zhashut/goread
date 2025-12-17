import React, { useMemo, useState, useEffect } from "react";
import { useAppNav } from "../router/useAppNav";
import { FileRow } from "./FileRow";
import { ScanResultItem } from "../types";
import GroupingDrawer from "./GroupingDrawer";
import ChooseExistingGroupDrawer from "./ChooseExistingGroupDrawer";
import { getBookFormat } from "../constants/fileTypes";
import { BookFormat } from "../services/formats/types";
import { PageHeader } from "./PageHeader";
import { SearchHeader } from "./SearchHeader";
import { FormatFilterButton } from "./FormatFilterButton";
import { ImportBottomBar } from "./ImportBottomBar";
import { useImportedBooks, useImportGrouping, useSearchOverlay, useSelectAll } from "../hooks";

/** 普通模式下的顶部栏，使用 PageHeader 组件 */
const Header: React.FC<{
  title: string;
  onBack: () => void;
  filterFormat: 'ALL' | BookFormat;
  filterMenuOpen: boolean;
  onFilterOpenChange: (open: boolean) => void;
  onFilterSelect: (fmt: 'ALL' | BookFormat) => void;
  onSearchClick: () => void;
  filtered: ScanResultItem[];
  selectedPaths: string[];
  setSelectedPaths: React.Dispatch<React.SetStateAction<string[]>>;
}> = ({
  title,
  onBack,
  filterFormat,
  filterMenuOpen,
  onFilterOpenChange,
  onFilterSelect,
  onSearchClick,
  filtered,
  selectedPaths,
  setSelectedPaths,
}) => {
  const candidates = filtered
    .filter((it) => !it.imported && it.type === "file")
    .map((it) => it.path);

  const { canSelectAll, strokeColor, toggleSelectAll } = useSelectAll({
    selected: selectedPaths,
    setSelected: setSelectedPaths,
    candidates,
  });

  return (
    <PageHeader
      title={title}
      onBack={onBack}
      rightContent={
        <div style={{ display: "flex", alignItems: "center" }}>
          <FormatFilterButton
            filterFormat={filterFormat}
            menuOpen={filterMenuOpen}
            onMenuOpenChange={onFilterOpenChange}
            onSelect={onFilterSelect}
          />

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
            onClick={toggleSelectAll}
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
  // Filter state
  const [filterFormat, setFilterFormat] = useState<'ALL' | BookFormat>('ALL');
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const { searchOpen, openSearch, closeSearch } = useSearchOverlay({
    onReset: () => setGlobalSearch(""),
  });

  // 路由变化时关闭筛选菜单，避免遮罩层阻挡返回按钮
  useEffect(() => {
    setFilterMenuOpen(false);
  }, [nav.location.pathname]);

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

  const {
    groupingOpen,
    chooseGroupOpen,
    newGroupName,
    setNewGroupName,
    allGroups,
    groupPreviews,
    groupingLoading,
    setGroupingOpen,
    setChooseGroupOpen,
    openGroupingWithPaths,
    openChooseGroup,
    assignToGroupAndFinish,
    createGroupAndFinish,
  } = useImportGrouping({
    onFinishImport: () => {
      nav.finishImportFlow();
    },
  });
  const { importedPaths } = useImportedBooks();

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
    if (selectedPaths.length === 0) {
      alert("请先选择要导入的文件");
      return;
    }
    openGroupingWithPaths(selectedPaths);
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
          value={globalSearch}
          onChange={setGlobalSearch}
          onClose={closeSearch}
          onClear={() => setGlobalSearch("")}
          placeholder="搜索扫描结果中的文件…"
          autoFocus
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
          onFilterOpenChange={(open) => setFilterMenuOpen(open)}
          onFilterSelect={(fmt) => { setFilterFormat(fmt); setFilterMenuOpen(false); }}
          onSearchClick={openSearch}
          filtered={filtered}
          selectedPaths={selectedPaths}
          setSelectedPaths={setSelectedPaths}
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

      <ImportBottomBar
        label={`导入(${selectedPaths.length})`}
        onClick={handleImportClick}
        useSafeAreaPadding
      />
    </div>
  );
};

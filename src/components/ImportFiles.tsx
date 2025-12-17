import React, { useMemo, useRef, useState, useEffect } from "react";
import { FileRow } from "./FileRow";
import { useSearchParams } from "react-router-dom";
import { useAppNav } from "../router/useAppNav";
import { IBook, IGroup } from "../types";
import { bookService } from "../services";
import { fileSystemService } from "../services/fileSystemService";
import GroupingDrawer from "./GroupingDrawer";
import ChooseExistingGroupDrawer from "./ChooseExistingGroupDrawer";
import { waitNextFrame } from "../services/importUtils";
import { logError } from "../services";
import { loadGroupsWithPreviews, assignToExistingGroupAndFinish } from "../utils/groupImport";
import { isSupportedFile, FORMAT_DISPLAY_NAMES, getBookFormat } from "../constants/fileTypes";
import { BookFormat } from "../services/formats/types";
import { getSafeAreaInsets } from "../utils/layout";
import {
  SWIPE_EDGE_THRESHOLD,
  SWIPE_MIN_DISTANCE,
  SWIPE_MIN_SLOPE,
} from "../constants/interactions";

type TabKey = "scan" | "browse";

export interface FileEntry {
  type: "file" | "dir";
  name: string;
  path: string;
  size?: number; // 字节
  mtime?: number; // 时间戳(毫秒)
  children_count?: number; // 目录包含文件数
}

export interface ScanResultItem extends FileEntry {
  imported?: boolean;
  type: "file";
}

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

interface SearchHeaderProps {
  value: string;
  onChange: (val: string) => void;
  onClose: () => void;
  onClear: () => void;
}

const SearchHeader: React.FC<SearchHeaderProps> = ({
  value,
  onChange,
  onClose,
  onClear,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // 稍微延迟聚焦，确保动画或渲染完成
    const timer = setTimeout(() => {
      inputRef.current?.focus();
    }, 50);
    return () => clearTimeout(timer);
  }, []);

  return (
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
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="搜索设备内书籍文件…"
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
        {value && (
          <button
            onClick={onClear}
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
};

export const ImportFiles: React.FC = () => {
  const nav = useAppNav();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = (nav.location.state as any)?.initialTab as TabKey | undefined;
  const [activeTab, setActiveTab] = useState<TabKey>(initialTab ?? "scan");
  const [scanLoading, setScanLoading] = useState(false);
  const [scanList, setScanList] = useState<ScanResultItem[]>([]);
  // 扫描抽屉 & 进度
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [scannedCount, setScannedCount] = useState(0);
  const [foundPdfCount, setFoundPdfCount] = useState(0);
  const scanTimerRef = useRef<number | null>(null);
  const scannedCountRef = useRef(0);
  const foundPdfCountRef = useRef(0);
  const progressIntervalRef = useRef<number | null>(null);
  const scanCancelledRef = useRef(false);
  // 顶部共享搜索（两个栏目共用）
  const [globalSearch] = useState("");
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  // 导入后的分组抽屉
  const [groupingOpen, setGroupingOpen] = useState(false);
  const [chooseGroupOpen, setChooseGroupOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  // 改为在分组确认后才开始导入：这里仅保存待导入的文件路径
  const [pendingImportPaths, setPendingImportPaths] = useState<string[]>([]);
  const [allGroups, setAllGroups] = useState<IGroup[]>([]);
  const [groupPreviews, setGroupPreviews] = useState<Record<number, string[]>>(
    {}
  );
  const [groupingLoading, setGroupingLoading] = useState(false);

  const [browseStack, setBrowseStack] = useState<FileEntry[][]>([]);
  // 面包屑路径栈：与 browseStack 同步，索引 0 为根
  const [browseDirStack, setBrowseDirStack] = useState<
    { name: string; path: string }[]
  >([]);
  const [browseSearch, setBrowseSearch] = useState("");
  const [filterFormat, setFilterFormat] = useState<'ALL' | BookFormat>('ALL');
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);

  // Handle search open/close with history API to support back gesture
  useEffect(() => {
    const handlePopState = () => {
      if (searchOpen) {
        setSearchOpen(false);
        setBrowseSearch("");
      }
    };

    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, [searchOpen]);

  const openSearch = () => {
    if (!searchOpen) {
      setSearchOpen(true);
      window.history.pushState({ overlay: "search" }, "");
    }
  };

  const closeSearch = () => {
    if (searchOpen) {
      window.history.back();
    }
  };

  // Reset filter when tab changes
  useEffect(() => {
      setFilterFormat('ALL');
      setFilterMenuOpen(false);
  }, [activeTab]);

  const touchStartRef = useRef<{ x: number; y: number } | null>(null);

  const handleTouchStart = (e: React.TouchEvent) => {
    if (drawerOpen || groupingOpen || chooseGroupOpen || scanLoading || groupingLoading) return;
    touchStartRef.current = {
      x: e.touches[0].clientX,
      y: e.touches[0].clientY,
    };
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (!touchStartRef.current) return;

    const startX = touchStartRef.current.x;
    if (startX < SWIPE_EDGE_THRESHOLD || startX > window.innerWidth - SWIPE_EDGE_THRESHOLD) {
      touchStartRef.current = null;
      return;
    }
    
    const touchEnd = {
      x: e.changedTouches[0].clientX,
      y: e.changedTouches[0].clientY,
    };

    const diffX = touchStartRef.current.x - touchEnd.x;
    const diffY = touchStartRef.current.y - touchEnd.y;

    touchStartRef.current = null;

    if (Math.abs(diffX) > SWIPE_MIN_DISTANCE && Math.abs(diffX) > Math.abs(diffY) * SWIPE_MIN_SLOPE) {
      if (diffX > 0) {
        // 左滑 -> 前往 "browse"
        if (activeTab === "scan") {
          setActiveTab("browse");
        }
      } else {
        // 右滑 -> 前往 "scan"
        if (activeTab === "browse") {
          setActiveTab("scan");
        }
      }
    }
  };

  const [browseLoading, setBrowseLoading] = useState(false);
  const ROW_HEIGHT = 60; // 统一行高，复用 FileRow 的布局

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

  // 加载根目录（权限已在入口处检查）
  useEffect(() => {
    const loadRootDirs = async () => {
      if (activeTab === "browse" && browseStack.length === 0) {
        setBrowseLoading(true);
        try {
          const roots = await fileSystemService.getRootDirectories();
          setBrowseStack([roots]);
          setBrowseDirStack([{ name: "存储设备", path: "" }]);
        } catch (error) {
          console.error("加载根目录失败:", error);
          alert("加载根目录失败，请检查权限");
        } finally {
          setBrowseLoading(false);
        }
      }
    };
    loadRootDirs();
  }, [activeTab]);

  const filteredScan = useMemo(() => {
    const keyword = globalSearch.trim().toLowerCase();
    return scanList.filter((it) =>
      it.name.toLowerCase().includes(keyword)
    );
  }, [scanList, globalSearch]);

  const currentBrowse = useMemo(() => {
    const level = browseStack[browseStack.length - 1] || [];
    return level.filter((it) => it.type === "dir" || isSupportedFile(it.path));
  }, [browseStack]);
  const devicePdfIndex = useMemo(() => {
    // 简易设备索引：聚合已访问目录中的支持的文件
    const files: FileEntry[] = [];
    for (const level of browseStack) {
      for (const it of level) {
        if (it.type === "file" && isSupportedFile(it.path)) {
          files.push(it);
        }
      }
    }
    return files;
  }, [browseStack]);

  const filteredBrowse = useMemo(() => {
    const kw = browseSearch.trim().toLowerCase();
    let source = currentBrowse;
    
    if (kw) {
      source = devicePdfIndex.filter((it) => it.name.toLowerCase().includes(kw));
    }
    
    if (filterFormat !== 'ALL') {
        return source.filter(it => {
            if (it.type === 'dir') return true;
            return getBookFormat(it.path) === filterFormat;
        });
    }
    return source;
  }, [currentBrowse, browseSearch, devicePdfIndex, filterFormat]);

  const canFilter = useMemo(() => {
      if (activeTab !== 'browse') return false;
      return currentBrowse.some(it => it.type === 'file');
  }, [activeTab, currentBrowse]);

  const completeScan = (results: FileEntry[]) => {
    if (scanTimerRef.current) {
      clearInterval(scanTimerRef.current);
      scanTimerRef.current = null;
    }
    setScanLoading(false);
    setDrawerOpen(false);
    const mapped: ScanResultItem[] = results.map((it) => ({
      ...it,
      type: "file" as const,
      imported: importedPaths.has(it.path),
    }));
    setScanList(mapped);
    // foundPdfCount 已经在 startScan 中更新，这里不需要再次设置
    setActiveTab("scan");
   // 跳转到结果页并传递数据
    nav.toImportResults({ results: mapped, fromTab: (nav.location.state as any)?.fromTab });
  };

  const startScan = async () => {
    // 权限已在入口处检查，直接开始扫描
    setActiveTab("scan");
    setScanLoading(true);
    setDrawerOpen(true);
    setScannedCount(0);
    setFoundPdfCount(0);
    scannedCountRef.current = 0;
    foundPdfCountRef.current = 0;
    scanCancelledRef.current = false;

    try {
      // 执行真实扫描，带进度回调
      const results = await fileSystemService.scanBookFiles(
        undefined,
        (scanned, found) => {
          // 实时更新扫描进度
          // 确保 scanned 是数字类型，避免字符串拼接等问题
          const scannedNum = typeof scanned === 'number' ? scanned : parseInt(String(scanned || 0), 10);
          const foundNum = typeof found === 'number' ? found : parseInt(String(found || 0), 10);
          setScannedCount(scannedNum);
          setFoundPdfCount(foundNum);
        }
      );

      if (scanCancelledRef.current) {
        setFoundPdfCount(results.length);
        completeScan(results);
        return;
      }

      // 确保最终数量正确显示（scannedCount 已经在进度回调中更新，这里只需要更新 foundPdfCount）
      setFoundPdfCount(results.length);

      // 延迟1秒，确保用户能看到最终扫描结果
      await new Promise(resolve => setTimeout(resolve, 1000));

      completeScan(results);
    } catch (error: any) {
      console.error("扫描失败:", error);
      const msg =
        typeof error?.message === "string" ? error.message : String(error);
      alert(`扫描失败，请重试\n\n原因：${msg}`);
      setScanLoading(false);
      setDrawerOpen(false);
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current);
        progressIntervalRef.current = null;
      }
    }
  };

  const stopScan = async () => {
    scanCancelledRef.current = true;
    try {
      await fileSystemService.cancelScan();
    } catch (e) {
      console.error('取消扫描失败:', e);
    }
    if (progressIntervalRef.current) {
      clearInterval(progressIntervalRef.current);
      progressIntervalRef.current = null;
    }
    setScanLoading(false);
  };

  const toggleSelect = (path: string) => {
    setSelectedPaths((prev) =>
      prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path]
    );
  };

  // 默认分组名由用户输入，不再从文件名推断

  const handleImportClick = async () => {
    // 直接使用已选中的文件路径，不再弹出文件选择对话框
    if (selectedPaths.length === 0) {
      alert("请先选择要导入的文件");
      return;
    }
    // 不立即导入，仅记录路径并打开分组抽屉
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
      await assignToExistingGroupAndFinish(pendingImportPaths, groupId, () => nav.toBookshelf('all', { replace: true }));
      setGroupingLoading(false);
    } catch (e) {
      setGroupingLoading(false);
      alert("分组保存失败，请重试");
      await logError('assignToGroupAndFinish failed', { error: String(e), groupId: groupId });
    }
  };

  const createGroupAndFinish = async (name: string) => {
    if (!name.trim()) return;
    try {
      setGroupingLoading(true);

      // 立即跳转到“全部”，并关闭抽屉
      setGroupingOpen(false);
      setChooseGroupOpen(false);
      nav.toBookshelf('all', { replace: true });
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

  const goInto = (entry: FileEntry) => {
    if (entry.type !== "dir") return;
    setSearchParams({ tab: "browse", path: entry.path });
  };

  // 目录返回通过面包屑点击实现，无需单独函数

  const goToDepth = async (idx: number) => {
    if (idx < 0 || idx >= browseStack.length) return;
    setBrowseLoading(true);
    try {
      // 如果返回到根目录，重新加载根目录
      if (idx === 0) {
        const roots = await fileSystemService.getRootDirectories();
        setBrowseStack([roots]);
        setBrowseDirStack([{ name: "存储设备", path: "" }]);
      } else {
        // 否则直接截取栈
        setBrowseStack((stack) => stack.slice(0, idx + 1));
        setBrowseDirStack((stack) => stack.slice(0, idx + 1));
      }
    } catch (error: any) {
      console.error("导航失败:", error);
    } finally {
      setBrowseLoading(false);
    }
  };

  // 监听 URL 参数变化，处理浏览器后退/手势返回/前进
  useEffect(() => {
    const pathParam = searchParams.get("path") || "";
    
    // 获取当前栈顶路径
    const currentStack = browseDirStack;
    const currentPath = currentStack[currentStack.length - 1]?.path || "";

    if (pathParam === currentPath) return;

    // 1. 后退操作：如果 URL 中的路径存在于当前栈中（且不是栈顶）
    const backIndex = currentStack.findIndex((item) => item.path === pathParam);
    if (backIndex !== -1) {
      goToDepth(backIndex);
      return;
    }

    // 2. 前进操作：如果 URL 路径不在栈中，尝试从当前文件列表中查找目标目录
    const currentFiles = browseStack[browseStack.length - 1];
    if (currentFiles) {
      const targetEntry = currentFiles.find(
        (f) => f.path === pathParam && f.type === "dir"
      );

      if (targetEntry) {
        const loadDir = async () => {
          setBrowseLoading(true);
          try {
            const children = await fileSystemService.listDirectorySupported(targetEntry.path);
            setBrowseStack((stack) => [...stack, children]);
            setBrowseDirStack((stack) => [
              ...stack,
              { name: targetEntry.name, path: targetEntry.path },
            ]);
          } catch (error: any) {
            console.error("读取目录失败:", error);
            const msg =
              typeof error?.message === "string" ? error.message : String(error);
            // 这里不使用 alert 打断，因为是 URL 驱动的，可能只是打印日志
            console.warn(`无法进入目录: ${msg}`);
          } finally {
            setBrowseLoading(false);
          }
        };
        loadDir();
      }
    }
  }, [searchParams, browseDirStack, browseStack]);

  const Header: React.FC = () => {
    return (
      <div
        style={{ display: "flex", alignItems: "center", padding: "12px 12px" }}
      >
        <button
          aria-label="返回"
          onClick={() => {
            const state: any = nav.location.state || {};
            // 直接退出导入页面，不再逐级返回
            if (state.fromTab === "all") nav.toBookshelf('all');
            else nav.toBookshelf('recent');
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
          {scanList.length > 0 ? `扫描结果(${scanList.length})` : "导入文件"}
        </span>
        <div style={{ flex: 1 }} />
        {(activeTab === "browse" || (activeTab === "scan" && filteredScan.length > 0)) && (
          <div style={{ display: "flex", alignItems: "center" }}>
            {/* Filter Button */}
            <div style={{ position: 'relative' }}>
              <button
                aria-label="筛选"
                title="筛选格式"
                disabled={!canFilter}
                style={{
                  background: "none",
                  border: "none",
                  boxShadow: "none",
                  borderRadius: 4,
                  cursor: canFilter ? "pointer" : "default",
                  padding: 0,
                  marginRight: 16,
                  width: 32,
                  height: 32,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: filterMenuOpen || filterFormat !== 'ALL' ? '#f5f5f5' : 'transparent',
                  opacity: canFilter ? 1 : 0.3,
                }}
                onClick={(e) => {
                    e.stopPropagation();
                    if (canFilter) {
                        setFilterMenuOpen(!filterMenuOpen);
                    }
                }}
              >
                <svg width="24" height="24" viewBox="0 0 24 24" fill={filterFormat !== 'ALL' && canFilter ? '#d43d3d' : '#333'}>
                  <path d="M10 18h4v-2h-4v2zM3 6v2h18V6H3zm3 7h12v-2H6v2z"/>
                </svg>
              </button>

              {/* Dropdown Menu */}
              {filterMenuOpen && canFilter && (
                <>
                  <div 
                    style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 999 }}
                    onClick={() => setFilterMenuOpen(false)}
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
                        onClick={() => { setFilterFormat('ALL'); setFilterMenuOpen(false); }}
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
                            onClick={() => { setFilterFormat(fmt); setFilterMenuOpen(false); }}
                        >
                            {FORMAT_DISPLAY_NAMES[fmt]}
                            {filterFormat === fmt && <span style={{ color: '#d43d3d', fontSize: 12 }}>✓</span>}
                        </div>
                    ))}
                  </div>
                </>
              )}
            </div>

            {activeTab === "browse" && (
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
                  marginRight: 16,
                }}
                onClick={openSearch}
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
            )}
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
                  const candidates = activeTab === "browse"
                    ? currentBrowse
                        .filter((it) => it.type === "file" && isSupportedFile(it.path) && !importedPaths.has(it.path))
                        .map((it) => it.path)
                    : filteredScan.filter((it) => !it.imported).map((it) => it.path);
                  return candidates.length > 0 ? "pointer" : "not-allowed";
                })(),
                opacity: (() => {
                  const candidates = activeTab === "browse"
                    ? currentBrowse
                        .filter((it) => it.type === "file" && isSupportedFile(it.path) && !importedPaths.has(it.path))
                        .map((it) => it.path)
                    : filteredScan.filter((it) => !it.imported).map((it) => it.path);
                  return candidates.length > 0 ? 1 : 0.45;
                })(),
              }}
              disabled={(() => {
                const candidates = activeTab === "browse"
                  ? currentBrowse
                      .filter((it) => it.type === "file" && isSupportedFile(it.path) && !importedPaths.has(it.path))
                      .map((it) => it.path)
                  : filteredScan.filter((it) => !it.imported).map((it) => it.path);
                return candidates.length === 0;
              })()}
              onClick={() => {
                const candidates = activeTab === "browse"
                  ? currentBrowse
                      .filter((it) => it.type === "file" && isSupportedFile(it.path) && !importedPaths.has(it.path))
                      .map((it) => it.path)
                  : filteredScan.filter((it) => !it.imported).map((it) => it.path);
                if (candidates.length === 0) return;
                const allSelected = candidates.every((p) => selectedPaths.includes(p));
                setSelectedPaths(
                  allSelected
                    ? selectedPaths.filter((p) => !candidates.includes(p))
                    : Array.from(new Set([...selectedPaths, ...candidates]))
                );
              }}
            >
              {(() => {
                const candidates = activeTab === "browse"
                  ? currentBrowse
                      .filter((it) => it.type === "file" && isSupportedFile(it.path) && !importedPaths.has(it.path))
                      .map((it) => it.path)
                  : filteredScan.filter((it) => !it.imported).map((it) => it.path);
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
        )}
      </div>
    );
  };

  const Tabs: React.FC = () => (
    <div style={{ display: "flex", padding: "8px 0 0 0" }}>
      {(["scan", "browse"] as TabKey[]).map((key) => (
        <button
          key={key}
          onClick={() => setActiveTab(key)}
          style={{
            background: "none",
            border: "none",
            boxShadow: "none",
            borderRadius: 0,
            padding: "0 12px",
            cursor: "pointer",
            flex: 1,
            textAlign: "center",
          }}
        >
          <div
            style={{
              color: activeTab === key ? "#d23c3c" : "#999",
              fontSize: 14,
            }}
          >
            {key === "scan" ? "自动扫描" : "浏览全部"}
          </div>
          <div
            style={{
              height: 3,
              width: 64,
              background: activeTab === key ? "#d23c3c" : "transparent",
              margin: "8px auto 0 auto",
            }}
          />
        </button>
      ))}
    </div>
  );

  const ScanEmpty: React.FC = () => (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100%", // 充满父容器
        paddingBottom: 40, // 视觉调整，避免图标过于居中偏下
        boxSizing: "border-box",
      }}
    >
      {/* Radar-style scan icon, static (without red pointer) */}
      <svg width="120" height="120" viewBox="0 0 24 24" fill="none" aria-hidden>
        {/* Base circles */}
        <circle cx="12" cy="12" r="9" stroke="#ddd" strokeWidth="2" />
        <circle cx="12" cy="12" r="6.5" stroke="#eee" strokeWidth="1" />
        <circle cx="12" cy="12" r="3.5" stroke="#eee" strokeWidth="1" />
        {/* Cross hair */}
        <line x1="3" y1="12" x2="21" y2="12" stroke="#eee" strokeWidth="1" />
        <line x1="12" y1="3" x2="12" y2="21" stroke="#eee" strokeWidth="1" />
        {/* Center dot */}
        <circle cx="12" cy="12" r="2" fill="#bbb" />
      </svg>
    </div>
  );

  const ScanList: React.FC = () => (
    <div style={{ padding: "8px 12px" }}>
      <div>
        {filteredScan.map((item) => (
          <FileRow
            key={item.path}
            name={item.name}
            path={item.path}
            size={item.size}
            mtime={item.mtime}
            imported={item.imported || importedPaths.has(item.path)}
            selected={selectedPaths.includes(item.path)}
            onToggle={toggleSelect}
            rowHeight={ROW_HEIGHT}
            mode="select"
          />
        ))}
      </div>
    </div>
  );

  const BrowseList: React.FC = () => (
    <div style={{ padding: "8px 12px" }}>
      {/* 面包屑路径：支持点击退回任意层级 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          color: "#666",
          fontSize: 13,
          padding: "0 4px 8px 4px",
        }}
      >
        {browseDirStack.map((seg, idx) => (
          <React.Fragment key={seg.path + idx}>
            <button
              onClick={() => {
                if (!browseLoading) {
                  setSearchParams({ tab: "browse", path: browseDirStack[idx].path }, { replace: true });
                }
              }}
              style={{
                background: "none",
                border: "none",
                boxShadow: "none",
                borderRadius: 0,
                cursor:
                  idx === browseDirStack.length - 1 || browseLoading
                    ? "default"
                    : "pointer",
                color: idx === browseDirStack.length - 1 ? "#999" : "#555",
                padding: 0,
                opacity: browseLoading ? 0.6 : 1,
                marginRight: 6,
              }}
              title={seg.path}
              disabled={browseLoading}
            >
              {seg.name}
            </button>
            {idx < browseDirStack.length - 1 && (
              <span style={{ color: "#999", marginRight: 6 }}>›</span>
            )}
          </React.Fragment>
        ))}
      </div>
      {filteredBrowse.map((entry) =>
        entry.type === "dir" ? (
          <div
            key={entry.path}
            onClick={() => !browseLoading && goInto(entry)}
            style={{
              display: "flex",
              alignItems: "center",
              height: ROW_HEIGHT,
              padding: "0 4px",
              borderBottom: "1px solid #f0f0f0",
              cursor: browseLoading ? "wait" : "pointer",
              opacity: browseLoading ? 0.6 : 1,
            }}
          >
            {(() => {
              const iconSize = Math.round(ROW_HEIGHT * 0.85);
              return (
                <svg
                  width={iconSize}
                  height={iconSize}
                  viewBox="0 0 24 24"
                  fill="#f29b00"
                  style={{ marginRight: 14 }}
                >
                  <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
                </svg>
              );
            })()}
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
              <div style={{ color: "#888", fontSize: 12 }}>
                {`${entry.children_count || 0}项`} · {fmtDate(entry.mtime)}
              </div>
            </div>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path
                d="M9 6l6 6-6 6"
                stroke="#999"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        ) : (
          <FileRow
            key={entry.path}
            name={entry.name}
            path={entry.path}
            size={entry.size}
            mtime={entry.mtime}
            imported={importedPaths.has(entry.path)}
            selected={selectedPaths.includes(entry.path)}
            onToggle={toggleSelect}
            rowHeight={ROW_HEIGHT}
            mode="select"
          />
        )
      )}

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
    </div>
  );

  return (
    <div
      className="import-page"
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      style={{
        height: "100vh",
        width: "100vw",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        paddingTop: getSafeAreaInsets().top,
        boxSizing: "border-box",
        background: "#fff",
      }}
    >
      {/* Header Area */}
      <div style={{ flex: "none", zIndex: 10, boxSizing: "border-box" }}>
        {searchOpen && activeTab === "browse" ? (
          <SearchHeader
            value={browseSearch}
            onChange={setBrowseSearch}
            onClose={closeSearch}
            onClear={() => setBrowseSearch("")}
          />
        ) : (
          <>
            <Header />
            <Tabs />
          </>
        )}
      </div>

      {/* Content Area */}
      <style>
        {`
          .no-scrollbar::-webkit-scrollbar {
            display: none;
          }
          .no-scrollbar {
            -ms-overflow-style: none;
            scrollbar-width: none;
          }
        `}
      </style>
      <div className="no-scrollbar" style={{ flex: 1, overflowY: "auto", position: "relative" }}>
        {activeTab === "scan" ? (
          scanList.length === 0 && globalSearch.trim() === "" && !scanLoading ? (
            <ScanEmpty />
          ) : (
            <ScanList />
          )
        ) : browseLoading && browseStack.length === 0 ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              height: "100%",
              color: "#999",
            }}
          >
            加载中...
          </div>
        ) : (
          <BrowseList />
        )}
      </div>

      {/* Footer Area */}
      {!(activeTab === "browse" && browseLoading && browseStack.length === 0) && (
        <div
          style={{
            flex: "none",
            background: "#d23c3c",
            zIndex: 10,
            boxSizing: "border-box",
          }}
        >
          <div
            role="button"
            onClick={() => {
              if (activeTab === "scan" && scanList.length === 0 && globalSearch.trim() === "" && !scanLoading) {
                 if (!scanLoading) startScan();
              } else {
                 handleImportClick();
              }
            }}
            style={{
              padding: "10px 16px",
              color: "#fff",
              textAlign: "center",
              cursor: scanLoading ? "default" : "pointer",
              userSelect: "none",
            }}
          >
            <span style={{ fontSize: 14, letterSpacing: 1 }}>
              {activeTab === "scan" && scanList.length === 0 && globalSearch.trim() === "" && !scanLoading
                ? (scanLoading ? "正在扫描…" : "立即扫描")
                : `导入(${selectedPaths.length})`}
            </span>
          </div>
        </div>
      )}

      {/* Drawers */}
      {drawerOpen && (
        <div
          aria-live="polite"
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0,0,0,0.35)",
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "center",
            zIndex: 1000,
          }}
        >
          <div
            role="dialog"
            style={{
              width: "100%",
              transform: "translateY(0)",
              transition: "transform 220ms ease-out",
              background: "#fff",
              borderTopLeftRadius: 20,
              borderTopRightRadius: 20,
              padding: `18px 16px calc(24px + ${getSafeAreaInsets().bottom}) 16px`,
              boxSizing: "border-box",
            }}
          >
            <div style={{ textAlign: "center", color: "#333", fontSize: 15 }}>
              已扫描 {scannedCount} 个文件
            </div>
            <div
              style={{
                textAlign: "center",
                color: "#666",
                fontSize: 14,
                marginTop: 6,
              }}
            >
              找到：书籍({foundPdfCount})
            </div>
            <div style={{ marginTop: 18 }}>
              <button
                className="drawer-stop"
                onClick={stopScan}
                style={{
                  width: "88%",
                  height: 44,
                  background: "#d23c3c",
                  color: "#fff",
                  border: "none",
                  borderRadius: 22,
                  cursor: "pointer",
                  display: "block",
                  margin: "0 auto",
                }}
              >
                停止扫描
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};


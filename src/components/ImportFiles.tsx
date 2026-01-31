import React, { useMemo, useRef, useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { FileRow } from "./FileRow";
import { Loading } from "./Loading";
import { useSearchParams } from "react-router-dom";
import { useAppNav } from "../router/useAppNav";
import { FileEntry, ScanResultItem } from "../types";
import { fileSystemService } from "../services/fileSystemService";
import GroupingDrawer from "./GroupingDrawer";
import ChooseExistingGroupDrawer from "./ChooseExistingGroupDrawer";
import { isSupportedFile, getBookFormat, DEFAULT_SCAN_FORMATS, SCAN_SUPPORTED_FORMATS } from "../constants/fileTypes";
import { BookFormat } from "../services/formats/types";
import { getSafeAreaInsets } from "../utils/layout";
import {
  SWIPE_EDGE_THRESHOLD,
  SWIPE_MIN_DISTANCE,
  SWIPE_MIN_SLOPE,
} from "../constants/interactions";
import { PageHeader } from "./PageHeader";
import { SearchHeader } from "./SearchHeader";
import { FormatFilterButton } from "./FormatFilterButton";
import { ImportBottomBar } from "./ImportBottomBar";
import { useImportedBooks, useImportGrouping, useSearchOverlay, useSelectAll, useOverlayBackHandler } from "../hooks";
import { checkStoragePermission as checkStoragePermissionUtil } from "../utils/storagePermission";
import { logError } from "../services";
import { useScanFormats } from "../hooks/useScanFormats";
import { ScanFormatSelector } from "./ScanFormatSelector";

type TabKey = "scan" | "browse";

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

export const ImportFiles: React.FC = () => {
  const { t } = useTranslation('bookshelf');
  const { t: tc } = useTranslation('common');
  const { scanFormats, setScanFormats } = useScanFormats();
  const nav = useAppNav();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = (nav.location.state as any)?.initialTab as TabKey | undefined;
  const [activeTab, setActiveTab] = useState<TabKey>(initialTab ?? "scan");
  const [scanLoading, setScanLoading] = useState(false);
  const [scanList, setScanList] = useState<ScanResultItem[]>([]);
  // 扫描格式筛选菜单状态
  const [formatMenuOpen, setFormatMenuOpen] = useState(false);
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

  const [browseSearch, setBrowseSearch] = useState("");
  const { searchOpen, openSearch, closeSearch } = useSearchOverlay({
    onReset: () => setBrowseSearch(""),
  });

  // 导入后的分组抽屉
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
      // 关闭搜索视图（如果有）
      if (searchOpen) {
        closeSearch();
      }
      // 计算进入了多少层目录（browseDirStack 第一层是根目录，不算）
      const depth = browseDirStack.length > 0 ? browseDirStack.length - 1 : 0;
      nav.finishImportFlow({ extraDepth: depth });
    },
  });

  const [browseStack, setBrowseStack] = useState<FileEntry[][]>([]);
  // 面包屑路径栈：与 browseStack 同步，索引 0 为根
  const [browseDirStack, setBrowseDirStack] = useState<
    { name: string; path: string }[]
  >([]);
  // 浏览tab的格式筛选，从 localStorage 读取或使用默认值
  const [filterFormats, setFilterFormats] = useState<BookFormat[]>(() => {
    const saved = localStorage.getItem('browse_filter_formats');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed as BookFormat[];
        }
      } catch {
      }
    }
    return DEFAULT_SCAN_FORMATS;
  });
  const updateFilterFormats = useCallback((formats: BookFormat[]) => {
    setFilterFormats(formats);
    try {
      localStorage.setItem('browse_filter_formats', JSON.stringify(formats));
    } catch {
    }
  }, []);
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);

  // 保存筛选格式到 localStorage
  useEffect(() => {
    localStorage.setItem('browse_filter_formats', JSON.stringify(filterFormats));
  }, [filterFormats]);

  // 路由变化时关闭筛选菜单，避免遮罩层阻挡返回按钮
  useEffect(() => {
    setFilterMenuOpen(false);
  }, [nav.location.pathname]);

  const touchStartRef = useRef<{ x: number; y: number } | null>(null);

  const handleTouchStart = (e: React.TouchEvent) => {
    if (drawerOpen || groupingOpen || chooseGroupOpen || scanLoading || groupingLoading || filterMenuOpen || searchOpen) return;
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
          // 计算进入了多少层目录（browseDirStack 第一层是根目录，不算）
          const depth = browseDirStack.length - 1;
          setBrowseStack([]);
          setBrowseDirStack([]);
          // 回退历史记录栈中进入目录时添加的记录
          if (depth > 0) {
            nav.go(-depth);
          }
          setActiveTab("scan");
        }
      }
    }
  };

  const [browseLoading, setBrowseLoading] = useState(false);
  const ROW_HEIGHT = 60;
  const { importedPaths } = useImportedBooks();

  // 加载根目录（权限已在入口处检查）
  useEffect(() => {
    const loadRootDirs = async () => {
      if (activeTab === "browse" && browseStack.length === 0) {
        setBrowseLoading(true);
        try {
          const roots = await fileSystemService.getRootDirectories();
          setBrowseStack([roots]);
          setBrowseDirStack([{ name: t('storageDevices'), path: "" }]);
        } catch (error) {
          alert(t('loadRootFailed'));
        } finally {
          setBrowseLoading(false);
        }
      }
    };
    loadRootDirs();
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
    
    const isAllSelected = SCAN_SUPPORTED_FORMATS.every(fmt => filterFormats.includes(fmt));
    if (!isAllSelected) {
        return source.filter(it => {
            if (it.type === 'dir') return true;
            const fmt = getBookFormat(it.path);
            return fmt && filterFormats.includes(fmt);
        });
    }
    return source;
  }, [currentBrowse, browseSearch, devicePdfIndex, filterFormats]);

  const canFilter = useMemo(() => {
      if (activeTab !== 'browse') return false;
      return currentBrowse.some(it => it.type === 'file');
  }, [activeTab, currentBrowse]);

  const handleFilterMenuClose = useCallback(() => {
    setFilterMenuOpen(false);
  }, []);

  const handleFormatMenuClose = useCallback(() => {
    setFormatMenuOpen(false);
  }, []);

  useOverlayBackHandler({
    overlayId: "import-browse-filter",
    isOpen: filterMenuOpen && canFilter && activeTab === "browse",
    onClose: handleFilterMenuClose,
  });

  useOverlayBackHandler({
    overlayId: "import-scan-format-filter",
    isOpen: formatMenuOpen && activeTab === "scan" && !scanLoading,
    onClose: handleFormatMenuClose,
  });

  const completeScan = (results: FileEntry[]) => {
    if (scanTimerRef.current) {
      clearInterval(scanTimerRef.current);
      scanTimerRef.current = null;
    }
    setScanLoading(false);
    setDrawerOpen(false);
    const mapped: ScanResultItem[] = results
      .filter(it => {
        const fmt = getBookFormat(it.path);
        // 如果格式无法识别或在选中格式列表中，则保留
        // 这里更严格一点：只保留明确识别且在列表中的
        return fmt && scanFormats.includes(fmt);
      })
      .map((it) => ({
        ...it,
        type: "file" as const,
        imported: importedPaths.has(it.path),
      }));
    setScanList(mapped);
    // foundPdfCount 已经在 startScan 中更新，这里不需要再次设置
    setActiveTab("scan");
   // 跳转到结果页并传递数据
    const currentState = nav.location.state as any;
    nav.toImportResults({ 
      results: mapped, 
      fromTab: currentState?.fromTab,
      fromMenu: currentState?.fromMenu 
    });
  };

  const startSafScan = async () => {
    try {
      const bridge = (window as any).SafBridge;
      if (!bridge) {
        alert(t('scanFailed'));
        return;
      }
      setActiveTab("scan");
      setScanLoading(true);
      setDrawerOpen(true);
      setScannedCount(0);
      setFoundPdfCount(0);
      scannedCountRef.current = 0;
      foundPdfCountRef.current = 0;
      scanCancelledRef.current = false;

      const onTreeSelected = (uriStr: string) => {
        delete (window as any).__onSafTreeSelected__;
        if (!uriStr) {
          setScanLoading(false);
          setDrawerOpen(false);
          alert(t('scanFailed'));
          return;
        }
        (window as any).__onSafScanResult__ = (json: string) => {
          delete (window as any).__onSafScanResult__;
          try {
            const arr = JSON.parse(json || "[]") as any[];
            const results: FileEntry[] = arr
              .map((it) => ({
                name: String(it?.name || ''),
                path: String(it?.path || ''),
                type: 'file' as const,
                size: typeof it?.size === 'number' ? it.size : undefined,
                mtime: typeof it?.mtime === 'number' ? it.mtime : undefined,
              }))
              .filter((it) => {
                // 以文件名作为扩展名判断，避免 content:// 路径没有扩展名
                const fmt = getBookFormat(it.name);
                return isSupportedFile(it.name) && fmt && scanFormats.includes(fmt);
              });
            setFoundPdfCount(results.length);
            completeScan(results);
          } catch (e) {
            setScanLoading(false);
            setDrawerOpen(false);
            alert(t('scanFailed'));
          }
        };
        bridge.scanTree(uriStr);
      };

      (window as any).__onSafTreeSelected__ = onTreeSelected;
      bridge.openDocumentTree();
    } catch (e) {
      setScanLoading(false);
      setDrawerOpen(false);
      alert(t('scanFailed'));
    }
  };

  const startScan = async () => {
    const readable = await checkStoragePermissionUtil();
    if (!readable) {
      setActiveTab("browse");
      alert(t('scanFailed'));
      return;
    }
    setActiveTab("scan");
    setScanLoading(true);
    setDrawerOpen(true);
    setScannedCount(0);
    setFoundPdfCount(0);
    scannedCountRef.current = 0;
    foundPdfCountRef.current = 0;
    scanCancelledRef.current = false;

    try {
      // 执行真实扫描，带进度回调，传递格式筛选
      const results = await fileSystemService.scanBookFiles(
        undefined,
        scanFormats,
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
      const msg =
        typeof error?.message === "string" ? error.message : String(error);
      alert(`${t('scanFailed')}\n\n${msg}`);
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
      await logError('取消扫描失败', { error: String(e) });
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
    if (selectedPaths.length === 0) {
      alert(t('selectFilesToImport'));
      return;
    }
    openGroupingWithPaths(selectedPaths);
  };

  const goInto = (entry: FileEntry) => {
    if (entry.type !== "dir") return;
    setSearchParams({ tab: "browse", path: entry.path });
  };

  // 目录返回通过面包屑点击实现，无需单独函数

  const goToDepth = useCallback(async (idx: number) => {
    if (idx < 0 || idx >= browseStack.length) return;
    setBrowseLoading(true);
    try {
      // 如果返回到根目录，重新加载根目录
      if (idx === 0) {
        const roots = await fileSystemService.getRootDirectories();
        setBrowseStack([roots]);
        setBrowseDirStack([{ name: t('storageDevices'), path: "" }]);
      } else {
        // 否则直接截取栈
        setBrowseStack((stack) => stack.slice(0, idx + 1));
        setBrowseDirStack((stack) => stack.slice(0, idx + 1));
      }
    } catch (error: any) {
      await logError('导航失败', { error: String(error) });
    } finally {
      setBrowseLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browseStack.length]);

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
            await logError('读取目录失败', { error: String(error) });
          } finally {
            setBrowseLoading(false);
          }
        };
        loadDir();
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, browseDirStack, browseStack]);

  const Header: React.FC = () => {
    const browseCandidates = currentBrowse
      .filter(
        (it) =>
          it.type === "file" &&
          isSupportedFile(it.path) &&
          !importedPaths.has(it.path)
      )
      .map((it) => it.path);
    const scanCandidates = filteredScan
      .filter((it) => !it.imported)
      .map((it) => it.path);
    const candidates =
      activeTab === "browse" ? browseCandidates : scanCandidates;

    const { canSelectAll, strokeColor, toggleSelectAll } = useSelectAll({
      selected: selectedPaths,
      setSelected: setSelectedPaths,
      candidates,
    });

    const rightContent =
      activeTab === "browse" ||
      (activeTab === "scan" && filteredScan.length > 0) ? (
      <div style={{ display: "flex", alignItems: "center" }}>
          <FormatFilterButton
            mode="multi"
            filterFormats={filterFormats}
            menuOpen={filterMenuOpen}
            onMenuOpenChange={(open) => {
              if (!canFilter && open) return;
              setFilterMenuOpen(open);
            }}
            onFormatsChange={updateFilterFormats}
            canFilter={canFilter}
          />

        {activeTab === "browse" && (
          <button
            aria-label={tc('search')}
            title={tc('search')}
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
        {activeTab === "scan" && filteredScan.length === 0 && !scanLoading && (
          <button
            aria-label={t('chooseDirectoryScan')}
            title={t('chooseDirectoryScan')}
            style={{
              background: "none",
              border: "none",
              boxShadow: "none",
              borderRadius: 0,
              cursor: "pointer",
              padding: 0,
              marginRight: 16,
              color: "#333",
              fontSize: 13,
            }}
            onClick={() => startSafScan()}
          >
            {t('chooseDirectoryScan')}
          </button>
        )}
        <button
          aria-label={tc('selectAll')}
          title={tc('selectAll')}
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
    ) : undefined;

    // 返回按钮回调
    const handleBack = () => {
      // 先关闭筛选菜单，避免遮罩层阻挡导航
      setFilterMenuOpen(false);
      setFormatMenuOpen(false);
      
      const state: any = nav.location.state || {};
      // 直接退出导入页面，不再逐级返回
      if (state.fromTab === "all") nav.toBookshelf('all');
      else nav.toBookshelf('recent');
    };

    return (
      <PageHeader
        title={scanList.length > 0 ? t('scanResult', { count: scanList.length }) : t('importFiles')}
        onBack={handleBack}
        rightContent={
          <div style={{ display: 'flex', alignItems: 'center' }}>
            {activeTab === 'scan' && (
              <ScanFormatSelector
                selectedFormats={scanFormats}
                onFormatsChange={setScanFormats}
                disabled={scanLoading}
                menuOpen={formatMenuOpen}
                onMenuOpenChange={setFormatMenuOpen}
              />
            )}
            {rightContent}
          </div>
        }
        style={{ padding: '0 12px' }}
      />
    );
  };


const Tabs: React.FC = () => {
    const handleTabChange = (key: TabKey) => {
      // 切换到"自动扫描"tab时，清空浏览目录的路径栈
      if (key === "scan" && activeTab === "browse") {
        // 计算进入了多少层目录（browseDirStack 第一层是根目录，不算）
        const depth = browseDirStack.length - 1;
        setBrowseStack([]);
        setBrowseDirStack([]);
        // 回退历史记录栈中进入目录时添加的记录
        if (depth > 0) {
          nav.go(-depth);
        }
      }
      setActiveTab(key);
    };

    return (
    <div style={{ display: "flex", padding: "8px 0 0 0" }}>
      {(["scan", "browse"] as TabKey[]).map((key) => (
        <button
          key={key}
          onClick={() => handleTabChange(key)}
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
            {key === "scan" ? t('autoScan') : t('browseAll')}
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
  };

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
                  // 计算需要回退的层数（当前层数 - 目标层数）
                  const backSteps = browseDirStack.length - 1 - idx;
                  if (backSteps > 0) {
                    nav.go(-backSteps);
                  }
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
                {tc('items', { count: entry.children_count || 0 })} · {fmtDate(entry.mtime)}
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
            placeholder={t('searchDeviceBooks')}
            autoFocus
            autoFocusDelay={50}
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
          <Loading
            visible
            overlay={false}
            text={tc('loading')}
            showSpinner={false}
            style={{ height: '100%' }}
            textStyle={{ color: '#999' }}
          />
          ) : (
            <BrowseList />
          )}
        </div>

      {!(activeTab === "browse" && browseLoading && browseStack.length === 0) && (
        <ImportBottomBar
          label={
            activeTab === "scan" &&
            scanList.length === 0 &&
            globalSearch.trim() === "" &&
            !scanLoading
              ? scanLoading
                ? t('scanning')
                : t('startScan')
              : t('importCount', { count: selectedPaths.length })
          }
          disabled={scanLoading}
          onClick={() => {
            if (
              activeTab === "scan" &&
              scanList.length === 0 &&
              globalSearch.trim() === "" &&
              !scanLoading
            ) {
              setFormatMenuOpen(false);
              if (!scanLoading) startScan();
            } else {
              handleImportClick();
            }
          }}
        />
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
              {t('scannedFiles', { count: scannedCount })}
            </div>
            <div
              style={{
                textAlign: "center",
                color: "#666",
                fontSize: 14,
                marginTop: 6,
              }}
            >
              {t('foundBooks', { count: foundPdfCount })}
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
                {t('stopScan')}
              </button>
            </div>
          </div>
        </div>
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
};


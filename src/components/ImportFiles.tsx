import React, { useMemo, useRef, useState } from "react";
import { FileRow } from "./FileRow";
import { useNavigate, useLocation } from "react-router-dom";
import { IBook } from "../types";

type TabKey = "scan" | "browse";

export interface FileEntry {
  type: "file" | "dir";
  name: string;
  path: string;
  size?: number; // bytes
  mtime?: number; // epoch ms
  childrenCount?: number; // for dir
}

export interface ScanResultItem extends FileEntry {
  imported?: boolean;
  type: "file";
}

// 轻量mock：后续将由 Tauri 命令替换
const mockScanResults: ScanResultItem[] = [
  {
    type: "file",
    name: "AI研究综述.pdf",
    path: "/storage/docs/AI研究综述.pdf",
    size: 1343488,
    mtime: Date.now() - 86400000,
    imported: false,
  },
  {
    type: "file",
    name: "操作系统笔记.pdf",
    path: "/storage/docs/操作系统笔记.pdf",
    size: 2893120,
    mtime: Date.now() - 3600 * 1000 * 24 * 18,
    imported: true,
  },
  {
    type: "file",
    name: "算法导论精选.pdf",
    path: "/storage/books/算法导论精选.pdf",
    size: 4233216,
    mtime: Date.now() - 3600 * 1000 * 24 * 36,
    imported: false,
  },
];

const mockRootDirs: FileEntry[] = [
  {
    type: "dir",
    name: "Download",
    path: "/storage/Download",
    childrenCount: 42,
    mtime: Date.now() - 3600 * 1000 * 2,
  },
  {
    type: "dir",
    name: "Documents",
    path: "/storage/Documents",
    childrenCount: 18,
    mtime: Date.now() - 3600 * 1000 * 24 * 2,
  },
  {
    type: "dir",
    name: "Pictures",
    path: "/storage/Pictures",
    childrenCount: 210,
    mtime: Date.now() - 3600 * 1000 * 5,
  },
];

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

export const ImportFiles: React.FC<{ importedBooks?: IBook[] }> = ({
  importedBooks = [],
}) => {
  const navigate = useNavigate();
  const location = useLocation();
  const initialTab = (location.state as any)?.initialTab as TabKey | undefined;
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
  // 顶部共享搜索（两个栏目共用）
  const [globalSearch, setGlobalSearch] = useState("");
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);

  const [browseStack, setBrowseStack] = useState<FileEntry[][]>([mockRootDirs]);
  // 面包屑路径栈：与 browseStack 同步，索引 0 为根
  const [browseDirStack, setBrowseDirStack] = useState<
    { name: string; path: string }[]
  >([{ name: "存储设备", path: "/" }]);
  const [browseSearch, setBrowseSearch] = useState("");
  const ROW_HEIGHT = 60; // 统一行高，复用 FileRow 的布局

  const importedPaths = useMemo(
    () => new Set(importedBooks.map((b) => b.file_path)),
    [importedBooks]
  );

  const filteredScan = useMemo(() => {
    const keyword = globalSearch.trim().toLowerCase();
    return (scanList.length ? scanList : mockScanResults).filter((it) =>
      it.name.toLowerCase().includes(keyword)
    );
  }, [scanList, globalSearch]);

  const currentBrowse = browseStack[browseStack.length - 1];
  const devicePdfIndex = useMemo(() => {
    // 简易设备索引：聚合已访问目录中的 PDF 文件
    const files: FileEntry[] = [];
    for (const level of browseStack) {
      for (const it of level) {
        if (it.type === "file" && it.path.toLowerCase().endsWith(".pdf")) {
          files.push(it);
        }
      }
    }
    return files;
  }, [browseStack]);

  const filteredBrowse = useMemo(() => {
    const kw = browseSearch.trim().toLowerCase();
    if (kw) {
      return devicePdfIndex.filter((it) => it.name.toLowerCase().includes(kw));
    }
    return currentBrowse;
  }, [currentBrowse, browseSearch, devicePdfIndex]);

  const completeScan = () => {
    if (scanTimerRef.current) {
      clearInterval(scanTimerRef.current);
      scanTimerRef.current = null;
    }
    setScanLoading(false);
    setDrawerOpen(false);
    const mapped = mockScanResults.map((it) => ({
      ...it,
      imported: importedPaths.has(it.path) || it.imported,
    }));
    setScanList(mapped);
    setFoundPdfCount(mockScanResults.length);
    setActiveTab("scan");
    // 跳转到结果页并传递数据
    navigate("/import/results", { state: { results: mapped } });
  };

  const startScan = () => {
    // 打开抽屉并模拟扫描过程
    setActiveTab("scan");
    setScanLoading(true);
    setDrawerOpen(true);
    setScannedCount(0);
    setFoundPdfCount(0);
    scannedCountRef.current = 0;
    foundPdfCountRef.current = 0;

    const targetScan = 982; // 演示数据，后续用真实值替换
    const targetPdf = mockScanResults.length; // 以实际扫描到的 pdf 数量为准
    scanTimerRef.current = window.setInterval(() => {
      const nextScan = Math.min(
        scannedCountRef.current + Math.floor(Math.random() * 35 + 20),
        targetScan
      );
      const nextPdf = Math.min(
        foundPdfCountRef.current + Math.floor(Math.random() * 2 + 1),
        targetPdf
      );
      scannedCountRef.current = nextScan;
      foundPdfCountRef.current = nextPdf;
      setScannedCount(nextScan);
      setFoundPdfCount(nextPdf);
      // 完成条件：扫描到目标 & 找到的 pdf 数达到目标
      if (nextScan >= targetScan && nextPdf >= targetPdf) {
        completeScan();
      }
    }, 120);
  };

  const toggleSelect = (path: string) => {
    setSelectedPaths((prev) =>
      prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path]
    );
  };

  const goInto = (entry: FileEntry) => {
    if (entry.type !== "dir") return;
    // 后续这里将从文件服务获取目录内容
    const mockChildren: FileEntry[] = [
      {
        type: "dir",
        name: "子目录A",
        path: `${entry.path}/A`,
        childrenCount: 3,
        mtime: Date.now() - 3600 * 1000 * 3,
      },
      {
        type: "file",
        name: "阅读手册.pdf",
        path: `${entry.path}/阅读手册.pdf`,
        size: 1034212,
        mtime: Date.now() - 3600 * 1000 * 6,
      },
      {
        type: "file",
        name: "课程讲义.pdf",
        path: `${entry.path}/课程讲义.pdf`,
        size: 2948321,
        mtime: Date.now() - 3600 * 1000 * 28,
      },
    ];
    setBrowseStack((stack) => [...stack, mockChildren]);
    setBrowseDirStack((stack) => [
      ...stack,
      { name: entry.name, path: entry.path },
    ]);
  };

  const goBack = () => {
    setBrowseStack((stack) =>
      stack.length > 1 ? stack.slice(0, stack.length - 1) : stack
    );
    setBrowseDirStack((stack) =>
      stack.length > 1 ? stack.slice(0, stack.length - 1) : stack
    );
  };

  const goToDepth = (idx: number) => {
    if (idx < 0 || idx >= browseStack.length) return;
    setBrowseStack((stack) => stack.slice(0, idx + 1));
    setBrowseDirStack((stack) => stack.slice(0, idx + 1));
  };

  const Header: React.FC = () => {
    const canSelectAll = currentBrowse.some(
      (it) => it.type === "file" && it.path.toLowerCase().endsWith(".pdf")
    );
    return (
      <div
        style={{ display: "flex", alignItems: "center", padding: "12px 12px" }}
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
          {scanList.length > 0 ? `扫描结果(${scanList.length})` : "导入文件"}
        </span>
        <div style={{ flex: 1 }} />
        {activeTab === "browse" && (
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
              onClick={() => setSearchOpen((v) => !v)}
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
            {/* 全选：仅当前目录存在 PDF 时可用，范围仅限当前目录的 PDF */}
            <button
              aria-label="全选"
              title="全选"
              style={{
                background: "none",
                border: "none",
                boxShadow: "none",
                borderRadius: 0,
                cursor: canSelectAll ? "pointer" : "not-allowed",
                opacity: canSelectAll ? 1 : 0.45,
                padding: 0,
              }}
              disabled={!canSelectAll}
              onClick={() => {
                const candidates = currentBrowse
                  .filter(
                    (it) =>
                      it.type === "file" &&
                      it.path.toLowerCase().endsWith(".pdf")
                  )
                  .map((it) => it.path);
                if (candidates.length === 0) return; // 不存在 PDF，禁用
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
                  stroke={canSelectAll ? "#333" : "#bbb"}
                  strokeWidth="2"
                />
                <rect
                  x="14"
                  y="3"
                  width="7"
                  height="7"
                  stroke={canSelectAll ? "#333" : "#bbb"}
                  strokeWidth="2"
                />
                <rect
                  x="3"
                  y="14"
                  width="7"
                  height="7"
                  stroke={canSelectAll ? "#333" : "#bbb"}
                  strokeWidth="2"
                />
                <rect
                  x="14"
                  y="14"
                  width="7"
                  height="7"
                  stroke={canSelectAll ? "#333" : "#bbb"}
                  strokeWidth="2"
                />
                <path
                  d="M6 8l2-2"
                  stroke={canSelectAll ? "#333" : "#bbb"}
                  strokeWidth="2"
                  strokeLinecap="round"
                />
                <path
                  d="M17 19l2-2"
                  stroke={canSelectAll ? "#333" : "#bbb"}
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>
        )}
      </div>
    );
  };

  // 顶部搜索样式：参考书架页面的图1设计
  const SearchOverlay: React.FC = () =>
    activeTab === "browse" && searchOpen ? (
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
            value={browseSearch}
            onChange={(e) => setBrowseSearch(e.target.value)}
            placeholder="搜索设备内书籍文件…"
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
          {browseSearch && (
            <button
              onClick={() => setBrowseSearch("")}
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
    ) : null;

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
        height: "calc(100vh - 160px)",
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
      <div
        role="button"
        aria-disabled={scanLoading}
        onClick={() => {
          if (!scanLoading) startScan();
        }}
        style={{
          position: "fixed",
          bottom: 0,
          left: 0,
          right: 0,
          padding: "10px 16px",
          background: "#d23c3c",
          color: "#fff",
          textAlign: "center",
          cursor: scanLoading ? "default" : "pointer",
          userSelect: "none",
        }}
      >
        <span style={{ fontSize: 14, letterSpacing: 1 }}>
          {scanLoading ? "正在扫描…" : "立即扫描"}
        </span>
      </div>
    </div>
  );

  const ScanList: React.FC = () => (
    <div style={{ padding: "8px 12px 56px 12px" }}>
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
          justifyContent: "space-between",
        }}
      >
        <div>导入（{selectedPaths.length}）</div>
        <button
          style={{
            background: "transparent",
            border: "none",
            color: "#fff",
            cursor: "pointer",
          }}
        >
          下一步
        </button>
      </div>
    </div>
  );

  const BrowseList: React.FC = () => (
    <div style={{ padding: "8px 12px 56px 12px" }}>
      {/* 面包屑路径：支持点击退回任意层级 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          color: "#666",
          fontSize: 13,
          padding: "0 4px 8px 4px",
        }}
      >
        {browseDirStack.map((seg, idx) => (
          <React.Fragment key={seg.path + idx}>
            <button
              onClick={() => goToDepth(idx)}
              style={{
                background: "none",
                border: "none",
                boxShadow: "none",
                borderRadius: 0,
                cursor:
                  idx === browseDirStack.length - 1 ? "default" : "pointer",
                color: idx === browseDirStack.length - 1 ? "#999" : "#555",
                padding: 0,
              }}
              title={seg.path}
            >
              {seg.name}
            </button>
            {idx < browseDirStack.length - 1 && (
              <span style={{ color: "#999" }}>›</span>
            )}
          </React.Fragment>
        ))}
      </div>
      {filteredBrowse.map((entry) =>
        entry.type === "dir" ? (
          <div
            key={entry.path}
            onClick={() => goInto(entry)}
            style={{
              display: "flex",
              alignItems: "center",
              height: ROW_HEIGHT,
              padding: "0 4px",
              borderBottom: "1px solid #f0f0f0",
              cursor: "pointer",
            }}
          >
            {(() => {
              const iconSize = Math.round(ROW_HEIGHT * 0.7);
              return (
                <svg
                  width={iconSize}
                  height={iconSize}
                  viewBox="0 0 24 24"
                  fill="#f29b00"
                  style={{ marginRight: 10 }}
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
                {`${entry.childrenCount || 0}项`} · {fmtDate(entry.mtime)}
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
      <div
        style={{
          position: "fixed",
          bottom: 0,
          left: 0,
          right: 0,
          padding: "10px 16px",
          background: "#d23c3c",
          color: "#fff",
          textAlign: "center",
        }}
      >
        导入（{selectedPaths.length}）
      </div>
    </div>
  );

  return (
    <div
      className="import-page"
      style={{
        height: "100vh",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {searchOpen && activeTab === "browse" ? (
        <SearchOverlay />
      ) : (
        <>
          <Header />
          <Tabs />
        </>
      )}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {activeTab === "scan" ? (
          scanList.length === 0 && globalSearch.trim() === "" ? (
            <ScanEmpty />
          ) : (
            <ScanList />
          )
        ) : (
          <BrowseList />
        )}
      </div>
      {drawerOpen && (
        <div
          aria-live="polite"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.35)",
            display: "flex",
            alignItems: "flex-end",
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
              padding: "18px 16px 24px 16px",
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
              找到：PDF({foundPdfCount})
            </div>
            <div style={{ marginTop: 18 }}>
              <button
                className="drawer-stop"
                onClick={completeScan}
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

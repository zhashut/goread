import React, { useState, useRef, useCallback } from "react";
import { useTranslation } from 'react-i18next';
import { TocNode } from "./types";
import { IBookmark } from "../../types";
import { getSafeAreaInsets } from "../../utils/layout";
import { getBookmarkTargetPage } from "./utils/bookmarkPosition";
import { TocSortMode } from "./hooks/useTocSort";

interface TocOverlayProps {
  visible: boolean;
  toc: TocNode[];
  sortedToc: TocNode[];
  bookmarks: IBookmark[];
  activeSignature?: string | undefined;
  sortMode: TocSortMode;
  isReversed: boolean;
  onClose: () => void;
  onGoToPage: (page: number | undefined, anchor?: string) => void;
  onDeleteBookmark: (id: number) => void;
  setToc: (toc: TocNode[]) => void;
  onSortModeChange: (mode: TocSortMode) => void;
  onToggleReverse: () => void;
}

export const TocOverlay: React.FC<TocOverlayProps> = ({
  visible,
  toc,
  sortedToc,
  bookmarks,
  activeSignature,
  sortMode,
  isReversed,
  onClose,
  onGoToPage,
  onDeleteBookmark,
  setToc,
  onSortModeChange,
  onToggleReverse,
}) => {
  const { t } = useTranslation('reader');
  const [leftTab, setLeftTab] = useState<"toc" | "bookmark">("toc");
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const sortActionRef = useRef<HTMLDivElement>(null);
  const tocItemRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const prevVisibleRef = useRef(false);

  // 覆盖层打开时重置为目录标签（从 false 变为 true）
  React.useEffect(() => {
    if (visible && !prevVisibleRef.current) {
      setLeftTab("toc");
      setSortMenuOpen(false);
    }
    prevVisibleRef.current = visible;
  }, [visible]);

  // 点击排序菜单外部区域时关闭菜单
  const handleSortMenuOutsideClick = useCallback((e: React.MouseEvent) => {
    if (sortActionRef.current && !sortActionRef.current.contains(e.target as Node)) {
      setSortMenuOpen(false);
    }
  }, []);

  // 排序方式是否处于非默认状态（用于图标高亮）
  const isSortActive = sortMode !== 'default' || isReversed;

  // 自动滚动到当前章节
  React.useEffect(() => {
    if (visible && activeSignature) {
      setTimeout(() => {
        const el = tocItemRefs.current.get(activeSignature);
        const container = scrollContainerRef.current;
        if (el && container) {
          const top = el.offsetTop;
          const containerHeight = container.clientHeight;
          const elHeight = el.offsetHeight;
          container.scrollTo({
            top: top - containerHeight / 2 + elHeight / 2,
            behavior: "auto",
          });
        }
      }, 100);
    }
  }, [visible, activeSignature]);

  // 通过 signature 匹配更新原始 toc 中节点的展开状态
  const toggleNodeExpanded = useCallback((targetSig: string) => {
    const toggle = (nodes: TocNode[], level: number): TocNode[] => {
      return nodes.map(n => {
        const nSig = `${n.title}|${typeof n.page === "number" ? n.page : -1}|${level}`;
        const children = n.children ? toggle(n.children, level + 1) : undefined;
        if (nSig === targetSig) {
          return { ...n, expanded: !n.expanded, children };
        }
        return children !== n.children ? { ...n, children } : n;
      });
    };
    setToc(toggle(toc, 0));
  }, [toc, setToc]);

  // 渲染目录树使用排序后的数据展示，但展开/折叠操作仍作用于原始 toc
  const renderTocTree = (nodes: TocNode[], level: number): React.ReactNode => {
    const indent = 10 + level * 14;
    return nodes.map((node, idx) => {
      const hasChildren = !!(node.children && node.children.length);
      const caret = hasChildren ? (node.expanded ? "▼" : "▶") : "•";
      const sig = `${node.title}|${typeof node.page === "number" ? node.page : -1}|${level}`;
      const isActive = activeSignature === sig;
      return (
        <div key={`${level}-${idx}`} style={{ marginLeft: indent }}>
          <div
            ref={(el) => {
              if (el) {
                tocItemRefs.current.set(sig, el as HTMLDivElement);
              }
            }}
            style={{
              padding: "8px",
              borderRadius: "6px",
              cursor: "default",
              backgroundColor: isActive ? "#333" : "transparent",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = isActive
                ? "#333"
                : "#2a2a2a";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = isActive
                ? "#333"
                : "transparent";
            }}
          >
            <span
              onClick={(e) => {
                e.stopPropagation();
                if (hasChildren) {
                  toggleNodeExpanded(sig);
                }
              }}
              style={{
                marginRight: 12,
                fontSize: "11px",
                lineHeight: "1",
                color: "#ffffff",
                opacity: 0.7,
                cursor: hasChildren ? "pointer" : "default",
              }}
            >
              {caret}
            </span>
            <span
              onClick={(e) => {
                e.stopPropagation();
                // 支持页码跳转和锚点跳转（Markdown 等格式）
                if (typeof node.page === "number" || node.anchor) {
                  onGoToPage(node.page, node.anchor);
                }
              }}
              style={{
                fontSize: "13px",
                color: isActive ? "#d15158" : "#ffffff",
                cursor: (typeof node.page === "number" || node.anchor) ? "pointer" : "default",
              }}
            >
              {node.title}
            </span>
            {typeof node.page === "number" && !node.anchor && (
              <span style={{ fontSize: "12px", opacity: 0.7, marginLeft: 6 }}>
                {t('page', { page: node.page })}
              </span>
            )}
          </div>
          {hasChildren &&
            node.expanded &&
            renderTocTree(node.children!, level + 1)}
        </div>
      );
    });
  };

  // 自动展开当前章节路径，仅在弹层打开时执行
  React.useEffect(() => {
    if (!visible) return;
    if (!activeSignature) return;

    // 解析 signature 获取目标信息，或者直接通过 signature 匹配节点路径
    const findPath = (nodes: TocNode[], level: number, path: TocNode[]): TocNode[] | null => {
      for (const n of nodes) {
        const currentSig = `${n.title}|${typeof n.page === "number" ? n.page : -1}|${level}`;
        const nextPath = [...path, n];
        
        if (currentSig === activeSignature) {
            return nextPath;
        }

        if (n.children && n.children.length) {
          const childResult = findPath(n.children, level + 1, nextPath);
          if (childResult) return childResult;
        }
      }
      return null;
    };

    const path = findPath(toc, 0, []);
    if (!path) return;

    // 根据路径展开父链，其余保持当前状态
    const expandAlongPath = (nodes: TocNode[], level: number): TocNode[] => {
      return nodes.map((n) => {
        const inPath = path.includes(n);
        const children = n.children ? expandAlongPath(n.children, level + 1) : undefined;
        return {
          ...n,
          expanded: inPath ? true : n.expanded || false,
          children,
        };
      });
    };
    setToc(expandAlongPath(toc, 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, activeSignature]);

  if (!visible) return null;

  return (
    <div
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "stretch",
        justifyContent: "flex-start",
        overflow: "hidden",
        zIndex: 20,
      }}
    >
      <div
        onClick={(e) => {
          e.stopPropagation();
          handleSortMenuOutsideClick(e);
        }}
        style={{
          width: "75%",
          height: "100%",
          backgroundColor: "#1f1f1f",
          color: "#fff",
          borderRadius: "0 10px 10px 0",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
          overflow: "hidden",
        }}
      >
        {/* 顶部页签：目录 / 书签 + 排序按钮 */}
          <div
            style={{
              padding: `calc(${getSafeAreaInsets().top} + 16px) 16px 0 16px`,
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: "12px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center" }}>
              <button
                onClick={() => setLeftTab("toc")}
                style={{
                  background: "none",
                  border: "none",
                  color: leftTab === "toc" ? "#d15158" : "#fff",
                  cursor: "pointer",
                  fontSize: "14px",
                  padding: "4px 6px",
                  borderBottom:
                    leftTab === "toc"
                      ? "2px solid #d15158"
                      : "2px solid transparent",
                  marginRight: "16px",
                }}
              >
                <span style={{ marginRight: "6px" }}>≡</span>
                <span>{t('toc')}</span>
              </button>
              <button
                onClick={() => setLeftTab("bookmark")}
                style={{
                  background: "none",
                  border: "none",
                  color: leftTab === "bookmark" ? "#d15158" : "#fff",
                  cursor: "pointer",
                  fontSize: "14px",
                  padding: "4px 6px",
                  borderBottom:
                    leftTab === "bookmark"
                      ? "2px solid #d15158"
                      : "2px solid transparent",
                }}
              >
                <span style={{ marginRight: "6px" }}>🔖</span>
                <span>{t('bookmark')}</span>
              </button>
            </div>

            {/* 排序按钮（仅在目录 Tab 下显示） */}
            {leftTab === "toc" && (
              <div ref={sortActionRef} style={{ position: "relative" }}>
                <div
                  onClick={() => setSortMenuOpen(v => !v)}
                  style={{
                    width: 32,
                    height: 32,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: "50%",
                    cursor: "pointer",
                    color: isSortActive || sortMenuOpen ? "#d15158" : "#999",
                    transition: "color 0.2s",
                  }}
                >
                  <svg width={20} height={20} viewBox="0 0 24 24" fill="currentColor">
                    <path d="M3 18h6v-2H3v2zM3 6v2h18V6H3zm0 7h12v-2H3v2z" />
                  </svg>
                </div>

                {/* 排序下拉菜单 */}
                <div
                  style={{
                    position: "absolute",
                    top: 40,
                    right: 0,
                    width: 160,
                    backgroundColor: "#2c2c2c",
                    borderRadius: 8,
                    boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
                    padding: "6px 0",
                    opacity: sortMenuOpen ? 1 : 0,
                    transform: sortMenuOpen ? "translateY(0)" : "translateY(-10px)",
                    pointerEvents: sortMenuOpen ? "auto" : "none",
                    transition: "all 0.2s ease",
                    border: "1px solid #3d3d3d",
                    zIndex: 30,
                  }}
                >
                  {/* 默认排序 */}
                  <div
                    onClick={() => {
                      onSortModeChange('default');
                      setTimeout(() => setSortMenuOpen(false), 150);
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "10px 16px",
                      fontSize: 14,
                      color: sortMode === 'default' ? "#d15158" : "#ccc",
                      cursor: "pointer",
                    }}
                  >
                    <span>{t('sortDefault')}</span>
                    {sortMode === 'default' && (
                      <svg width={14} height={14} viewBox="0 0 24 24" fill="#d15158">
                        <path d="M9 16.17L4.83 12l-1.41 1.41L9 19 21 7l-1.41-1.41z" />
                      </svg>
                    )}
                  </div>

                  {/* 按名称排序 */}
                  <div
                    onClick={() => {
                      onSortModeChange('name');
                      setTimeout(() => setSortMenuOpen(false), 150);
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "10px 16px",
                      fontSize: 14,
                      color: sortMode === 'name' ? "#d15158" : "#ccc",
                      cursor: "pointer",
                    }}
                  >
                    <span>{t('sortByName')}</span>
                    {sortMode === 'name' && (
                      <svg width={14} height={14} viewBox="0 0 24 24" fill="#d15158">
                        <path d="M9 16.17L4.83 12l-1.41 1.41L9 19 21 7l-1.41-1.41z" />
                      </svg>
                    )}
                  </div>

                  {/* 分割线 */}
                  <div style={{ height: 1, backgroundColor: "#3d3d3d", margin: "4px 0" }} />

                  {/* 倒序排列开关 */}
                  <div
                    onClick={onToggleReverse}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "10px 16px",
                      fontSize: 14,
                      color: "#ccc",
                      cursor: "pointer",
                    }}
                  >
                    <span>{t('sortReverse')}</span>
                    <div
                      style={{
                        width: 36,
                        height: 20,
                        backgroundColor: isReversed ? "#d15158" : "#555",
                        borderRadius: 10,
                        position: "relative",
                        transition: "background 0.3s",
                      }}
                    >
                      <div
                        style={{
                          position: "absolute",
                          top: 2,
                          left: isReversed ? 18 : 2,
                          width: 16,
                          height: 16,
                          backgroundColor: "#fff",
                          borderRadius: "50%",
                          transition: "left 0.3s",
                        }}
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

        {/* 内容区：目录或书签列表（可滚动） */}
        <div
          ref={scrollContainerRef}
          className="no-scrollbar"
          style={{
            flex: 1,
            overflowY: "auto",
            padding: `0 16px calc(16px + ${getSafeAreaInsets().bottom}) 16px`,
            position: "relative",
          }}
        >
          {leftTab === "toc" ? (
            sortedToc.length === 0 ? (
              <div style={{ fontSize: "13px", opacity: 0.6 }}>
                {t('noToc')}
              </div>
            ) : (
              <div>{renderTocTree(sortedToc, 0)}</div>
            )
          ) : bookmarks.length === 0 ? (
            <div
              style={{
                fontSize: "13px",
                opacity: 0.6,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                height: "100%",
              }}
            >
              {t('noBookmarks')}
            </div>
          ) : (
            <div>
              {bookmarks.map((bm) => (
                <div
                  key={bm.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "6px 8px",
                    borderRadius: "6px",
                    cursor: "pointer",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = "#2a2a2a";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = "transparent";
                  }}
                  onClick={() => {
                    onGoToPage(getBookmarkTargetPage(bm));
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                    }}
                  >
                    <span style={{ fontSize: "13px", color: "#fff", marginRight: "8px" }}>
                      {bm.title}
                    </span>
                    <span style={{ fontSize: "12px", opacity: 0.7 }}>
                      {t('page', { page: bm.page_number })}
                    </span>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteBookmark(bm.id);
                    }}
                    style={{
                      background: "none",
                      border: "none",
                      color: "#ccc",
                      cursor: "pointer",
                      fontSize: "12px",
                    }}
                    title={t('deleteBookmark')}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

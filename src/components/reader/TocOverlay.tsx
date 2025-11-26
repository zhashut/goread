import React, { useState, useRef } from "react";
import { TocNode } from "./types";
import { IBookmark } from "../../types";

interface TocOverlayProps {
  visible: boolean;
  toc: TocNode[];
  bookmarks: IBookmark[];
  currentChapterPage: number | undefined;
  currentChapterLevel?: number | undefined;
  onClose: () => void;
  onGoToPage: (page: number) => void;
  onDeleteBookmark: (id: number) => void;
  setToc: (toc: TocNode[]) => void; // 用于展开/折叠
}

export const TocOverlay: React.FC<TocOverlayProps> = ({
  visible,
  toc,
  bookmarks,
  currentChapterPage,
  currentChapterLevel,
  onClose,
  onGoToPage,
  onDeleteBookmark,
  setToc,
}) => {
  const [leftTab, setLeftTab] = useState<"toc" | "bookmark">("toc");
  const tocItemRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [activeSig, setActiveSig] = useState<string | undefined>(undefined);

  // 自动滚动到当前章节
  React.useEffect(() => {
    if (visible && activeSig) {
      setTimeout(() => {
        const el = tocItemRefs.current.get(activeSig);
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
  }, [visible, activeSig]);

  const renderTocTree = (nodes: TocNode[], level: number): React.ReactNode => {
    const indent = 10 + level * 14;
    return nodes.map((node, idx) => {
      const hasChildren = !!(node.children && node.children.length);
      const caret = hasChildren ? (node.expanded ? "▼" : "▶") : "•";
      const sig = `${node.title}|${typeof node.page === "number" ? node.page : -1}|${level}`;
      const isActive = activeSig === sig;
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
                  node.expanded = !node.expanded;
                  setToc([...toc]);
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
                if (typeof node.page === "number") {
                  onGoToPage(node.page);
                }
              }}
              style={{
                fontSize: "13px",
                color: isActive ? "#d15158" : "#ffffff",
                cursor: typeof node.page === "number" ? "pointer" : "default",
              }}
            >
              {node.title}
            </span>
            {typeof node.page === "number" && (
              <span style={{ fontSize: "12px", opacity: 0.7, marginLeft: 6 }}>
                第 {node.page} 页
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
    if (typeof currentChapterPage !== "number") return;
    // 寻找最深匹配节点路径
    const findPath = (nodes: TocNode[], level: number, path: TocNode[]): TocNode[] | null => {
      let best: TocNode[] | null = null;
      for (const n of nodes) {
        const nextPath = [...path, n];
        const isMatch = n.page === currentChapterPage &&
          (typeof currentChapterLevel !== "number" || currentChapterLevel === level);
        if (isMatch) {
          best = nextPath;
        }
        if (n.children && n.children.length) {
          const childBest = findPath(n.children, level + 1, nextPath);
          if (childBest) {
            // 选择更深的路径
            if (!best || childBest.length > best.length) best = childBest;
          }
        }
      }
      return best;
    };

    const path = findPath(toc, 0, []);
    if (!path) return;
    const last = path[path.length - 1];
    setActiveSig(`${last.title}|${typeof last.page === "number" ? last.page : -1}|${path.length - 1}`);
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
  }, [visible, currentChapterPage, currentChapterLevel]);

  if (!visible) return null;

  return (
    <div
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
      style={{
        position: "absolute",
        inset: 0,
        backgroundColor: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "stretch",
        justifyContent: "flex-start",
        overflow: "hidden",
        zIndex: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
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
        {/* 顶部页签：目录 / 书签（固定在顶部） */}
        <div
          style={{
            padding: "16px 16px 0 16px",
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            gap: "16px",
            marginBottom: "12px",
          }}
        >
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
            }}
          >
            <span style={{ marginRight: "6px" }}>≡</span>
            <span>目录</span>
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
            <span>书签</span>
          </button>
        </div>

        {/* 内容区：目录或书签列表（可滚动） */}
        <div
          ref={scrollContainerRef}
          className="no-scrollbar"
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "0 16px 16px 16px",
            position: "relative",
          }}
        >
          {leftTab === "toc" ? (
            toc.length === 0 ? (
              <div style={{ fontSize: "13px", opacity: 0.6 }}>
                无目录信息
              </div>
            ) : (
              <div>{renderTocTree(toc, 0)}</div>
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
              没有添加书签
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
                    onGoToPage(bm.page_number);
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                    }}
                  >
                    <span style={{ fontSize: "13px", color: "#fff" }}>
                      {bm.title}
                    </span>
                    <span style={{ fontSize: "12px", opacity: 0.7 }}>
                      第 {bm.page_number} 页
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
                    title="删除书签"
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

import React, { useState, useRef } from "react";
import { TocNode } from "./types";
import { IBookmark } from "../../types";

interface TocOverlayProps {
  visible: boolean;
  toc: TocNode[];
  bookmarks: IBookmark[];
  currentChapterPage: number | undefined;
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
  onClose,
  onGoToPage,
  onDeleteBookmark,
  setToc,
}) => {
  const [leftTab, setLeftTab] = useState<"toc" | "bookmark">("toc");
  const tocItemRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  // 自动滚动到当前章节
  React.useEffect(() => {
    if (visible && typeof currentChapterPage === "number") {
      // 稍微延迟以确保渲染完成
      setTimeout(() => {
        const el = tocItemRefs.current.get(currentChapterPage);
        if (el) {
          el.scrollIntoView({ block: "center", behavior: "auto" });
        }
      }, 100);
    }
  }, [visible, currentChapterPage]);

  if (!visible) return null;

  const renderTocTree = (nodes: TocNode[], level: number): React.ReactNode => {
    const indent = 10 + level * 14;
    return nodes.map((node, idx) => {
      const hasChildren = !!(node.children && node.children.length);
      const caret = hasChildren ? (node.expanded ? "▼" : "▶") : "•";
      const isActive =
        typeof currentChapterPage === "number" &&
        node.page === currentChapterPage;
      return (
        <div key={`${level}-${idx}`} style={{ marginLeft: indent }}>
          <div
            ref={(el) => {
              if (el && typeof node.page === "number") {
                tocItemRefs.current.set(node.page, el as HTMLDivElement);
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
          overflowY: "auto",
          padding: "16px",
          boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
        }}
        className="no-scrollbar"
      >
        {/* 顶部页签：目录 / 书签（图标与文字贴近） */}
        <div
          style={{
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
        {/* 内容区：目录或书签列表 */}
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
  );
};

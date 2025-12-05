import React from "react";
import { BOTTOM_DRAWER_RADIUS } from "../../constants/ui";

interface BottomBarProps {
  visible: boolean;
  currentPage: number;
  totalPages: number;
  isSeeking: boolean;
  seekPage: number | null;
  readingMode: "horizontal" | "vertical";
  autoScroll: boolean;
  tocOverlayOpen: boolean;
  modeOverlayOpen: boolean;
  moreDrawerOpen: boolean;
  
  onSeekStart: () => void;
  onSeekChange: (val: number) => void;
  onSeekEnd: (val: number) => void;
  onPrevChapter: () => void;
  onNextChapter: () => void;
  onToggleToc: () => void;
  onToggleMode: () => void;
  onToggleAutoScroll: () => void;
  onAddBookmark: () => void;
  onOpenMore: () => void;
}

export const BottomBar: React.FC<BottomBarProps> = ({
  visible,
  currentPage,
  totalPages,
  isSeeking,
  seekPage,
  readingMode,
  autoScroll,
  tocOverlayOpen,
  modeOverlayOpen,
  moreDrawerOpen,
  onSeekStart,
  onSeekChange,
  onSeekEnd,
  onPrevChapter,
  onNextChapter,
  onToggleToc,
  onToggleMode,
  onToggleAutoScroll,
  onAddBookmark,
  onOpenMore,
}) => {
  if (!visible) return null;

  return (
    <div
      data-overlay-state={modeOverlayOpen || moreDrawerOpen ? 'open' : 'closed'}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseUp={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
      onTouchEnd={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        transform: "none",
        // 固定到底部
        bottom: 0,
        boxSizing: "border-box",
        backgroundColor: "rgba(26,26,26,0.92)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        color: "white",
        borderRadius: `${BOTTOM_DRAWER_RADIUS}px ${BOTTOM_DRAWER_RADIUS}px 0 0`,
        paddingTop: "14px",
        paddingLeft: "18px",
        paddingRight: "18px",
        paddingBottom: "14px",
        boxShadow: "0 6px 24px rgba(0,0,0,0.35)",
        zIndex: 10,
      }}
    >
      {/* 上方进度滑条 + 两端上一章/下一章文案 */}
      <div
        style={{
          width: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "stretch",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: "clamp(10px, 1.6vw, 12px)",
            color: "#bbb",
            marginBottom: "8px",
          }}
        >
          <span
            onClick={onPrevChapter}
            style={{
              cursor: currentPage <= 1 ? "default" : "pointer",
              opacity: currentPage <= 1 ? 0.5 : 1,
            }}
          >
            上一章
          </span>
          <span
            onClick={onNextChapter}
            style={{
              cursor: currentPage >= totalPages ? "default" : "pointer",
              opacity: currentPage >= totalPages ? 0.5 : 1,
            }}
          >
            下一章
          </span>
        </div>
        {(() => {
          const sliderVal =
            isSeeking && seekPage !== null ? seekPage : currentPage;
          const pct = Math.max(
            0,
            Math.min(
              100,
              Math.round((sliderVal / Math.max(1, totalPages)) * 100)
            )
          );
          const track = `linear-gradient(to right, #d15158 0%, #d15158 ${pct}%, #3a3a3a ${pct}%, #3a3a3a 100%)`;
          return (
            <input
              className="reader-range"
              type="range"
              min={1}
              max={totalPages}
              value={sliderVal}
              onMouseDown={(e) => {
                e.stopPropagation();
                onSeekStart();
              }}
              onTouchStart={(e) => {
                e.stopPropagation();
                onSeekStart();
              }}
              onInput={(e) => {
                const v = Number((e.target as HTMLInputElement).value);
                onSeekChange(v);
              }}
              onMouseUp={(e) => {
                e.stopPropagation();
                const v = Number((e.target as HTMLInputElement).value);
                onSeekEnd(v);
              }}
              onTouchEnd={(e) => {
                e.stopPropagation();
                const v = Number((e.target as HTMLInputElement).value);
                onSeekEnd(v);
              }}
              style={{
                width: "100%",
                height: "6px",
                borderRadius: "6px",
                background: track,
                outline: "none",
              }}
            />
          );
        })()}
      </div>
      {/* 下方图标操作区：5等分网格，窄屏也不拥挤 */}
      <div
        style={{
          marginTop: "14px",
          display: "grid",
          gridTemplateColumns: "repeat(5, 1fr)",
          alignItems: "center",
          justifyItems: "center",
          width: "100%",
          gap: "8px",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
          }}
        >
          <button
            onClick={onToggleToc}
            style={{
              background: "none",
              border: "none",
              color: tocOverlayOpen ? "#d15158" : "#fff",
              cursor: "pointer",
              fontSize: "clamp(16px, 3.2vw, 18px)",
            }}
            title="目录"
          >
            ≡
          </button>
          <div
            style={{
              fontSize: "clamp(10px, 1.6vw, 12px)",
              color: tocOverlayOpen ? "#d15158" : "#ccc",
              marginTop: "6px",
            }}
          >
            目录
          </div>
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
          }}
        >
          <button
            onClick={onToggleMode}
            style={{
              background: "none",
              border: "none",
              color: "#fff",
              cursor: "pointer",
              fontSize: "clamp(16px, 3.2vw, 18px)",
            }}
            title="阅读方式"
          >
            {readingMode === "horizontal" ? "▤" : "▮"}
          </button>
          <div
            style={{
              fontSize: "clamp(10px, 1.6vw, 12px)",
              color: "#ccc",
              marginTop: "6px",
            }}
          >
            阅读方式
          </div>
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
          }}
        >
          <button
            onClick={onToggleAutoScroll}
            style={{
              background: "none",
              border: "none",
              color: autoScroll ? "#d15158" : "#fff",
              cursor: "pointer",
              fontSize: "clamp(16px, 3.2vw, 18px)",
            }}
            title={readingMode === "horizontal" ? "自动翻页" : "自动滚动"}
          >
            ☰
          </button>
          <div
            style={{
              fontSize: "clamp(10px, 1.6vw, 12px)",
              color: autoScroll ? "#d15158" : "#ccc",
              marginTop: "6px",
            }}
          >
            {readingMode === "horizontal" ? "自动翻页" : "自动滚动"}
          </div>
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
          }}
        >
          <button
            onClick={onAddBookmark}
            style={{
              background: "none",
              border: "none",
              color: "#fff",
              cursor: "pointer",
              fontSize: "clamp(16px, 3.2vw, 18px)",
            }}
            title="书签"
          >
            🔖
          </button>
          <div
            style={{
              fontSize: "clamp(10px, 1.6vw, 12px)",
              color: "#ccc",
              marginTop: "6px",
            }}
          >
            书签
          </div>
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
          }}
        >
          <button
            onClick={onOpenMore}
            style={{
              background: "none",
              border: "none",
              color: "#fff",
              cursor: "pointer",
              fontSize: "clamp(16px, 3.2vw, 18px)",
            }}
            title="更多"
          >
            …
          </button>
          <div
            style={{
              fontSize: "clamp(10px, 1.6vw, 12px)",
              color: "#ccc",
              marginTop: "6px",
            }}
          >
            更多
          </div>
        </div>
      </div>
    </div>
  );
};

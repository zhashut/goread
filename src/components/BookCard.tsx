import React, { useRef } from "react";
import { useLongPress } from "../hooks/useLongPress";
import { IBook } from "../types";
import {
  CARD_WIDTH_COMPACT,
  COVER_ASPECT_RATIO_COMPACT,
  BOOK_TITLE_FONT_SIZE,
  BOOK_TITLE_FONT_WEIGHT,
  BOOK_META_FONT_SIZE,
  CARD_INFO_MARGIN_TOP,
  BOOK_PROGRESS_MARGIN_TOP,
} from "../constants/ui";

export interface CommonBookCardProps {
  book: IBook;
  onClick: () => void;
  onDelete?: () => void;
  // 可选交互（用于分组详情拖拽排序）
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragOver?: (e: React.DragEvent<HTMLDivElement>) => void;
  onDrop?: (e: React.DragEvent<HTMLDivElement>) => void;
  // 可选尺寸配置（默认与紧凑卡片一致）
  width?: number;
  aspectRatio?: string;
  // 选择模式（顶部右上角圆点）
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
  // 长按手势
  onLongPress?: () => void;
}

export const BookCard: React.FC<CommonBookCardProps> = ({
  book,
  onClick,
  onDelete,
  draggable,
  onDragStart,
  onDragOver,
  onDrop,
  width = CARD_WIDTH_COMPACT,
  aspectRatio = COVER_ASPECT_RATIO_COMPACT,
  selectable = false,
  selected = false,
  onToggleSelect,
  onLongPress,
}) => {
  const cardRef = useRef<HTMLDivElement | null>(null);
  // 动态加载长按 hook，避免循环依赖
  if (onLongPress) {
    useLongPress(cardRef as any, () => onLongPress(), { delay: 500 });
  }
  const progress =
    book.total_pages > 0
      ? Math.min(
          100,
          Math.round((book.current_page / book.total_pages) * 1000) / 10
        )
      : 0;

  return (
    <div
      className="book-card"
      onClick={onClick}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      style={{
        width: width + "px",
        margin: 0,
        cursor: "pointer",
        backgroundColor: "transparent",
        position: "relative",
      }}
      ref={cardRef}
    >
      <div
        style={{
          width: "100%",
          aspectRatio,
          backgroundColor: "#fff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          position: "relative",
          border: "1px solid #e5e5e5",
          borderRadius: "4px",
          boxShadow: "0 2px 6px rgba(0,0,0,0.06)",
          overflow: "hidden",
        }}
      >
        {/* 选择按钮（卡片内部右上角） */}
        {selectable && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggleSelect?.();
            }}
            title={selected ? "取消选择" : "选择"}
            style={{
              position: "absolute",
              top: "0.5px",
              right: "0.5px",
              width: "24px",
              height: "24px",
              background: "none",
              border: "none",
              boxShadow: "none",
              borderRadius: 0,
              WebkitAppearance: "none",
              appearance: "none",
              outline: "none",
              WebkitTapHighlightColor: "transparent",
              padding: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
            }}
          >
            {selected ? (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="9" fill="#d23c3c" />
                <path
                  d="M9 12l2 2 4-4"
                  stroke="#fff"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            ) : (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                <circle
                  cx="12"
                  cy="12"
                  r="9"
                  fill="#fff"
                  stroke="#d23c3c"
                  strokeWidth="2"
                />
              </svg>
            )}
          </button>
        )}
        {book.cover_image ? (
          <img
            src={`data:image/jpeg;base64,${book.cover_image}`}
            alt={book.title}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        ) : (
          <div style={{ color: "#999", fontSize: "14px", textAlign: "center" }}>
            暂无封面
          </div>
        )}
      </div>
      <div style={{ marginTop: CARD_INFO_MARGIN_TOP + "px" }}>
        <div
          style={{
            fontSize: BOOK_TITLE_FONT_SIZE + "px",
            fontWeight: BOOK_TITLE_FONT_WEIGHT,
            color: "#333",
            lineHeight: 1.5,
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical" as any,
            overflow: "hidden",
            textAlign: "left",
          }}
        >
          {book.title}
        </div>
        <div
          style={{
            marginTop: BOOK_PROGRESS_MARGIN_TOP + "px",
            fontSize: BOOK_META_FONT_SIZE + "px",
            color: "#888",
            textAlign: "left",
          }}
        >
          已读 {progress}%
        </div>
      </div>
    </div>
  );
};

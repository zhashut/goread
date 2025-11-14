import React from "react";
import { IBook } from "../types";
import {
  CARD_WIDTH_COMPACT,
  COVER_ASPECT_RATIO_COMPACT,
  BOOK_TITLE_FONT_SIZE,
  BOOK_TITLE_FONT_WEIGHT,
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
}) => {
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
        transition: "transform 0.2s ease",
        backgroundColor: "transparent",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = "translateY(-4px)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = "translateY(0)";
      }}
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
        {onDelete && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            title="删除书籍"
            style={{
              position: "absolute",
              top: "6px",
              right: "6px",
              background: "rgba(0,0,0,0.6)",
              color: "#fff",
              border: "none",
              borderRadius: "4px",
              padding: "4px 6px",
              fontSize: "12px",
              cursor: "pointer",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = "rgba(0,0,0,0.8)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = "rgba(0,0,0,0.6)";
            }}
          >
            删除
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
      <div style={{ marginTop: "8px" }}>
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
            marginTop: "1px",
            fontSize: "12px",
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

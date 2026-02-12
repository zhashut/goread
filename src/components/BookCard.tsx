import React, { useRef } from "react";
import { useLongPress } from "../hooks/useLongPress";
import { useInlineEdit } from "../hooks/useInlineEdit";
import { SELECTION_LONGPRESS_DELAY_MS } from "../constants/interactions";
import { IBook } from "../types";
import { getBookFormat } from "../constants/fileTypes";
import MarkdownCover from "./covers/MarkdownCover";
import HtmlCover from "./covers/HtmlCover";
import TxtIcon from "./covers/TxtIcon";
import { getDisplayTitle } from "../utils/bookTitle";
import { CoverImage } from "./CoverImage";
import {
  CARD_WIDTH_COMPACT,
  COVER_ASPECT_RATIO_COMPACT,
  BOOK_TITLE_FONT_SIZE,
  BOOK_TITLE_FONT_WEIGHT,
  BOOK_META_FONT_SIZE,
  CARD_INFO_MARGIN_TOP,
  BOOK_PROGRESS_MARGIN_TOP,
  SELECTION_ICON_SIZE,
  SELECTION_ICON_OFFSET_TOP,
  SELECTION_ICON_OFFSET_RIGHT,
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
  width?: number | string;
  aspectRatio?: string;
  // 选择模式（顶部右上角圆点）
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
  // 长按手势
  onLongPress?: () => void;
  // 书名编辑（仅分组详情页传入）
  editable?: boolean;
  onRename?: (newDisplayName: string) => void;
  outerRef?: React.Ref<HTMLDivElement>;
  outerProps?: React.HTMLAttributes<HTMLDivElement>;
  styleOverride?: React.CSSProperties;
}

export const BookCard: React.FC<CommonBookCardProps> = ({
  book,
  onClick,
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
  editable = false,
  onRename,
  outerRef,
  outerProps,
  styleOverride,
}) => {
  const cardRef = useRef<HTMLDivElement | null>(null);
  // 动态加载长按 hook，避免循环依赖
  if (onLongPress) {
    useLongPress(cardRef as any, () => onLongPress(), { delay: SELECTION_LONGPRESS_DELAY_MS });
  }
  // 判断文件格式
  const format = getBookFormat(book.file_path);
  const baseProgress = book.precise_progress ?? book.current_page;
  const totalPages = book.total_pages || 0;
  const hasPagination = totalPages > 1;
  const hasReadRecord = !!book.last_read_time;

  const isUnread = hasPagination ? baseProgress <= 1 : !hasReadRecord;

  // 计算进度：
  const progress =
    isUnread
      ? 0
      : format === 'txt' && totalPages > 0
        ? Math.min(100, Math.round(((baseProgress - 1) / Math.max(1, totalPages - 1)) * 1000) / 10)
        : totalPages > 0
          ? Math.min(100, Math.round((baseProgress / totalPages) * 1000) / 10)
          : 0;

  // 计算 padding-bottom 比例
  let pb = "133.33%";
  if (aspectRatio) {
    const parts = aspectRatio.split("/");
    if (parts.length === 2) {
      const w = parseFloat(parts[0]);
      const h = parseFloat(parts[1]);
      if (w && h) {
        pb = `${(h / w) * 100}%`;
      }
    }
  }

  const displayTitle = getDisplayTitle(book.title);
  const titleEditable = editable && !!onRename;
  const inlineEdit = useInlineEdit({
    value: displayTitle,
    onSubmit: (newName) => onRename?.(newName),
  });

  return (
    <div
      className="book-card"
      onClick={inlineEdit.isEditing ? undefined : onClick}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      style={{
        width: typeof width === "number" ? width + "px" : width,
        margin: 0,
        cursor: "pointer",
        backgroundColor: "transparent",
        position: "relative",
        userSelect: "none",
        ...(styleOverride || {}),
      }}
      ref={(node) => {
        cardRef.current = node;
        if (typeof outerRef === "function") {
          outerRef(node as any);
        } else if (outerRef && (outerRef as any)) {
          try { (outerRef as any).current = node; } catch { }
        }
      }}
      {...(outerProps || {})}
    >
      <div
        style={{
          width: "100%",
          paddingBottom: pb,
          height: 0,
          backgroundColor: "#fff",
          position: "relative",
          border: "1px solid #e5e5e5",
          borderRadius: "4px",
          boxShadow: "0 2px 6px rgba(0,0,0,0.06)",
          overflow: "hidden",
          boxSizing: "content-box",
        }}
      >
        {/* 内容容器 */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            userSelect: "none",
          }}
        >
          {book.cover_image ? (
            <CoverImage
              coverImage={book.cover_image}
              alt={displayTitle}
              bookId={book.id ?? undefined}
              enableMigration={true}
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
              placeholder={
                format === "markdown" ? (
                  <MarkdownCover />
                ) : format === "html" ? (
                  <HtmlCover />
                ) : format === "txt" ? (
                  <TxtIcon />
                ) : (
                  <div style={{ color: "#999", fontSize: "14px", textAlign: "center" }}>
                    暂无封面
                  </div>
                )
              }
            />
          ) : format === "markdown" ? (
            <MarkdownCover />
          ) : format === "html" ? (
            <HtmlCover />
          ) : format === "txt" ? (
            <TxtIcon />
          ) : (
            <div style={{ color: "#999", fontSize: "14px", textAlign: "center" }}>
              暂无封面
            </div>
          )}
        </div>

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
              top: SELECTION_ICON_OFFSET_TOP + "px",
              right: SELECTION_ICON_OFFSET_RIGHT + "px",
              width: SELECTION_ICON_SIZE + "px",
              height: SELECTION_ICON_SIZE + "px",
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
              zIndex: 10,
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
      </div>
      <div style={{ marginTop: CARD_INFO_MARGIN_TOP + "px" }}>
        {inlineEdit.isEditing ? (
          <input
            ref={inlineEdit.inputRef}
            value={inlineEdit.editValue}
            onChange={(e) => inlineEdit.setEditValue(e.target.value)}
            onKeyDown={inlineEdit.handleKeyDown}
            onBlur={inlineEdit.handleBlur}
            onClick={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
            style={{
              width: "100%",
              fontSize: BOOK_TITLE_FONT_SIZE + "px",
              fontWeight: BOOK_TITLE_FONT_WEIGHT,
              color: "#333",
              lineHeight: 1.5,
              border: "1px solid #d23c3c",
              borderRadius: "3px",
              outline: "none",
              padding: "2px 4px",
              boxSizing: "border-box",
              background: "#fff",
            }}
          />
        ) : (
          <div
            onClick={(e) => {
              if (titleEditable) {
                e.stopPropagation();
                inlineEdit.startEdit();
              }
            }}
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
              userSelect: "none",
            }}
          >
            {displayTitle}
          </div>
        )}
        <div
          style={{
            marginTop: BOOK_PROGRESS_MARGIN_TOP + "px",
            fontSize: BOOK_META_FONT_SIZE + "px",
            color: "#888",
            textAlign: "left",
            userSelect: "none",
          }}
        >
          {isUnread ? "未读" : `已读 ${progress}%`}
        </div>
      </div>
    </div>
  );
};

import React, { useRef } from "react";
import { useTranslation } from "react-i18next";

import { IBook, IGroup } from "../../types";
import { getBookFormat } from "../../constants/fileTypes";
import { getDisplayTitle } from "../../utils/bookTitle";
import { useLongPress } from "../../hooks/useLongPress";
import { SELECTION_LONGPRESS_DELAY_MS } from "../../constants/interactions";
import { CoverImage } from "../CoverImage";
import MarkdownCover from "../covers/MarkdownCover";
import HtmlCover from "../covers/HtmlCover";
import TxtIcon from "../covers/TxtIcon";

/**
 * 书架列表行通用样式：通栏白底行（无圆角无行间距），与参考图的横向列表条目一致
 */
const ROW_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  background: "#fff",
  padding: "14px 16px",
  cursor: "pointer",
  userSelect: "none",
  position: "relative",
};

/**
 * 选择模式圆标按钮（行右侧）：选中为红色实心勾，未选为白底红描边空心圆
 * @param selected 当前条目是否已选中
 * @param onToggle 点击回调（切换选中态）
 * @returns 圆标按钮节点
 */
const SelectionDot: React.FC<{ selected: boolean; onToggle: () => void }> = ({
  selected,
  onToggle,
}) => (
  <button
    onClick={(e) => {
      e.stopPropagation();
      onToggle();
    }}
    title={selected ? "取消选择" : "选择"}
    style={{
      // 豁免 App.css 全局 button 重置样式
      background: "none",
      border: "none",
      boxShadow: "none",
      borderRadius: 0,
      WebkitAppearance: "none",
      appearance: "none",
      outline: "none",
      WebkitTapHighlightColor: "transparent",
      marginLeft: 8,
      flexShrink: 0,
      width: 24,
      height: 24,
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
        <circle cx="12" cy="12" r="9" fill="#fff" stroke="#d23c3c" strokeWidth="2" />
      </svg>
    )}
  </button>
);

/**
 * 黄色文件夹小图标（双层：背板浅黄 + 前板金黄），与 FolderCover 同款造型
 * @param size 图标边长（px）
 * @returns 双层黄色文件夹 SVG 节点
 */
const FolderIcon: React.FC<{ size: number }> = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    {/* 背板：文件夹整体轮廓（含左上标签耳） */}
    <path
      d="M3.5 6.5C3.5 5.4 4.4 4.5 5.5 4.5H9.3C9.8 4.5 10.3 4.7 10.6 5.1L11.8 6.5H18.5C19.6 6.5 20.5 7.4 20.5 8.5V17.5C20.5 18.6 19.6 19.5 18.5 19.5H5.5C4.4 19.5 3.5 18.6 3.5 17.5V6.5Z"
      fill="#FBD97A"
    />
    {/* 前板：前盖略宽且底边下探，形成双层层次 */}
    <path
      d="M3 10.2C3 9.6 3.5 9.2 4 9.2H20C20.5 9.2 21 9.6 21 10.2V18C21 19.1 20.1 20 19 20H5C3.9 20 3 19.1 3 18V10.2Z"
      fill="#F5B840"
    />
  </svg>
);

export interface GroupListRowProps {
  /** 分组数据 */
  group: IGroup;
  /** 是否处于选择模式（显示右侧圆标） */
  selectable: boolean;
  /** 当前分组是否已选中 */
  selected: boolean;
  /** 点击行回调（打开分组或切换选中，由外部决定） */
  onClick: () => void;
  /** 长按行回调（进入选择模式） */
  onLongPress: () => void;
  /** 点击圆标回调（切换选中态） */
  onToggleSelect: () => void;
  /** 括号内次级文案：缺省显示「文件N个」，传字符串自定义，传 null 隐藏（如网络书架目录无文件计数） */
  metaText?: string | null;
}

/**
 * 分组列表行：左侧金黄色文件夹图标 + 「名称(文件N个)」一体展示，
 * 支持长按进入选择模式、选择模式圆标切换
 *
 * @param props GroupListRowProps（分组数据与交互回调）
 * @returns React.FC，渲染单个分组列表行
 */
export const GroupListRow: React.FC<GroupListRowProps> = ({
  group,
  selectable,
  selected,
  onClick,
  onLongPress,
  onToggleSelect,
  metaText,
}) => {
  const { t } = useTranslation("bookshelf");
  const rowRef = useRef<HTMLDivElement | null>(null);
  // 长按手势：与网格卡片一致的延迟，触发进入选择模式
  useLongPress(rowRef, onLongPress, { delay: SELECTION_LONGPRESS_DELAY_MS });

  return (
    <div ref={rowRef} onClick={onClick} style={ROW_STYLE}>
      {/* 左侧金黄色文件夹图标（无底色容器，与参考图一致） */}
      <FolderIcon size={40} />
      {/* 中间名称与文件数：名称(文件N个) 一体显示（单行省略） */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          marginLeft: 14,
          fontSize: 15,
          fontWeight: 500,
          color: "#333",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {group.name}
        {metaText === null
          ? ""
          : `(${metaText ?? t("filesCount", { count: group.book_count })})`}
      </div>
      {/* 选择模式圆标 */}
      {selectable && <SelectionDot selected={selected} onToggle={onToggleSelect} />}
    </div>
  );
};

export interface BookListRowProps {
  /** 书籍数据 */
  book: IBook;
  /** 是否处于选择模式（显示右侧圆标） */
  selectable: boolean;
  /** 当前书籍是否已选中 */
  selected: boolean;
  /** 点击行回调（打开书籍或切换选中，由外部决定） */
  onClick: () => void;
  /** 长按行回调（进入选择模式） */
  onLongPress: () => void;
  /** 点击圆标回调（切换选中态） */
  onToggleSelect: () => void;
}

/**
 * 书籍列表行：左侧封面缩略图（36x48，无封面时按格式回退）+ 书名与阅读进度 + 选择圆标，
 * 支持长按进入选择模式；进度计算与 BookCard 保持一致
 *
 * @param props BookListRowProps（书籍数据与交互回调）
 * @returns React.FC，渲染单本书籍列表行
 */
export const BookListRow: React.FC<BookListRowProps> = ({
  book,
  selectable,
  selected,
  onClick,
  onLongPress,
  onToggleSelect,
}) => {
  const { t } = useTranslation("bookshelf");
  const rowRef = useRef<HTMLDivElement | null>(null);
  // 长按手势：与网格卡片一致的延迟，触发进入选择模式
  useLongPress(rowRef, onLongPress, { delay: SELECTION_LONGPRESS_DELAY_MS });

  // 进度计算逻辑与 BookCard 完全一致
  const format = getBookFormat(book.file_path);
  const baseProgress = book.precise_progress ?? book.current_page;
  const totalPages = book.total_pages || 0;
  const hasPagination = totalPages > 1;
  const hasReadRecord = !!book.last_read_time;
  const isUnread = hasPagination ? baseProgress <= 1 : !hasReadRecord;
  const progress =
    isUnread
      ? 0
      : format === "txt" && totalPages > 0
        ? Math.min(100, Math.round(((baseProgress - 1) / Math.max(1, totalPages - 1)) * 1000) / 10)
        : totalPages > 0
          ? Math.min(100, Math.round((baseProgress / totalPages) * 1000) / 10)
          : 0;
  const displayTitle = getDisplayTitle(book.title);

  return (
    <div ref={rowRef} onClick={onClick} style={ROW_STYLE}>
      {/* 左侧封面缩略图（3:4 比例，无封面按格式回退占位） */}
      <div
        style={{
          width: 36,
          height: 48,
          flexShrink: 0,
          borderRadius: 4,
          border: "1px solid #e5e5e5",
          background: "#fff",
          overflow: "hidden",
          boxSizing: "border-box",
          position: "relative",
        }}
      >
        {book.cover_image ? (
          <CoverImage
            coverImage={book.cover_image}
            alt={displayTitle}
            bookId={book.id}
            enableMigration={true}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        ) : format === "markdown" ? (
          <MarkdownCover />
        ) : format === "html" ? (
          <HtmlCover />
        ) : format === "txt" ? (
          <TxtIcon />
        ) : (
          <div style={{ color: "#999", fontSize: "10px", textAlign: "center" }}>暂无封面</div>
        )}
      </div>
      {/* 中间书名与进度：书名(未读/已读N%) 一体显示（单行省略），与分组行格式统一 */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          marginLeft: 14,
          fontSize: 15,
          fontWeight: 500,
          color: "#333",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {displayTitle}({isUnread ? t("bookStatusUnread") : t("bookStatusReadPercent", { progress })})
      </div>
      {/* 选择模式圆标 */}
      {selectable && <SelectionDot selected={selected} onToggle={onToggleSelect} />}
    </div>
  );
};

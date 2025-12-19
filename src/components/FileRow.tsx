import React from "react";
import { useTranslation } from 'react-i18next';

export interface FileRowProps {
  name: string;
  path: string;
  size?: number;
  mtime?: number;
  imported?: boolean;
  selected?: boolean;
  onToggle?: (path: string) => void;
  // Row height for layout consistency across pages
  rowHeight?: number; // default 60
  // Render mode: 'select' shows radio/checked/imported; 'chevron' shows right arrow
  mode?: "select" | "chevron";
  // Optional click handler for chevron mode
  onClickRow?: () => void;
}

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

import { getBookFormat, getFormatColor, getFormatIconText } from "../constants/fileTypes";

export const FileRow: React.FC<FileRowProps> = ({
  name,
  path,
  size,
  mtime,
  imported,
  selected,
  onToggle,
  rowHeight = 60,
  mode = "select",
  onClickRow,
}) => {
  const { t } = useTranslation('import');
  // 调整图标大小适配新的长方形图标 (36:44 比例)
  const iconWidth = Math.round(rowHeight * 0.6); // 36px for 60px row
  const iconHeight = Math.round(iconWidth * (44 / 36)); 
  
  const disabled = mode === "select" ? !!imported : !onClickRow;

  const handleClick = () => {
    if (disabled) return;
    if (mode === "select") {
      onToggle?.(path);
    } else if (mode === "chevron") {
      onClickRow?.();
    }
  };

  const format = getBookFormat(path);
  const color = getFormatColor(format);
  const iconText = format ? getFormatIconText(format) : '';

  return (
    <div
      onClick={handleClick}
      style={{
        display: "flex",
        alignItems: "center",
        height: rowHeight,
        padding: "0 4px",
        borderBottom: "1px solid #f0f0f0",
        cursor: disabled ? "default" : "pointer",
      }}
    >
      {/* 动态文件图标 */}
      <svg
        width={iconWidth}
        height={iconHeight}
        viewBox="0 0 36 44"
        fill="none"
        aria-hidden
        style={{ marginRight: 14, flexShrink: 0 }}
      >
        <path d="M4 0C1.79 0 0 1.79 0 4v36c0 2.21 1.79 4 4 4h28c2.21 0 4-1.79 4-4V12l-12-12H4z" fill={color} />
        <path d="M24 0v12h12" fill="rgba(0,0,0,0.2)"/>
        <text 
            x="18" 
            y="32" 
            fill="white" 
            fontSize="9" 
            fontWeight="bold" 
            fontFamily="Arial, sans-serif" 
            textAnchor="middle"
            style={{ pointerEvents: 'none', letterSpacing: '0.5px' }}
        >
            {iconText}
        </text>
      </svg>
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
          {name}
        </div>
        <div style={{ color: "#888", fontSize: 12 }}>
          {bytesToSize(size)} · {fmtDate(mtime)}
        </div>
      </div>
      {mode === "select" ? (
        imported ? (
          <div style={{ color: "#3a8f3a", fontSize: 12, marginRight: 8 }}>
            {t('imported')}
          </div>
        ) : selected ? (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="9" stroke="#d23c3c" strokeWidth="2" />
            <path
              d="M9 12l2 2 4-4"
              stroke="#d23c3c"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="9" stroke="#bbb" strokeWidth="2" />
          </svg>
        )
      ) : (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
          <path
            d="M9 6l6 6-6 6"
            stroke="#999"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </div>
  );
};

export default FileRow;
import React from "react";

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
  const iconSize = Math.round(rowHeight * 0.7);
  const disabled = mode === "select" ? !!imported : !onClickRow;

  const handleClick = () => {
    if (disabled) return;
    if (mode === "select") {
      onToggle?.(path);
    } else if (mode === "chevron") {
      onClickRow?.();
    }
  };

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
      {/* 通用书本图标 */}
      <svg
        width={iconSize}
        height={iconSize}
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden
        style={{ marginRight: 10 }}
      >
        <rect x="5" y="3" width="12" height="18" rx="2" fill="#d23c3c" />
        <rect x="17" y="3" width="2" height="18" rx="1" fill="#b53737" />
        <rect x="7" y="8" width="8" height="1.5" fill="#fff" opacity="0.9" />
        <rect x="7" y="11" width="6" height="1.5" fill="#fff" opacity="0.9" />
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
            已导入
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
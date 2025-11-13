import React from "react";

interface ImportProgressDrawerProps {
  open: boolean;
  title?: string;
  current: number;
  total: number;
  onStop: () => void;
}

const ImportProgressDrawer: React.FC<ImportProgressDrawerProps> = ({
  open,
  title,
  current,
  total,
  onStop,
}) => {
  const percent = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;

  return (
    <div
      aria-live="polite"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: open ? "flex" : "none",
        alignItems: "flex-end",
        zIndex: 1000,
      }}
    >
      <div
        role="dialog"
        aria-label="导入进度"
        style={{
          width: "100%",
          background: "#fff",
          borderTopLeftRadius: 20,
          borderTopRightRadius: 20,
          boxShadow: "0 -8px 20px rgba(0,0,0,0.15)",
          padding: "16px 18px 20px 18px",
          boxSizing: "border-box",
          minHeight: "22vh",
          display: "grid",
          gridTemplateRows: "auto 1fr auto",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ color: "#333", fontSize: 15 }}>
            正在导入「{(title || "").slice(0, 20)}{(title || "").length > 20 ? "…" : ""}」书籍
          </div>
        </div>
        <div
          style={{
            alignSelf: "center",
            width: "100%",
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <div
            aria-hidden
            style={{
              flex: 1,
              height: 8,
              borderRadius: 4,
              background: "#eee",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${percent}%`,
                height: "100%",
                background: "#d23c3c",
                transition: "width 200ms ease",
              }}
            />
          </div>
          <div style={{ color: "#777", fontSize: 14, minWidth: 56, textAlign: "right" }}>
            {current} / {total}
          </div>
        </div>
        <div>
          <button
            onClick={onStop}
            style={{
              width: "100%",
              height: 52,
              background: "#d23c3c",
              color: "#fff",
              border: "none",
              borderRadius: 26,
              cursor: "pointer",
            }}
          >
            停止导入
          </button>
        </div>
      </div>
    </div>
  );
};

export default ImportProgressDrawer;
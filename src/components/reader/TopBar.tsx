import React from "react";
import { TOP_DRAWER_RADIUS } from "../../constants/ui";

interface TopBarProps {
  visible: boolean;
  bookTitle?: string;
  onBack: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({ visible, bookTitle, onBack }) => {
  if (!visible) return null;

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseUp={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
      onTouchEnd={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        transform: "none",
        boxSizing: "border-box",
        backgroundColor: "rgba(26,26,26,0.92)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        color: "white",
        borderRadius: `0 0 ${TOP_DRAWER_RADIUS}px ${TOP_DRAWER_RADIUS}px`,
        padding: "8px 12px",
        boxShadow: "0 6px 24px rgba(0,0,0,0.35)",
        zIndex: 12,
      }}
    >
      <button
        onClick={onBack}
        style={{
          background: "none",
          border: "none",
          color: "#fff",
          cursor: "pointer",
          fontSize: "16px",
        }}
        title="返回"
      >
        {"<"}
      </button>
      <div
        style={{
          fontSize: "16px",
          fontWeight: 500,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {bookTitle}
      </div>
      <div style={{ width: "24px" }} />
    </div>
  );
};

import React from "react";
import { BOTTOM_DRAWER_RADIUS } from "../../constants/ui";

interface MoreDrawerProps {
  visible: boolean;
  onClose: () => void;
  onCapture: () => void;
  onSettings: () => void;
}

export const MoreDrawer: React.FC<MoreDrawerProps> = ({
  visible,
  onClose,
  onCapture,
  onSettings,
}) => {
  if (!visible) return null;

  return (
    <div
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "rgba(0,0,0,0.5)",
        zIndex: 20,
        display: "flex",
        flexDirection: "column",
        justifyContent: "flex-end",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          backgroundColor: "#1f1f1f",
          borderRadius: `${BOTTOM_DRAWER_RADIUS}px ${BOTTOM_DRAWER_RADIUS}px 0 0`,
          padding: "12px 0",
          paddingBottom: "calc(12px + env(safe-area-inset-bottom))",
          display: "flex",
          flexDirection: "column",
          animation: "slideUp 0.3s ease-out",
        }}
      >
        <div
          onClick={onCapture}
          style={{
            display: "flex",
            alignItems: "center",
            padding: "16px 24px",
            cursor: "pointer",
            color: "#fff",
          }}
          onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "#2a2a2a"}
          onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
        >
          <div style={{ 
            fontSize: "20px", 
            marginRight: "16px",
            width: "24px",
            textAlign: "center"
          }}>
            📷
          </div>
          <span style={{ fontSize: "16px" }}>导出图片</span>
        </div>

        <div
          onClick={onSettings}
          style={{
            display: "flex",
            alignItems: "center",
            padding: "16px 24px",
            cursor: "pointer",
            color: "#fff",
          }}
          onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "#2a2a2a"}
          onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
        >
          <div style={{ 
            fontSize: "20px", 
            marginRight: "16px",
            width: "24px",
            textAlign: "center"
          }}>
            ⚙️
          </div>
          <span style={{ fontSize: "16px" }}>设置</span>
        </div>
      </div>
    </div>
  );
};

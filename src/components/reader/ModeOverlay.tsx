import React from "react";
import { getSafeAreaInsets } from "../../utils/layout";


interface ModeOverlayProps {
  visible: boolean;
  readingMode: "horizontal" | "vertical";
  onClose: () => void;
  onChangeMode: (mode: "horizontal" | "vertical") => void;
}

export const ModeOverlay: React.FC<ModeOverlayProps> = ({
  visible,
  readingMode,
  onClose,
  onChangeMode,
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
        backgroundColor: "rgba(0,0,0,0.6)",
        display: "flex",
        flexDirection: "column",
        justifyContent: "flex-end",
        alignItems: "center",
        overflow: "hidden",
        zIndex: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(720px, calc(100% - 32px))",
          backgroundColor: "#1f1f1f",
          color: "#fff",
          borderTopLeftRadius: "12px",
          borderTopRightRadius: "12px",
          padding: "18px",
          paddingBottom: `calc(18px + ${getSafeAreaInsets().bottom}px)`,
          margin: "0 auto 0",
          boxShadow: "0 -8px 32px rgba(0,0,0,0.5)",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
          }}
        >
          <button
            onClick={() => onChangeMode("horizontal")}
            style={{
              display: "flex",
              alignItems: "center",
              background: "none",
              border: "1px solid #333",
              color: readingMode === "horizontal" ? "#d15158" : "#fff",
              cursor: "pointer",
              borderRadius: "8px",
              padding: "10px 12px",
              textAlign: "left",
              marginBottom: "16px",
            }}
          >
            <span style={{ fontSize: "18px", marginRight: "12px" }}>▤</span>
            <div>
              <div style={{ fontSize: "14px" }}>横向阅读</div>
              <div style={{ fontSize: "12px", opacity: 0.7 }}>
                左右翻页，适合分页浏览
              </div>
            </div>
          </button>
          <button
            onClick={() => onChangeMode("vertical")}
            style={{
              display: "flex",
              alignItems: "center",
              background: "none",
              border: "1px solid #333",
              color: readingMode === "vertical" ? "#d15158" : "#fff",
              cursor: "pointer",
              borderRadius: "8px",
              padding: "10px 12px",
              textAlign: "left",
            }}
          >
            <span style={{ fontSize: "18px", marginRight: "12px" }}>▮</span>
            <div>
              <div style={{ fontSize: "14px" }}>纵向阅读</div>
              <div style={{ fontSize: "12px", opacity: 0.7 }}>
                向下滚动，连续阅读
              </div>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
};

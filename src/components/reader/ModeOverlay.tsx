import React from "react";
import { useTranslation } from 'react-i18next';
import { getSafeAreaInsets } from "../../utils/layout";


interface ModeOverlayProps {
  visible: boolean;
  readingMode: "horizontal" | "vertical";
  onClose: () => void;
  onChangeMode: (mode: "horizontal" | "vertical") => void;
  horizontalDisabled?: boolean;
}

export const ModeOverlay: React.FC<ModeOverlayProps> = ({
  visible,
  readingMode,
  onClose,
  onChangeMode,
  horizontalDisabled,
}) => {
  const { t } = useTranslation('reader');
  
  if (!visible) return null;

  return (
    <div
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "rgba(0,0,0,0.6)",
        display: "flex",
        flexDirection: "column",
        justifyContent: "flex-end",
        overflow: "hidden",
        zIndex: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: "720px",
          margin: "0 auto",
          boxSizing: "border-box",
          backgroundColor: "#1f1f1f",
          color: "#fff",
          borderRadius: "12px 12px 0 0",
          padding: "18px",
          paddingBottom: `calc(18px + ${getSafeAreaInsets().bottom})`,
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
            onClick={() => {
              if (horizontalDisabled) return;
              onChangeMode("horizontal");
            }}
            disabled={horizontalDisabled}
            style={{
              display: "flex",
              alignItems: "center",
              background: "none",
              border: "1px solid #333",
              color: horizontalDisabled
                ? "#666"
                : readingMode === "horizontal"
                ? "#d15158"
                : "#fff",
              cursor: horizontalDisabled ? "not-allowed" : "pointer",
              borderRadius: "8px",
              padding: "10px 12px",
              textAlign: "left",
              marginBottom: "16px",
              opacity: horizontalDisabled ? 0.5 : 1,
            }}
          >
            <span style={{ fontSize: "18px", marginRight: "12px" }}>▤</span>
            <div>
              <div style={{ fontSize: "14px" }}>{t('horizontalReading')}</div>
              <div style={{ fontSize: "12px", opacity: 0.7 }}>
                {t('horizontalReadingDesc')}
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
              <div style={{ fontSize: "14px" }}>{t('verticalReading')}</div>
              <div style={{ fontSize: "12px", opacity: 0.7 }}>
                {t('verticalReadingDesc')}
              </div>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
};

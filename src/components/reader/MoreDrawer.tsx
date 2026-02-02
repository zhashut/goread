import React from "react";
import { useTranslation } from 'react-i18next';
import { BOTTOM_DRAWER_RADIUS } from "../../constants/ui";
import { getSafeAreaInsets } from "../../utils/layout";

interface MoreDrawerProps {
  visible: boolean;
  onClose: () => void;
  onCapture: () => void;
  onSettings: () => void;
  hideDivider: boolean;
  onToggleHideDivider: () => void;
}

export const MoreDrawer: React.FC<MoreDrawerProps> = ({
  visible,
  onClose,
  onCapture,
  onSettings,
  hideDivider,
  onToggleHideDivider,
}: MoreDrawerProps) => {
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
          paddingBottom: `calc(12px + ${getSafeAreaInsets().bottom})`,
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
          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "#2a2a2a")}
          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
        >
          <div
            style={{
              fontSize: "20px",
              marginRight: "16px",
              width: "24px",
              textAlign: "center",
            }}
          >
            📷
          </div>
          <span style={{ fontSize: "16px" }}>{t('exportImage')}</span>
        </div>

        <div
          onClick={(e) => {
            e.stopPropagation();
            onToggleHideDivider();
          }}
          style={{
            display: "flex",
            alignItems: "center",
            padding: "16px 24px",
            cursor: "pointer",
            color: "#fff",
            justifyContent: "space-between",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "#2a2a2a")}
          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
        >
          <div style={{ display: "flex", alignItems: "center" }}>
            <div
              style={{
                fontSize: "20px",
                marginRight: "16px",
                width: "24px",
                textAlign: "center",
              }}
            >
              👁️
            </div>
            <span style={{ fontSize: "16px" }}>{t('hidePageDivider')}</span>
          </div>
          <div
            style={{
              width: "40px",
              height: "24px",
              backgroundColor: hideDivider ? "#e53935" : "#3e3e3e",
              borderRadius: "12px",
              position: "relative",
              transition: "background-color 0.2s",
            }}
          >
            <div
              style={{
                width: "20px",
                height: "20px",
                backgroundColor: "#fff",
                borderRadius: "50%",
                position: "absolute",
                top: "2px",
                left: hideDivider ? "18px" : "2px",
                transition: "left 0.2s, background-color 0.2s",
                boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
              }}
            />
          </div>
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
          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "#2a2a2a")}
          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
        >
          <div
            style={{
              fontSize: "20px",
              marginRight: "16px",
              width: "24px",
              textAlign: "center",
            }}
          >
            ⚙️
          </div>
          <span style={{ fontSize: "16px" }}>{t('settings')}</span>
        </div>
      </div>
    </div>
  );
};

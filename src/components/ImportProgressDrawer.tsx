import React from "react";
import { useTranslation } from 'react-i18next';
import { getSafeAreaInsets } from "../utils/layout";

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
  const { t } = useTranslation('import');
  const percent = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;

  return (
    <div
      aria-live="polite"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: "rgba(0,0,0,0.5)",
        display: open ? "flex" : "none",
        alignItems: "flex-end",
        zIndex: 1000,
      }}
    >
      <div
        role="dialog"
        aria-label={t('importProgress')}
        style={{
          width: "100%",
          background: "#fff",
          borderTopLeftRadius: 20,
          borderTopRightRadius: 20,
          boxShadow: "0 -8px 20px rgba(0,0,0,0.15)",
          padding: `16px 18px calc(20px + ${getSafeAreaInsets().bottom}) 18px`,
          boxSizing: "border-box",
          minHeight: "22vh",
          display: "grid",
          gridTemplateRows: "auto 1fr auto",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ color: "#333", fontSize: 15 }}>
            {t('importingBook', { title: (title || "").slice(0, 20) + ((title || "").length > 20 ? "…" : "") })}
          </div>
        </div>
        <div
          style={{
            alignSelf: "center",
            width: "100%",
            display: "flex",
            alignItems: "center",
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
              marginRight: 10,
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
          <div style={{ color: "#777", fontSize: 14 }}>
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
            {t('stopImport')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ImportProgressDrawer;
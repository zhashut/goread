import React from "react";
import { useTranslation } from "react-i18next";
import { FORMAT_DISPLAY_NAMES, getFormatDisplayName } from "../constants/fileTypes";
import type { BookFormat } from "../services/formats/types";

interface FormatFilterButtonProps {
  filterFormat: "ALL" | BookFormat;
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
  onSelect: (fmt: "ALL" | BookFormat) => void;
  canFilter?: boolean;
}

export const FormatFilterButton: React.FC<FormatFilterButtonProps> = ({
  filterFormat,
  menuOpen,
  onMenuOpenChange,
  onSelect,
  canFilter = true,
}) => {
  const { t } = useTranslation("import");
  const handleToggleMenu: React.MouseEventHandler<HTMLButtonElement> = (e) => {
    e.stopPropagation();
    if (!canFilter) return;
    onMenuOpenChange(!menuOpen);
  };

  const handleSelectAll = () => {
    onSelect("ALL");
  };

  const handleSelectFormat = (fmt: BookFormat) => {
    onSelect(fmt);
  };

  const showMenu = menuOpen && canFilter;

  return (
    <div style={{ position: "relative" }}>
      <button
        aria-label={t("filterFormats")}
        title={t("filterFormats")}
        disabled={!canFilter}
        style={{
          background: "none",
          border: "none",
          boxShadow: "none",
          borderRadius: 4,
          cursor: canFilter ? "pointer" : "default",
          padding: 0,
          marginRight: 16,
          width: 32,
          height: 32,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor:
            showMenu || filterFormat !== "ALL" ? "#f5f5f5" : "transparent",
          opacity: canFilter ? 1 : 0.3,
        }}
        onClick={handleToggleMenu}
      >
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill={filterFormat !== "ALL" && canFilter ? "#d43d3d" : "#333"}
        >
          <path d="M10 18h4v-2h-4v2zM3 6v2h18V6H3zm3 7h12v-2H6v2z" />
        </svg>
      </button>

      {showMenu && (
        <>
          <div
            style={{
              position: "fixed",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: 999,
            }}
            onClick={() => onMenuOpenChange(false)}
          />
          <div
            style={{
              position: "absolute",
              top: 40,
              right: -8,
              background: "#fff",
              borderRadius: 8,
              boxShadow: "0 4px 20px rgba(0,0,0,0.15)",
              width: 140,
              padding: "8px 0",
              border: "1px solid #f0f0f0",
              zIndex: 1000,
              maxHeight: 400,
              overflowY: "auto",
              animation: "fadeIn 0.1s ease-out",
            }}
          >
            <style>{`
              @keyframes fadeIn {
                from { opacity: 0; transform: scale(0.95); }
                to { opacity: 1; transform: scale(1); }
              }
            `}</style>
            <div
              style={{
                padding: "10px 16px",
                fontSize: 14,
                color: filterFormat === "ALL" ? "#d43d3d" : "#333",
                backgroundColor:
                  filterFormat === "ALL" ? "#fffbfb" : "transparent",
                cursor: "pointer",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                fontWeight: filterFormat === "ALL" ? 500 : 400,
              }}
              onClick={() => {
                handleSelectAll();
                onMenuOpenChange(false);
              }}
            >
              {t("format.all")}
              {filterFormat === "ALL" && (
                <span style={{ color: "#d43d3d", fontSize: 12 }}>✓</span>
              )}
            </div>
            {(Object.keys(FORMAT_DISPLAY_NAMES) as BookFormat[]).map((fmt) => (
              <div
                key={fmt}
                style={{
                  padding: "10px 16px",
                  fontSize: 14,
                  color: filterFormat === fmt ? "#d43d3d" : "#333",
                  backgroundColor:
                    filterFormat === fmt ? "#fffbfb" : "transparent",
                  cursor: "pointer",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  fontWeight: filterFormat === fmt ? 500 : 400,
                }}
                onClick={() => {
                  handleSelectFormat(fmt);
                  onMenuOpenChange(false);
                }}
              >
                {getFormatDisplayName(fmt)}
                {filterFormat === fmt && (
                  <span style={{ color: "#d43d3d", fontSize: 12 }}>✓</span>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
};


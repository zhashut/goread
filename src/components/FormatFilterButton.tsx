import React from "react";
import { useTranslation } from "react-i18next";
import { FORMAT_DISPLAY_NAMES, getFormatDisplayName } from "../constants/fileTypes";
import type { BookFormat } from "../services/formats/types";

/** 单选模式的属性（扫描结果页面使用） */
interface SingleSelectProps {
  mode?: 'single';
  /** 当前选中的格式 */
  filterFormat: 'ALL' | BookFormat;
  /** 格式变化回调 */
  onSelect: (fmt: 'ALL' | BookFormat) => void;
  filterFormats?: never;
  onFormatsChange?: never;
}

/** 多选模式的属性（浏览全部页面使用） */
interface MultiSelectProps {
  mode: 'multi';
  /** 当前选中的格式列表 */
  filterFormats: BookFormat[];
  /** 格式变化回调 */
  onFormatsChange: (formats: BookFormat[]) => void;
  filterFormat?: never;
  onSelect?: never;
}

type FormatFilterButtonProps = (SingleSelectProps | MultiSelectProps) & {
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
  canFilter?: boolean;
};

export const FormatFilterButton: React.FC<FormatFilterButtonProps> = (props) => {
  const {
    menuOpen,
    onMenuOpenChange,
    canFilter = true,
  } = props;

  const { t } = useTranslation("import");
  const isMultiMode = props.mode === 'multi';

  const handleToggleMenu: React.MouseEventHandler<HTMLButtonElement> = (e) => {
    e.stopPropagation();
    if (!canFilter) return;
    onMenuOpenChange(!menuOpen);
  };

  const allFormats = Object.keys(FORMAT_DISPLAY_NAMES) as BookFormat[];
  
  // 多选模式的状态计算
  const safeFilterFormats = isMultiMode ? (props.filterFormats ?? []) : [];
  const isAllSelectedMulti = isMultiMode && allFormats.every(fmt => safeFilterFormats.includes(fmt));
  const hasSelectionMulti = isMultiMode && safeFilterFormats.length > 0;

  // 单选模式的状态
  const isAllSelectedSingle = !isMultiMode && props.filterFormat === 'ALL';

  // 计算是否有筛选（用于图标颜色）
  const hasActiveFilter = isMultiMode 
    ? (!isAllSelectedMulti && hasSelectionMulti)
    : !isAllSelectedSingle;

  // 多选模式：切换全选/取消全选
  const toggleAllMulti = () => {
    if (!isMultiMode) return;
    if (isAllSelectedMulti) {
      props.onFormatsChange([]);
    } else {
      props.onFormatsChange([...allFormats]);
    }
  };

  // 多选模式：切换单个格式
  const toggleFormatMulti = (fmt: BookFormat) => {
    if (!isMultiMode) return;
    if (safeFilterFormats.includes(fmt)) {
      props.onFormatsChange(safeFilterFormats.filter(f => f !== fmt));
    } else {
      props.onFormatsChange([...safeFilterFormats, fmt]);
    }
  };

  // 单选模式：选择格式
  const selectFormatSingle = (fmt: 'ALL' | BookFormat) => {
    if (isMultiMode) return;
    props.onSelect(fmt);
    onMenuOpenChange(false);
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
            showMenu || hasActiveFilter ? "#f5f5f5" : "transparent",
          opacity: canFilter ? 1 : 0.3,
        }}
        onClick={handleToggleMenu}
      >
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill={hasActiveFilter && canFilter ? "#d43d3d" : "#333"}
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
            onClick={(e) => e.stopPropagation()}
          >
            <style>{`
              @keyframes fadeIn {
                from { opacity: 0; transform: scale(0.95); }
                to { opacity: 1; transform: scale(1); }
              }
            `}</style>
            
            {/* 全部格式选项 */}
            {isMultiMode ? (
              // 多选模式的全选选项
              <div
                style={{
                  padding: "10px 16px",
                  fontSize: 14,
                  color: isAllSelectedMulti ? "#d43d3d" : "#333",
                  backgroundColor: isAllSelectedMulti ? "#fffbfb" : "transparent",
                  cursor: "pointer",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  fontWeight: isAllSelectedMulti ? 500 : 400,
                }}
                onClick={toggleAllMulti}
              >
                {t("format.all")}
                {isAllSelectedMulti && (
                  <span style={{ color: "#d43d3d", fontSize: 12 }}>✓</span>
                )}
              </div>
            ) : (
              // 单选模式的全部格式选项
              <div
                style={{
                  padding: "10px 16px",
                  fontSize: 14,
                  color: props.filterFormat === 'ALL' ? "#d43d3d" : "#333",
                  backgroundColor: props.filterFormat === 'ALL' ? "#fffbfb" : "transparent",
                  cursor: "pointer",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  fontWeight: props.filterFormat === 'ALL' ? 500 : 400,
                }}
                onClick={() => selectFormatSingle('ALL')}
              >
                {t("format.all")}
                {props.filterFormat === 'ALL' && (
                  <span style={{ color: "#d43d3d", fontSize: 12 }}>✓</span>
                )}
              </div>
            )}

            {/* 各格式选项 */}
            {allFormats.map((fmt) => {
              const isChecked = isMultiMode 
                ? safeFilterFormats.includes(fmt)
                : props.filterFormat === fmt;
              
              return (
                <div
                  key={fmt}
                  style={{
                    padding: "10px 16px",
                    fontSize: 14,
                    color: isChecked ? "#d43d3d" : "#333",
                    backgroundColor: isChecked ? "#fffbfb" : "transparent",
                    cursor: "pointer",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    fontWeight: isChecked ? 500 : 400,
                  }}
                  onClick={() => isMultiMode ? toggleFormatMulti(fmt) : selectFormatSingle(fmt)}
                >
                  {getFormatDisplayName(fmt)}
                  {isChecked && (
                    <span style={{ color: "#d43d3d", fontSize: 12 }}>✓</span>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
};

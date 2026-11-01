import React from "react";
import { useTranslation } from "react-i18next";
import { getSafeAreaInsets } from "../../utils/layout";

interface SelectionActionBarProps {
  /** 是否显示「移动到」按钮（全部 Tab 为 true，最近 Tab 仅删除） */
  showMove?: boolean;
  /** 操作禁用（拖拽中或无选中项） */
  disabled?: boolean;
  /** 点击「移动到」回调 */
  onMove?: () => void;
  /** 点击「删除」回调 */
  onDelete?: () => void;
}

/**
 * 选择模式底部操作栏
 *
 * 功能描述：书架进入选择模式后，替换底部固定入口栏展示；提供「移动到」与
 *          「删除」两个批量操作按钮，固定于视口底部，背景与书架页一致，
 *          顶部以细分隔线区分内容区，自动适配底部安全区。
 *
 * 参数说明：showMove —— 是否显示「移动到」按钮（全部 Tab 为 true，最近 Tab 仅删除）；
 *          disabled —— 操作禁用标志（拖拽中或未选中任何项）；
 *          onMove —— 点击「移动到」回调；
 *          onDelete —— 点击「删除」回调。
 *
 * 返回值类型：React.FC，渲染选择模式底部固定操作栏元素。
 */
export const SelectionActionBar: React.FC<SelectionActionBarProps> = ({
  showMove = false,
  disabled = false,
  onMove,
  onDelete,
}) => {
  const { t } = useTranslation('bookshelf');

  /** 按钮通用豁免样式（绕过 App.css 全局 button 重置） */
  const btnStyle: React.CSSProperties = {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
    background: "transparent",
    border: "none",
    boxShadow: "none",
    borderRadius: 0,
    padding: "8px 0 7px",
    margin: 0,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.4 : 1,
    WebkitTapHighlightColor: "transparent",
    color: "#444",
  };

  return (
    <div
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        bottom: 0,
        display: "flex",
        alignItems: "stretch",
        background: "#fafafa",
        borderTop: "1px solid #ececec",
        paddingBottom: getSafeAreaInsets().bottom,
        zIndex: 10,
        boxSizing: "border-box",
      }}
    >
      {showMove && (
        <button
          title={t('moveTo')}
          aria-label={t('moveTo')}
          disabled={disabled}
          onClick={() => {
            if (disabled) return;
            onMove?.();
          }}
          style={btnStyle}
        >
          {/* 移动到图标：文件夹 + 右向箭头 */}
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M3.5 7C3.5 5.9 4.4 5 5.5 5H9.2C9.7 5 10.2 5.2 10.5 5.6L11.7 7H18.5C19.6 7 20.5 7.9 20.5 9V17C20.5 18.1 19.6 19 18.5 19H5.5C4.4 19 3.5 18.1 3.5 17V7Z"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinejoin="round"
            />
            <path
              d="M10.5 13h4.8m0 0l-1.9-1.9m1.9 1.9l-1.9 1.9"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span style={{ fontSize: 11, color: "#666", lineHeight: 1.2 }}>
            {t('moveTo')}
          </span>
        </button>
      )}
      <button
        title={t('selectionDelete')}
        aria-label={t('selectionDelete')}
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          onDelete?.();
        }}
        style={btnStyle}
      >
        {/* 删除图标：垃圾桶 */}
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M4 6h16M9.5 6V4.8C9.5 4.3 9.9 4 10.4 4h3.2c.5 0 .9.3.9.8V6M6.2 6l.8 12.1c.1 1 .9 1.9 2 1.9h6c1.1 0 1.9-.9 2-1.9L17.8 6"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <line x1="10" y1="10" x2="10" y2="16" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          <line x1="14" y1="10" x2="14" y2="16" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </svg>
        <span style={{ fontSize: 11, color: "#666", lineHeight: 1.2 }}>
          {t('selectionDelete')}
        </span>
      </button>
    </div>
  );
};

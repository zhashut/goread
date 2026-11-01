import React from "react";
import { useTranslation } from 'react-i18next';
import { getReaderMenuText, getReaderPageBackground } from "../../constants/readerTheme";
import type { ReaderTheme } from "../../services/formats/types";
import { getSafeAreaInsets } from "../../utils/layout";

interface TopBarProps {
  visible: boolean;
  bookTitle?: string;
  theme: ReaderTheme;
  onBack: () => void;
  isFinished?: boolean;
  onToggleFinish?: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({ visible, bookTitle, theme, onBack, isFinished, onToggleFinish }) => {
  const { t } = useTranslation('reader');

  // 去除书名中的文件后缀
  const displayTitle = bookTitle?.replace(/\.(txt|epub|pdf|mobi|azw3?|fb2|cbz|cbr|djvu|html?|md)$/i, '');

  if (!visible) return null;

  // 菜单底色与阅读页同色，前景色随主题明暗（参考主流阅读器样式）
  const menuText = getReaderMenuText(theme);

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
        backgroundColor: getReaderPageBackground(theme),
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        color: menuText,
        padding: `calc(${getSafeAreaInsets().top} + 12px) 16px 12px 16px`,
        zIndex: 12,
      }}
    >
      <div style={{ width: 80, display: 'flex', alignItems: 'center', justifyContent: 'flex-start' }}>
        <button
          onClick={onBack}
          style={{
            background: "none",
            border: "none",
            boxShadow: "none",
            borderRadius: 0,
            outline: "none",
            WebkitAppearance: "none",
            appearance: "none",
            padding: "4px",
            color: menuText,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
          }}
          title={t('back')}
        >
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: "block" }}>
            <path d="M15 5l-7 7 7 7" />
          </svg>
        </button>
      </div>

      <div
        style={{
          fontSize: "17px",
          fontWeight: 600,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          flex: 1,
          textAlign: "center",
          margin: "0 4px",
        }}
      >
        {displayTitle}
      </div>

      {/* 右侧标记已读按钮 */}
      <div
        onClick={onToggleFinish}
        style={{
          width: 80,
          display: "flex",
          alignItems: "center",
          gap: "4px",
          cursor: "pointer",
          padding: "4px 0",
          borderRadius: "4px",
          color: isFinished ? "#ff5252" : menuText,
          fontSize: "14px",
          justifyContent: "flex-end",
        }}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" style={{ fill: isFinished ? "#ff5252" : menuText, display: "block" }}>
          <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
        </svg>
        <span>{isFinished ? t('finished') : t('read')}</span>
      </div>
    </div>
  );
};

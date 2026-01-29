import React from "react";
import { useTranslation } from 'react-i18next';
import { TOP_DRAWER_RADIUS } from "../../constants/ui";
import { getSafeAreaInsets } from "../../utils/layout";

interface TopBarProps {
  visible: boolean;
  bookTitle?: string;
  onBack: () => void;
  isFinished?: boolean;
  onToggleFinish?: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({ visible, bookTitle, onBack, isFinished, onToggleFinish }) => {
  const { t } = useTranslation('reader');
  
  // 去除书名中的文件后缀
  const displayTitle = bookTitle?.replace(/\.(txt|epub|pdf|mobi|azw3?|fb2|cbz|cbr|djvu|html?|md)$/i, '');
  
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
        padding: `calc(${getSafeAreaInsets().top} + 12px) 16px 12px 16px`,
        boxShadow: "0 6px 24px rgba(0,0,0,0.35)",
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
            color: "#fff",
            cursor: "pointer",
            fontSize: "16px",
            display: "flex",
            alignItems: "center",
          }}
          title={t('back')}
        >
          {"<"}
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
          color: isFinished ? "#ff5252" : "white",
          fontSize: "14px",
          justifyContent: "flex-end",
        }}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" style={{ fill: isFinished ? "#ff5252" : "white", display: "block" }}>
          <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
        </svg>
        <span>{isFinished ? t('finished') : t('read')}</span>
      </div>
    </div>
  );
};

import React from "react";
import { useTranslation } from 'react-i18next';
import { BOTTOM_DRAWER_RADIUS, READER_FLOAT_BUTTON_EDGE_OFFSET, READER_FONT_CONTROL_TOP, READER_LISTEN_BUTTON_SIZE, READER_LISTEN_ICON_SIZE, READER_THEME_BUTTON_SIZE, READER_THEME_ICON_SIZE } from "../../constants/ui";
import type { ReaderTheme } from "../../services/formats/types";
import { ThemeSunIcon } from "../covers/ThemeSunIcon";
import { ThemeMoonIcon } from "../covers/ThemeMoonIcon";
import { ListenIcon } from "../covers/ListenIcon";
import { FontSizeControl } from "./FontSizeControl";

interface BottomBarProps {
  visible: boolean;
  currentPage: number;
  totalPages: number;
  isSeeking: boolean;
  seekPage: number | null;
  readingMode: "horizontal" | "vertical";
  autoScroll: boolean;
  tocOverlayOpen: boolean;
  modeOverlayOpen: boolean;
  moreDrawerOpen: boolean;
  theme: ReaderTheme;
  themeSupported: boolean;
  onToggleTheme?: () => void;
  /** 听书功能是否可用（控制按钮是否渲染） */
  listenSupported?: boolean;
  /** 当前是否处于听书状态 */
  isListening?: boolean;
  /** 切换听书状态的回调 */
  onToggleListen?: () => void;
  fontSizeSupported?: boolean;
  fontSize?: number;
  onIncreaseFontSize?: () => void;
  onDecreaseFontSize?: () => void;
  onSetFontSizeByRatio?: (ratio: number) => void;
  
  onSeekStart: () => void;
  onSeekChange: (val: number) => void;
  onSeekEnd: (val: number) => void;
  onPrevChapter: () => void;
  onNextChapter: () => void;
  onToggleToc: () => void;
  onToggleMode: () => void;
  onToggleAutoScroll: () => void;
  onAddBookmark: () => void;
  onOpenMore: () => void;
}

export const BottomBar: React.FC<BottomBarProps> = ({
  visible,
  currentPage,
  totalPages,
  isSeeking,
  seekPage,
  readingMode,
  autoScroll,
  tocOverlayOpen,
  modeOverlayOpen,
  moreDrawerOpen,
  theme,
  themeSupported,
  onToggleTheme,
  listenSupported,
  isListening,
  onToggleListen,
  fontSizeSupported,
  fontSize,
  onIncreaseFontSize,
  onDecreaseFontSize,
  onSetFontSizeByRatio,
  onSeekStart,
  onSeekChange,
  onSeekEnd,
  onPrevChapter,
  onNextChapter,
  onToggleToc,
  onToggleMode,
  onToggleAutoScroll,
  onAddBookmark,
  onOpenMore,
}) => {
  const { t } = useTranslation('reader');
  
  if (!visible) return null;

  return (
    <div
      data-overlay-state={modeOverlayOpen || moreDrawerOpen ? 'open' : 'closed'}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseUp={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
      onTouchEnd={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        transform: "none",
        // 固定到底部
        bottom: 0,
        boxSizing: "border-box",
        backgroundColor: "rgba(26,26,26,0.92)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        color: "white",
        borderRadius: `${BOTTOM_DRAWER_RADIUS}px ${BOTTOM_DRAWER_RADIUS}px 0 0`,
        paddingTop: "14px",
        paddingLeft: "18px",
        paddingRight: "18px",
        paddingBottom: "14px",
        boxShadow: "0 6px 24px rgba(0,0,0,0.35)",
        zIndex: 10,
      }}
    >
      {/* 听书悬浮按钮（位于主题按钮上方） */}
      {listenSupported && onToggleListen && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleListen();
          }}
          style={{
            position: "absolute",
            right: READER_FLOAT_BUTTON_EDGE_OFFSET,
            top: -138,
            width: READER_LISTEN_BUTTON_SIZE,
            height: READER_LISTEN_BUTTON_SIZE,
            borderRadius: `${READER_LISTEN_BUTTON_SIZE / 2}px`,
            border: isListening ? "1px solid #5a3a3a" : "none",
            outline: "none",
            backgroundColor: "#1f1f1f",
            boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#ffffff",
            cursor: "pointer",
          }}
        >
          <ListenIcon size={READER_LISTEN_ICON_SIZE} isActive={isListening} />
        </button>
      )}
      {/* 主题切换悬浮按钮 */}
      {themeSupported && onToggleTheme && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleTheme();
          }}
          style={{
            position: "absolute",
            right: READER_FLOAT_BUTTON_EDGE_OFFSET,
            top: READER_FONT_CONTROL_TOP,
            width: READER_THEME_BUTTON_SIZE,
            height: READER_THEME_BUTTON_SIZE,
            borderRadius: `${READER_THEME_BUTTON_SIZE / 2}px`,
            border: "none",
            outline: "none",
            backgroundColor: "#1f1f1f",
            boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#ffffff",
            cursor: "pointer",
          }}
        >
          {theme === "dark" ? (
            <ThemeSunIcon size={READER_THEME_ICON_SIZE} />
          ) : (
            <ThemeMoonIcon size={READER_THEME_ICON_SIZE} />
          )}
        </button>
      )}

      {fontSizeSupported &&
        typeof fontSize === "number" &&
        onIncreaseFontSize &&
        onDecreaseFontSize &&
        onSetFontSizeByRatio && (
          <FontSizeControl
            visible
            fontSize={fontSize}
            onIncrease={onIncreaseFontSize}
            onDecrease={onDecreaseFontSize}
            onSetByRatio={onSetFontSizeByRatio}
          />
        )}
      {/* 上方进度滑条 + 两端上一章/下一章文案 */}
      <div
        style={{
          width: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "stretch",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: "clamp(10px, 1.6vw, 12px)",
            color: "#bbb",
            marginBottom: "8px",
          }}
        >
          <span
            onClick={onPrevChapter}
            style={{
              cursor: currentPage <= 1 ? "default" : "pointer",
              opacity: currentPage <= 1 ? 0.5 : 1,
            }}
          >
            {t('prevChapter')}
          </span>
          <span
            onClick={onNextChapter}
            style={{
              cursor: currentPage >= totalPages ? "default" : "pointer",
              opacity: currentPage >= totalPages ? 0.5 : 1,
            }}
          >
            {t('nextChapter')}
          </span>
        </div>
        {(() => {
          const sliderVal =
            isSeeking && seekPage !== null ? seekPage : currentPage;
          const pct = Math.max(
            0,
            Math.min(
              100,
              Math.round((sliderVal / Math.max(1, totalPages)) * 100)
            )
          );
          const track = `linear-gradient(to right, #d15158 0%, #d15158 ${pct}%, #3a3a3a ${pct}%, #3a3a3a 100%)`;
          return (
            <input
              className="reader-range"
              type="range"
              min={1}
              max={totalPages}
              value={sliderVal}
              onMouseDown={(e) => {
                e.stopPropagation();
                onSeekStart();
              }}
              onTouchStart={(e) => {
                e.stopPropagation();
                onSeekStart();
              }}
              onInput={(e) => {
                const v = Number((e.target as HTMLInputElement).value);
                onSeekChange(v);
              }}
              onMouseUp={(e) => {
                e.stopPropagation();
                const v = Number((e.target as HTMLInputElement).value);
                onSeekEnd(v);
              }}
              onTouchEnd={(e) => {
                e.stopPropagation();
                const v = Number((e.target as HTMLInputElement).value);
                onSeekEnd(v);
              }}
              style={{
                width: "100%",
                height: "6px",
                borderRadius: "6px",
                background: track,
                outline: "none",
              }}
            />
          );
        })()}
      </div>
      {/* 下方图标操作区：5等分网格，窄屏也不拥挤 */}
      <div
        style={{
          marginTop: "14px",
          display: "grid",
          gridTemplateColumns: "repeat(5, 1fr)",
          alignItems: "center",
          justifyItems: "center",
          width: "100%",
          gap: "8px",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
          }}
        >
          <button
            onClick={onToggleToc}
            style={{
              background: "none",
              border: "none",
              boxShadow: "none",
              borderRadius: 0,
              outline: "none",
              WebkitAppearance: "none",
              appearance: "none",
              color: tocOverlayOpen ? "#d15158" : "#fff",
              cursor: "pointer",
              fontSize: "clamp(16px, 3.2vw, 18px)",
            }}
            title={t('toc')}
          >
            ≡
          </button>
          <div
            style={{
              fontSize: "clamp(10px, 1.6vw, 12px)",
              color: tocOverlayOpen ? "#d15158" : "#ccc",
              marginTop: "6px",
            }}
          >
            {t('toc')}
          </div>
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
          }}
        >
          <button
            onClick={onToggleMode}
            style={{
              background: "none",
              border: "none",
              boxShadow: "none",
              borderRadius: 0,
              outline: "none",
              WebkitAppearance: "none",
              appearance: "none",
              color: "#fff",
              cursor: "pointer",
              fontSize: "clamp(16px, 3.2vw, 18px)",
            }}
            title={t('readingMode')}
          >
            {readingMode === "horizontal" ? "▤" : "▮"}
          </button>
          <div
            style={{
              fontSize: "clamp(10px, 1.6vw, 12px)",
              color: "#ccc",
              marginTop: "6px",
            }}
          >
            {t('readingMode')}
          </div>
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
          }}
        >
          <button
            onClick={onToggleAutoScroll}
            style={{
              background: "none",
              border: "none",
              boxShadow: "none",
              borderRadius: 0,
              outline: "none",
              WebkitAppearance: "none",
              appearance: "none",
              color: autoScroll ? "#d15158" : "#fff",
              cursor: "pointer",
              fontSize: "clamp(16px, 3.2vw, 18px)",
            }}
            title={readingMode === "horizontal" ? t('autoFlip') : t('autoScroll')}
          >
            ☰
          </button>
          <div
            style={{
              fontSize: "clamp(10px, 1.6vw, 12px)",
              color: autoScroll ? "#d15158" : "#ccc",
              marginTop: "6px",
            }}
          >
            {readingMode === "horizontal" ? t('autoFlip') : t('autoScroll')}
          </div>
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
          }}
        >
          <button
            onClick={onAddBookmark}
            style={{
              background: "none",
              border: "none",
              boxShadow: "none",
              borderRadius: 0,
              outline: "none",
              WebkitAppearance: "none",
              appearance: "none",
              color: "#fff",
              cursor: "pointer",
              fontSize: "clamp(16px, 3.2vw, 18px)",
            }}
            title={t('bookmark')}
          >
            🔖
          </button>
          <div
            style={{
              fontSize: "clamp(10px, 1.6vw, 12px)",
              color: "#ccc",
              marginTop: "6px",
            }}
          >
            {t('bookmark')}
          </div>
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
          }}
        >
          <button
            onClick={onOpenMore}
            style={{
              background: "none",
              border: "none",
              boxShadow: "none",
              borderRadius: 0,
              outline: "none",
              WebkitAppearance: "none",
              appearance: "none",
              color: "#fff",
              cursor: "pointer",
              fontSize: "clamp(16px, 3.2vw, 18px)",
            }}
            title={t('more')}
          >
            …
          </button>
          <div
            style={{
              fontSize: "clamp(10px, 1.6vw, 12px)",
              color: "#ccc",
              marginTop: "6px",
            }}
          >
            {t('more')}
          </div>
        </div>
      </div>
    </div>
  );
};

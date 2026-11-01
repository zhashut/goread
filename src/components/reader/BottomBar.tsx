import React from "react";
import { useTranslation } from 'react-i18next';
import {
  READER_FLOAT_BUTTON_EDGE_OFFSET,
  READER_FONT_CONTROL_TOP,
  READER_LISTEN_BUTTON_SIZE,
  READER_LISTEN_ICON_SIZE,
  READER_THEME_BUTTON_SIZE,
  READER_THEME_ICON_SIZE,
} from "../../constants/ui";
import {
  getReaderMenuIconChip,
  getReaderMenuSliderTrack,
  getReaderMenuText,
  getReaderPageBackground,
} from "../../constants/readerTheme";
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

/** 菜单图标芯片尺寸（圆角方形底，参考主流阅读器样式） */
const MENU_CHIP_SIZE = 42;
const MENU_CHIP_RADIUS = 12;
const MENU_ICON_SIZE = 20;
/** 激活态芯片底色（与全局强调色一致） */
const MENU_ACCENT = "#d15158";

/** 目录图标（三条横线） */
const TocGlyph: React.FC = () => (
  <svg viewBox="0 0 24 24" width={MENU_ICON_SIZE} height={MENU_ICON_SIZE} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ display: "block" }}>
    <path d="M4 6h16M4 12h16M4 18h10" />
  </svg>
);

/** 阅读模式图标：横屏双栏 / 竖屏单栏 */
const ModeGlyph: React.FC<{ horizontal: boolean }> = ({ horizontal }) => (
  <svg viewBox="0 0 24 24" width={MENU_ICON_SIZE} height={MENU_ICON_SIZE} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" style={{ display: "block" }}>
    {horizontal ? (
      <>
        <rect x="3.5" y="5" width="7.5" height="14" rx="1.5" />
        <rect x="13" y="5" width="7.5" height="14" rx="1.5" />
      </>
    ) : (
      <rect x="8" y="4.5" width="8" height="15" rx="1.5" />
    )}
  </svg>
);

/** 自动滚屏/自动翻页图标（向下双箭头） */
const AutoScrollGlyph: React.FC = () => (
  <svg viewBox="0 0 24 24" width={MENU_ICON_SIZE} height={MENU_ICON_SIZE} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: "block" }}>
    <path d="M6 6l6 6 6-6M6 13l6 6 6-6" />
  </svg>
);

/** 书签图标（实心书签形） */
const BookmarkGlyph: React.FC = () => (
  <svg viewBox="0 0 24 24" width={MENU_ICON_SIZE} height={MENU_ICON_SIZE} fill="currentColor" style={{ display: "block" }}>
    <path d="M7 3.5h10a1.5 1.5 0 0 1 1.5 1.5v15.6a.6.6 0 0 1-.95.49L12 16.9l-5.55 4.19a.6.6 0 0 1-.95-.49V5A1.5 1.5 0 0 1 7 3.5z" />
  </svg>
);

/** 更多图标（横向三点） */
const MoreGlyph: React.FC = () => (
  <svg viewBox="0 0 24 24" width={MENU_ICON_SIZE} height={MENU_ICON_SIZE} fill="currentColor" style={{ display: "block" }}>
    <circle cx="5" cy="12" r="1.8" />
    <circle cx="12" cy="12" r="1.8" />
    <circle cx="19" cy="12" r="1.8" />
  </svg>
);

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

  // 菜单底色与阅读页同色，前景色随主题明暗（参考主流阅读器样式）
  const menuText = getReaderMenuText(theme);
  const chipBg = getReaderMenuIconChip(theme);
  const sliderTrack = getReaderMenuSliderTrack(theme);
  const sliderVal = isSeeking && seekPage !== null ? seekPage : currentPage;
  const atStart = currentPage <= 1;
  const atEnd = currentPage >= totalPages;

  /** 生成一个「圆角方形芯片 + 下方文字」的菜单按钮 */
  const renderChipButton = (
    key: string,
    label: string,
    active: boolean,
    glyph: React.ReactNode,
    onClick: () => void
  ) => (
    <div
      key={key}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "7px",
      }}
    >
      <button
        onClick={onClick}
        style={{
          width: MENU_CHIP_SIZE,
          height: MENU_CHIP_SIZE,
          borderRadius: `${MENU_CHIP_RADIUS}px`,
          border: "none",
          outline: "none",
          WebkitAppearance: "none",
          appearance: "none",
          backgroundColor: active ? MENU_ACCENT : chipBg,
          color: "#ffffff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
          padding: 0,
        }}
        title={label}
      >
        {glyph}
      </button>
      <div style={{ fontSize: "clamp(10px, 1.6vw, 12px)", color: active ? MENU_ACCENT : menuText, lineHeight: 1 }}>
        {label}
      </div>
    </div>
  );

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
        backgroundColor: getReaderPageBackground(theme),
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        color: menuText,
        paddingTop: "16px",
        paddingLeft: "18px",
        paddingRight: "18px",
        paddingBottom: "16px",
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
      {/* 进度行：上一章 | 滑条 | 下一章（同一行，参考主流阅读器样式） */}
      <div
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: "14px",
        }}
      >
        <span
          onClick={onPrevChapter}
          style={{
            cursor: atStart ? "default" : "pointer",
            opacity: atStart ? 0.4 : 1,
            fontSize: "clamp(12px, 2vw, 14px)",
            whiteSpace: "nowrap",
          }}
        >
          {t('prevChapter')}
        </span>
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
            flex: 1,
            minWidth: 0,
            height: "4px",
            borderRadius: "4px",
            background: sliderTrack,
            outline: "none",
          }}
        />
        <span
          onClick={onNextChapter}
          style={{
            cursor: atEnd ? "default" : "pointer",
            opacity: atEnd ? 0.4 : 1,
            fontSize: "clamp(12px, 2vw, 14px)",
            whiteSpace: "nowrap",
          }}
        >
          {t('nextChapter')}
        </span>
      </div>
      {/* 下方图标操作区：圆角方形芯片 + 下方文字，5等分网格，窄屏也不拥挤 */}
      <div
        style={{
          marginTop: "16px",
          display: "grid",
          gridTemplateColumns: "repeat(5, 1fr)",
          alignItems: "center",
          justifyItems: "center",
          width: "100%",
          gap: "8px",
        }}
      >
        {renderChipButton("toc", t('toc'), tocOverlayOpen, <TocGlyph />, onToggleToc)}
        {renderChipButton(
          "mode",
          t('readingMode'),
          false,
          <ModeGlyph horizontal={readingMode === "horizontal"} />,
          onToggleMode
        )}
        {renderChipButton(
          "auto",
          readingMode === "horizontal" ? t('autoFlip') : t('autoScroll'),
          autoScroll,
          <AutoScrollGlyph />,
          onToggleAutoScroll
        )}
        {renderChipButton("bookmark", t('bookmark'), false, <BookmarkGlyph />, onAddBookmark)}
        {renderChipButton("more", t('more'), false, <MoreGlyph />, onOpenMore)}
      </div>
    </div>
  );
};

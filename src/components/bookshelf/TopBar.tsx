import React, { useState, useRef, useLayoutEffect } from "react";
import { useTranslation } from "react-i18next";
import { BookshelfTab } from "../../types";
import {
  TOP_BAR_ICON_SIZE,
  TOP_BAR_TAB_FONT_SIZE,
  TOP_BAR_MARGIN_BOTTOM,
  TOP_BAR_TAB_PADDING_BOTTOM,
  TOP_BAR_ICON_GAP,
} from "../../constants/ui";

/** 顶栏标题字号（px） */
const TOP_BAR_TITLE_FONT_SIZE = 20;
/** ⋯下拉菜单项高度（px） */
const MORE_MENU_ITEM_HEIGHT = 44;
/** ⋯下拉菜单最小宽度（px） */
const MORE_MENU_MIN_WIDTH = 148;
/** 菜单图标颜色：创建分类（灰黑） */
const MENU_ICON_COLOR_NEUTRAL = "#666";
/** 菜单图标颜色：移动/删除（蓝） */
const MENU_ICON_COLOR_BLUE = "#4A90D9";
/** 菜单图标颜色：列表/网格模式（近黑） */
const MENU_ICON_COLOR_DARK = "#333";

/** 书架视图模式：网格 / 列表 */
export type BookshelfViewMode = "grid" | "list";

interface TopBarProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "mode"> {
  /** Current mode: "default" (Tabs) or "selection" (Selection Mode) */
  mode: "default" | "selection";

  // --- Default Mode Props ---
  activeTab?: BookshelfTab;
  onTabChange?: (tab: BookshelfTab) => void;
  onSearch?: () => void;
  /** ⋯菜单：创建分类 */
  onCreateCategory?: () => void;
  /** ⋯菜单：移动文件（进入选择模式） */
  onMoveFiles?: () => void;
  /** ⋯菜单：删除文件（进入选择模式） */
  onDeleteFiles?: () => void;
  /** 当前视图模式（控制菜单「列表模式/网格模式」文案与图标） */
  viewMode?: BookshelfViewMode;
  /** ⋯菜单：切换列表/网格模式 */
  onToggleViewMode?: () => void;
  /** 动态 NAS 页签列表（每项对应一条 NAS 连接，tab id 为 nas:<连接id>） */
  nasTabs?: { id: string; name: string }[];

  // --- Selection Mode Props ---
  selectedCount?: number;
  onExitSelection?: () => void;
  /** Custom actions for the right side in selection mode (e.g., Select All) */
  selectionActions?: React.ReactNode;
}

/**
 * ⋯菜单项：创建分类（文件夹+图标，灰黑）
 * @param color 图标颜色
 * @returns 文件夹加号 SVG 节点
 */
const CreateCategoryIcon = ({ color }: { color: string }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M3.5 6.5C3.5 5.4 4.4 4.5 5.5 4.5H9.3C9.8 4.5 10.3 4.7 10.6 5.1L11.8 6.5H18.5C19.6 6.5 20.5 7.4 20.5 8.5V17.5C20.5 18.6 19.6 19.5 18.5 19.5H5.5C4.4 19.5 3.5 18.6 3.5 17.5V6.5Z"
      stroke={color}
      strokeWidth="1.8"
      strokeLinejoin="round"
    />
    <line x1="12" y1="10.5" x2="12" y2="15.5" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
    <line x1="9.5" y1="13" x2="14.5" y2="13" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

/**
 * ⋯菜单项：移动文件（蓝色文件夹）
 * @param color 图标颜色
 * @returns 蓝色文件夹 SVG 节点
 */
const MoveFilesIcon = ({ color }: { color: string }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill={color} xmlns="http://www.w3.org/2000/svg">
    <path d="M3.5 7C3.5 5.9 4.4 5 5.5 5H9.2C9.7 5 10.2 5.2 10.5 5.6L11.7 7H18.5C19.6 7 20.5 7.9 20.5 9V17C20.5 18.1 19.6 19 18.5 19H5.5C4.4 19 3.5 18.1 3.5 17V7Z" />
    <path d="M10 13h5.2m0 0l-2-2m2 2l-2 2" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
  </svg>
);

/**
 * ⋯菜单项：删除文件（蓝色垃圾桶）
 * @param color 图标颜色
 * @returns 蓝色垃圾桶 SVG 节点
 */
const DeleteFilesIcon = ({ color }: { color: string }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M4 6h16M9.5 6V4.8C9.5 4.3 9.9 4 10.4 4h3.2c.5 0 .9.3.9.8V6M6.2 6l.8 12.1c.1 1 .9 1.9 2 1.9h6c1.1 0 1.9-.9 2-1.9L17.8 6"
      stroke={color}
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <line x1="10" y1="10" x2="10" y2="16" stroke={color} strokeWidth="1.7" strokeLinecap="round" />
    <line x1="14" y1="10" x2="14" y2="16" stroke={color} strokeWidth="1.7" strokeLinecap="round" />
  </svg>
);

/**
 * ⋯菜单项：列表模式（横向列表图标）
 * @param color 图标颜色
 * @returns 列表图标 SVG 节点
 */
const ListModeIcon = ({ color }: { color: string }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <line x1="4" y1="6.5" x2="20" y2="6.5" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
    <line x1="4" y1="12" x2="20" y2="12" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
    <line x1="4" y1="17.5" x2="20" y2="17.5" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
    <circle cx="4" cy="6.5" r="0.9" fill={color} />
    <circle cx="4" cy="12" r="0.9" fill={color} />
    <circle cx="4" cy="17.5" r="0.9" fill={color} />
  </svg>
);

/**
 * ⋯菜单项：网格模式（四宫格图标）
 * @param color 图标颜色
 * @returns 网格图标 SVG 节点
 */
const GridModeIcon = ({ color }: { color: string }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="4" y="4" width="7" height="7" rx="1.5" stroke={color} strokeWidth="1.8" />
    <rect x="13" y="4" width="7" height="7" rx="1.5" stroke={color} strokeWidth="1.8" />
    <rect x="4" y="13" width="7" height="7" rx="1.5" stroke={color} strokeWidth="1.8" />
    <rect x="13" y="13" width="7" height="7" rx="1.5" stroke={color} strokeWidth="1.8" />
  </svg>
);

export const TopBar: React.FC<TopBarProps> = (props) => {
  const { t } = useTranslation('bookshelf');
  const { t: tc } = useTranslation('common');
  const {
    mode,
    activeTab = "recent",
    onTabChange,
    onSearch,
    onCreateCategory,
    onMoveFiles,
    onDeleteFiles,
    viewMode = "grid",
    onToggleViewMode,
    nasTabs = [],
    selectedCount = 0,
    onExitSelection,
    selectionActions,
    ...rest
  } = props;
  const { className, style, ...divProps } = rest;
  // --- ⋯菜单开关状态 ---
  const [menuOpen, setMenuOpen] = useState(false);
  // --- Tab Underline Logic (Default Mode) ---
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const recentLabelRef = useRef<HTMLDivElement | null>(null);
  const allLabelRef = useRef<HTMLDivElement | null>(null);
  // 动态 NAS 页签文字节点引用表：key 为连接 id（tab id 形如 nas:<id>，数量可变，无法用静态 ref）
  const nasLabelRefsRef = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const [underlinePos, setUnderlinePos] = useState<{
    left: number;
    width: number;
  }>({ left: 0, width: 0 });
  const [animateUnderline, setAnimateUnderline] = useState(false);
  const [underlineReady, setUnderlineReady] = useState(false);

  const updateUnderline = () => {
    if (mode !== "default") return;
    // 按当前页签定位对应文字节点（recent / all / nas:<连接id> 动态页签）
    let target: HTMLDivElement | null = null;
    if (activeTab === "recent") {
      target = recentLabelRef.current;
    } else if (activeTab === "all") {
      target = allLabelRef.current;
    } else if (activeTab.startsWith("nas:")) {
      target = nasLabelRefsRef.current.get(activeTab.slice(4)) ?? null;
    }
    if (!target || !tabsRef.current) return;
    const tabsRect = tabsRef.current.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    // 页签容器可横向滚动，需叠加 scrollLeft 修正下划线偏移
    setUnderlinePos({
      left: rect.left - tabsRect.left + tabsRef.current.scrollLeft,
      width: rect.width,
    });
    setUnderlineReady(true);
  };

  // activeTab / nasTabs 变化（切换页签、新增或删除连接）时重新定位下划线
  useLayoutEffect(() => {
    if (mode === "default") {
      updateUnderline();
      window.addEventListener("resize", updateUnderline);
      return () => window.removeEventListener("resize", updateUnderline);
    }
  }, [activeTab, mode, nasTabs]);

  // Ensure underline position is correct on mount
  useLayoutEffect(() => {
    if (mode === "default") {
      updateUnderline();
      requestAnimationFrame(updateUnderline);
    }
  }, [mode]);

  if (mode === "selection") {
    return (
      <div
        className={className}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: `${TOP_BAR_MARGIN_BOTTOM}px`,
          ...style,
        }}
        {...divProps}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            position: "relative",
            paddingBottom: `${TOP_BAR_TAB_PADDING_BOTTOM}px`,
          }}
        >
          <button
            aria-label={tc('back')}
            onClick={onExitSelection}
            style={{
              background: "none",
              border: "none",
              boxShadow: "none",
              borderRadius: 0,
              cursor: "pointer",
              padding: 0,
              marginLeft: "-6px",
            }}
          >
            <svg
              width={TOP_BAR_ICON_SIZE}
              height={TOP_BAR_ICON_SIZE}
              viewBox="0 0 24 24"
              fill="none"
            >
              <path
                d="M14 18l-6-6 6-6"
                stroke="#333"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <span
            style={{
              fontSize: TOP_BAR_TAB_FONT_SIZE,
              color: "#333",
              marginLeft: 8,
              fontWeight: 600,
              display: "inline-flex",
              alignItems: "center",
              height: TOP_BAR_ICON_SIZE + "px",
              lineHeight: TOP_BAR_ICON_SIZE + "px",
              transform: "translateY(-2px)",
            }}
          >
            {tc('selected', { count: selectedCount })}
          </span>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            position: "relative",
            gap: `${TOP_BAR_ICON_GAP}px`,
          }}
        >
          {selectionActions}
        </div>
      </div>
    );
  }

  return (
    <div
      className={className}
      style={{
        marginBottom: `${TOP_BAR_MARGIN_BOTTOM}px`,
        ...style,
      }}
      {...divProps}
    >
      {/* 第一行：居中标题「书架」+ 右侧搜索与⋯菜单图标 */}
      <div
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: `${TOP_BAR_ICON_SIZE}px`,
        }}
      >
        <div
          style={{
            fontSize: `${TOP_BAR_TITLE_FONT_SIZE}px`,
            fontWeight: 600,
            color: "#000",
            lineHeight: `${TOP_BAR_ICON_SIZE}px`,
          }}
        >
          {t('bookshelf')}
        </div>
        <div
          style={{
            position: "absolute",
            right: 0,
            top: 0,
            height: "100%",
            display: "flex",
            alignItems: "center",
            gap: `${TOP_BAR_ICON_GAP}px`,
          }}
        >
          <button
            title={tc('search')}
            aria-label={tc('search')}
            onClick={onSearch}
            style={{
              background: "transparent",
              border: "none",
              padding: 0,
              margin: 0,
              cursor: "pointer",
              color: "#333",
              WebkitAppearance: "none",
              appearance: "none",
              outline: "none",
              boxShadow: "none",
              borderRadius: 0,
              display: "inline-flex",
              alignItems: "center",
            }}
          >
            <svg
              width={TOP_BAR_ICON_SIZE}
              height={TOP_BAR_ICON_SIZE}
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <circle cx="11" cy="11" r="7" stroke="#333" strokeWidth="2" />
              <line
                x1="20"
                y1="20"
                x2="16.5"
                y2="16.5"
                stroke="#333"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
          <button
            title={t('more')}
            aria-label={t('more')}
            onClick={() => setMenuOpen((v) => !v)}
            style={{
              background: "transparent",
              border: "none",
              padding: 0,
              margin: 0,
              cursor: "pointer",
              color: "#333",
              WebkitAppearance: "none",
              appearance: "none",
              outline: "none",
              boxShadow: "none",
              borderRadius: 0,
              display: "inline-flex",
              alignItems: "center",
            }}
          >
            <svg
              width={TOP_BAR_ICON_SIZE}
              height={TOP_BAR_ICON_SIZE}
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <circle cx="5" cy="12" r="1.9" fill="#333" />
              <circle cx="12" cy="12" r="1.9" fill="#333" />
              <circle cx="19" cy="12" r="1.9" fill="#333" />
            </svg>
          </button>
        </div>

        {/* ⋯下拉菜单：创建分类 / 移动文件 / 删除文件 / 列表(网格)模式 */}
        {menuOpen && (
          <>
            {/* 全屏透明遮罩：点击空白处关闭菜单 */}
            <div
              onClick={() => setMenuOpen(false)}
              style={{
                position: "fixed",
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                zIndex: 1000,
              }}
            />
            <div
              style={{
                position: "absolute",
                top: `calc(100% + 8px)`,
                right: 0,
                minWidth: `${MORE_MENU_MIN_WIDTH}px`,
                background: "#fff",
                borderRadius: 12,
                boxShadow: "0 6px 24px rgba(0,0,0,0.14), 0 0 0 1px rgba(0,0,0,0.03)",
                padding: "4px 0",
                zIndex: 1001,
                overflow: "hidden",
              }}
            >
              {[
                {
                  key: "createCategory",
                  label: t('createCategory'),
                  icon: <CreateCategoryIcon color={MENU_ICON_COLOR_NEUTRAL} />,
                  onClick: onCreateCategory,
                },
                {
                  key: "moveFiles",
                  label: t('moveFiles'),
                  icon: <MoveFilesIcon color={MENU_ICON_COLOR_BLUE} />,
                  onClick: onMoveFiles,
                },
                {
                  key: "deleteFiles",
                  label: t('deleteFiles'),
                  icon: <DeleteFilesIcon color={MENU_ICON_COLOR_BLUE} />,
                  onClick: onDeleteFiles,
                },
                {
                  key: "viewMode",
                  label: viewMode === "grid" ? t('listMode') : t('gridMode'),
                  icon:
                    viewMode === "grid" ? (
                      <ListModeIcon color={MENU_ICON_COLOR_DARK} />
                    ) : (
                      <GridModeIcon color={MENU_ICON_COLOR_DARK} />
                    ),
                  onClick: onToggleViewMode,
                },
              ].map((item) => (
                <button
                  key={item.key}
                  onClick={() => {
                    setMenuOpen(false);
                    item.onClick?.();
                  }}
                  disabled={!item.onClick}
                  style={{
                    width: "100%",
                    height: `${MORE_MENU_ITEM_HEIGHT}px`,
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "0 16px",
                    background: "transparent",
                    border: "none",
                    boxShadow: "none",
                    borderRadius: 0,
                    cursor: item.onClick ? "pointer" : "default",
                    boxSizing: "border-box",
                    textAlign: "left",
                  }}
                >
                  <span
                    style={{
                      width: 20,
                      height: 20,
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                    }}
                  >
                    {item.icon}
                  </span>
                  <span style={{ fontSize: 14, color: "#333" }}>{item.label}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {/* 第二行：最近/本地/动态 NAS 选项卡（左对齐 + 下划线动画，超出时可横向滚动） */}
      <div
        ref={tabsRef}
        className="no-scrollbar"
        style={{
          display: "flex",
          alignItems: "flex-end",
          position: "relative",
          paddingBottom: `${TOP_BAR_TAB_PADDING_BOTTOM}px`,
          marginTop: "10px",
          overflowX: "auto",
        }}
      >
        <button
          onClick={() => {
            if (activeTab !== "recent") {
              onTabChange?.("recent");
              setAnimateUnderline(true);
            }
          }}
          style={{
            background: "transparent",
            border: "none",
            padding: 0,
            cursor: "pointer",
            boxShadow: "none",
            borderRadius: 0,
            marginRight: "15px",
            flexShrink: 0,
          }}
          title={t('recent')}
        >
          <div
            ref={recentLabelRef}
            style={{
              fontSize: TOP_BAR_TAB_FONT_SIZE + "px",
              color: activeTab === "recent" ? "#000" : "#bbb",
              transition: "color 200ms ease",
            }}
          >
            {t('recent')}
          </div>
        </button>
        <button
          onClick={() => {
            if (activeTab !== "all") {
              onTabChange?.("all");
              setAnimateUnderline(true);
            }
          }}
          style={{
            background: "transparent",
            border: "none",
            padding: 0,
            cursor: "pointer",
            boxShadow: "none",
            borderRadius: 0,
            marginRight: "15px",
            flexShrink: 0,
          }}
          title={t('all')}
        >
          <div
            ref={allLabelRef}
            style={{
              fontSize: TOP_BAR_TAB_FONT_SIZE + "px",
              color: activeTab === "all" ? "#000" : "#bbb",
              transition: "color 200ms ease",
            }}
          >
            {t('all')}
          </div>
        </button>
        {/* 动态 NAS 页签：每个连接一个页签，名称与添加连接时的连接名保持一致 */}
        {nasTabs.map((conn) => {
          const tabId = `nas:${conn.id}` as BookshelfTab;
          return (
            <button
              key={conn.id}
              onClick={() => {
                if (activeTab !== tabId) {
                  onTabChange?.(tabId);
                  setAnimateUnderline(true);
                }
              }}
              style={{
                background: "transparent",
                border: "none",
                padding: 0,
                cursor: "pointer",
                boxShadow: "none",
                borderRadius: 0,
                flexShrink: 0,
              }}
              title={conn.name}
            >
              <div
                ref={(el) => {
                  nasLabelRefsRef.current.set(conn.id, el);
                }}
                style={{
                  fontSize: TOP_BAR_TAB_FONT_SIZE + "px",
                  color: activeTab === tabId ? "#000" : "#bbb",
                  transition: "color 200ms ease",
                }}
              >
                {conn.name}
              </div>
            </button>
          );
        })}
        <div
          style={{
            position: "absolute",
            bottom: 0,
            left: underlinePos.left,
            width: underlinePos.width,
            height: "3px",
            backgroundColor: "#d15158",
            transition: animateUnderline
              ? "left 250ms ease, width 250ms ease"
              : "none",
            opacity: underlineReady ? 1 : 0,
          }}
        />
      </div>
    </div>
  );
};

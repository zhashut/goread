import React, {
  useState,
  useRef,
  useLayoutEffect,
  useEffect,
} from "react";
import {
  TOP_BAR_ICON_SIZE,
  TOP_BAR_TAB_FONT_SIZE,
  TOP_BAR_MARGIN_BOTTOM,
  TOP_BAR_TAB_PADDING_BOTTOM,
  TOP_BAR_ICON_GAP,
} from "../constants/ui";

interface BookshelfTopBarProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "mode"> {
  /** Current mode: "default" (Tabs) or "selection" (Selection Mode) */
  mode: "default" | "selection";

  // --- Default Mode Props ---
  activeTab?: "recent" | "all";
  onTabChange?: (tab: "recent" | "all") => void;
  onSearch?: () => void;
  /** Callback for menu actions */
  onMenuAction?: (action: "import" | "settings" | "statistics" | "about") => void;
  /** Callback when menu open state changes (e.g. to block gestures) */
  onMenuOpenChange?: (open: boolean) => void;

  // --- Selection Mode Props ---
  selectedCount?: number;
  onExitSelection?: () => void;
  /** Custom actions for the right side in selection mode (e.g., Delete, Select All) */
  selectionActions?: React.ReactNode;
}

export const BookshelfTopBar: React.FC<BookshelfTopBarProps> = (props) => {
  const {
    mode,
    activeTab = "recent",
    onTabChange,
    onSearch,
    onMenuAction,
    onMenuOpenChange,
    selectedCount = 0,
    onExitSelection,
    selectionActions,
    ...rest
  } = props;
  const { className, style, ...divProps } = rest;
  // --- Tab Underline Logic (Default Mode) ---
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const recentLabelRef = useRef<HTMLDivElement | null>(null);
  const allLabelRef = useRef<HTMLDivElement | null>(null);
  const [underlinePos, setUnderlinePos] = useState<{
    left: number;
    width: number;
  }>({ left: 0, width: 0 });
  const [animateUnderline, setAnimateUnderline] = useState(false);
  const [underlineReady, setUnderlineReady] = useState(false);

  const updateUnderline = () => {
    if (mode !== "default") return;
    const target =
      activeTab === "recent" ? recentLabelRef.current : allLabelRef.current;
    if (!target || !tabsRef.current) return;
    const tabsRect = tabsRef.current.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    setUnderlinePos({ left: rect.left - tabsRect.left, width: rect.width });
    setUnderlineReady(true);
  };

  useLayoutEffect(() => {
    if (mode === "default") {
      updateUnderline();
      window.addEventListener("resize", updateUnderline);
      return () => window.removeEventListener("resize", updateUnderline);
    }
  }, [activeTab, mode]);

  // Ensure underline position is correct on mount
  useLayoutEffect(() => {
    if (mode === "default") {
        updateUnderline();
        requestAnimationFrame(updateUnderline);
    }
  }, [mode]);

  // --- More Menu Logic (Default Mode) ---
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ left: number; top: number }>({
    left: 0,
    top: 0,
  });
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuBtnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    onMenuOpenChange?.(menuOpen);
  }, [menuOpen, onMenuOpenChange]);

  // Click outside to close menu
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      const inMenu = !!(
        menuRef.current &&
        target &&
        menuRef.current.contains(target)
      );
      const inBtn = !!(
        menuBtnRef.current &&
        target &&
        menuBtnRef.current.contains(target)
      );
      if (!inMenu && !inBtn) setMenuOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onEsc);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onEsc);
    };
  }, [menuOpen]);

  // Calculate menu position
  useLayoutEffect(() => {
    if (!menuOpen) return;
    const btn = menuBtnRef.current;
    const menu = menuRef.current;
    if (!btn || !menu) return;
    const btnRect = btn.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const edge = 14; // Safe margin
    const menuWidth = menu.offsetWidth || 0;
    let center = btnRect.left + btnRect.width / 2;
    const maxCenter = vw - edge - menuWidth / 2;
    const minCenter = edge + menuWidth / 2;
    center = Math.max(minCenter, Math.min(maxCenter, center));
    const top = btnRect.bottom + 6;
    setMenuPos({ left: center, top });
  }, [menuOpen]);

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
            aria-label="返回"
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
            已选中({selectedCount})
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
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: `${TOP_BAR_MARGIN_BOTTOM}px`,
        ...style,
      }}
      {...divProps}
    >
      <div
        ref={tabsRef}
        style={{
          display: "flex",
          alignItems: "flex-end",
          position: "relative",
          paddingBottom: `${TOP_BAR_TAB_PADDING_BOTTOM}px`,
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
          }}
          title="最近"
        >
          <div
            ref={recentLabelRef}
            style={{
              fontSize: TOP_BAR_TAB_FONT_SIZE + "px",
              color: activeTab === "recent" ? "#000" : "#bbb",
              transition: "color 200ms ease",
            }}
          >
            最近
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
          }}
          title="全部"
        >
          <div
            ref={allLabelRef}
            style={{
              fontSize: TOP_BAR_TAB_FONT_SIZE + "px",
              color: activeTab === "all" ? "#000" : "#bbb",
              transition: "color 200ms ease",
            }}
          >
            全部
          </div>
        </button>
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
      <div
        style={{
          display: "flex",
          alignItems: "center",
          position: "relative",
          gap: `${TOP_BAR_ICON_GAP}px`,
        }}
      >
        <button
          title="搜索"
          aria-label="搜索"
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
          ref={menuBtnRef}
          title="更多"
          aria-label="更多"
          onClick={() => setMenuOpen((m) => !m)}
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
            fill="#333"
            xmlns="http://www.w3.org/2000/svg"
          >
            <circle cx="12" cy="5" r="2" />
            <circle cx="12" cy="12" r="2" />
            <circle cx="12" cy="19" r="2" />
          </svg>
        </button>
        {menuOpen && (
          <div
            ref={menuRef}
            style={{
              position: "fixed",
              left: menuPos.left,
              top: menuPos.top,
              transform: "translateX(-50%)",
              background: "#fff",
              border: "none",
              boxShadow: "0 6px 16px rgba(0,0,0,0.12)",
              borderRadius: "10px",
              padding: "8px 14px",
              width: "auto",
              minWidth: "100px",
              whiteSpace: "nowrap",
              zIndex: 20,
            }}
          >
            <MenuButton
              onClick={() => {
                setMenuOpen(false);
                onMenuAction?.("import");
              }}
              icon={
                <svg
                  style={{ marginRight: "8px" }}
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path
                    d="M12 3v8"
                    stroke="#333"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                  <path
                    d="M9.5 8.5L12 11l2.5-2.5"
                    stroke="#333"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <rect
                    x="4"
                    y="13"
                    width="16"
                    height="7"
                    rx="2"
                    stroke="#333"
                    strokeWidth="2"
                  />
                </svg>
              }
              label="导入"
            />
            <MenuButton
              onClick={() => {
                setMenuOpen(false);
                onMenuAction?.("settings");
              }}
              icon={
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                  style={{ marginRight: "8px" }}
                >
                  <circle
                    cx="12"
                    cy="12"
                    r="9"
                    stroke="#333"
                    strokeWidth="2"
                  />
                  <circle
                    cx="12"
                    cy="12"
                    r="3"
                    stroke="#333"
                    strokeWidth="2"
                  />
                  <path
                    d="M12 4.5v2.3"
                    stroke="#333"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                  <path
                    d="M12 17.2v2.3"
                    stroke="#333"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
              }
              label="设置"
            />
            <MenuButton
              onClick={() => {
                setMenuOpen(false);
                onMenuAction?.("statistics");
              }}
              icon={
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                  style={{ marginRight: "8px" }}
                >
                  <rect
                    x="3"
                    y="12"
                    width="4"
                    height="8"
                    rx="1"
                    stroke="#333"
                    strokeWidth="1.5"
                    fill="none"
                  />
                  <rect
                    x="10"
                    y="8"
                    width="4"
                    height="12"
                    rx="1"
                    stroke="#333"
                    strokeWidth="1.5"
                    fill="none"
                  />
                  <rect
                    x="17"
                    y="4"
                    width="4"
                    height="16"
                    rx="1"
                    stroke="#333"
                    strokeWidth="1.5"
                    fill="none"
                  />
                </svg>
              }
              label="统计"
            />
            <MenuButton
              onClick={() => {
                setMenuOpen(false);
                onMenuAction?.("about");
              }}
              icon={
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                  style={{ marginRight: "8px" }}
                >
                  <circle
                    cx="12"
                    cy="12"
                    r="9"
                    stroke="#333"
                    strokeWidth="2"
                  />
                  <path
                    d="M12 7v2"
                    stroke="#333"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                  <path
                    d="M12 11v6"
                    stroke="#333"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
              }
              label="关于"
            />
          </div>
        )}
      </div>
    </div>
  );
};

// Helper component for menu buttons
const MenuButton: React.FC<{
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}> = ({ onClick, icon, label }) => {
  return (
    <button
      onClick={onClick}
      style={{
        width: "100%",
        background: "transparent",
        border: "none",
        boxShadow: "none",
        borderRadius: 0,
        padding: "8px 6px",
        cursor: "pointer",
        color: "#333",
        display: "flex",
        alignItems: "center",
        textAlign: "left",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.backgroundColor = "#f7f7f7";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = "transparent";
      }}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
};

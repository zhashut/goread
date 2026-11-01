import React from "react";
import { useTranslation } from "react-i18next";
import { getSafeAreaInsets } from "../../utils/layout";

/** 底部入口栏动作类型（书架/导入/统计/设置/关于） */
export type BottomBarAction =
  | "bookshelf"
  | "import"
  | "settings"
  | "statistics"
  | "about";

interface BottomBarProps {
  /** 入口点击回调 */
  onAction: (action: BottomBarAction) => void;
  /** 当前高亮的入口（当前所在页面），不传则全部默认色 */
  activeKey?: BottomBarAction;
}

/** 入口项激活色（与主题色一致） */
const ACTIVE_COLOR = "#d15158";
/** 入口项默认图标色 */
const ICON_COLOR = "#444";
/** 入口项默认文字色 */
const LABEL_COLOR = "#666";

/**
 * 书架主界面底部固定入口栏
 *
 * 功能描述：平铺展示"书架 / 导入 / 统计 / 设置 / 关于"五个入口，固定于视口底部；
 *          背景与书架页面一致，顶部以细分隔线区分内容区，自动适配底部安全区；
 *          activeKey 指定的入口以主题色高亮，用于标识当前所在页面。
 *
 * 参数说明：onAction —— 入口点击回调，action 标识被点击的入口；
 *          activeKey —— 当前高亮入口的动作标识（可选）。
 *
 * 返回值类型：React.FC，渲染底部固定入口栏元素。
 */
export const BottomBar: React.FC<BottomBarProps> = ({ onAction, activeKey }) => {
  const { t } = useTranslation('bookshelf');

  const items: {
    key: BottomBarAction;
    label: string;
    icon: React.ReactNode;
  }[] = [
    {
      key: "bookshelf",
      label: t('bookshelf'),
      icon: (
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          {/* 书架图标：两本竖书 + 一本斜靠书 + 底板，描边随 currentColor */}
          <rect x="4" y="3.5" width="4.4" height="13.5" rx="1" stroke="currentColor" strokeWidth="1.8" />
          <rect x="10.6" y="3.5" width="4.4" height="13.5" rx="1" stroke="currentColor" strokeWidth="1.8" />
          <path
            d="M17.1 5.3l3.2 0.9-3.4 12.7-3.2-0.9z"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
          <line x1="3" y1="20.5" x2="21" y2="20.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      ),
    },
    {
      key: "import",
      label: t('import'),
      icon: (
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <polyline points="7 10 12 15 17 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <line x1="12" y1="15" x2="12" y2="3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      ),
    },
    {
      key: "statistics",
      label: t('statistics'),
      icon: (
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <rect x="3" y="12" width="4" height="8" rx="1" stroke="currentColor" strokeWidth="1.5" fill="none" />
          <rect x="10" y="8" width="4" height="12" rx="1" stroke="currentColor" strokeWidth="1.5" fill="none" />
          <rect x="17" y="4" width="4" height="16" rx="1" stroke="currentColor" strokeWidth="1.5" fill="none" />
        </svg>
      ),
    },
    {
      key: "settings",
      label: t('settings'),
      icon: (
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="2" />
        </svg>
      ),
    },
    {
      key: "about",
      label: t('about'),
      icon: (
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <rect x="3" y="3" width="18" height="18" rx="5" ry="5" stroke="currentColor" strokeWidth="2" />
          <line x1="12" y1="16" x2="12" y2="12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <line x1="12" y1="8" x2="12.01" y2="8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      ),
    },
  ];

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
      {items.map((item) => {
        // 当前页入口以主题色高亮（图标 stroke 走 currentColor）
        const isActive = activeKey === item.key;
        return (
          <button
            key={item.key}
            title={item.label}
            aria-label={item.label}
            onClick={() => onAction(item.key)}
            style={{
              flex: 1,
              background: "transparent",
              border: "none",
              boxShadow: "none",
              borderRadius: 0,
              padding: "8px 0 7px",
              margin: 0,
              cursor: "pointer",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 3,
              WebkitTapHighlightColor: "transparent",
              color: isActive ? ACTIVE_COLOR : ICON_COLOR,
            }}
          >
            {item.icon}
            <span
              style={{
                fontSize: 11,
                color: isActive ? ACTIVE_COLOR : LABEL_COLOR,
                lineHeight: 1.2,
                fontWeight: isActive ? 600 : 400,
              }}
            >
              {item.label}
            </span>
          </button>
        );
      })}
    </div>
  );
};

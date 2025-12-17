import React from 'react';
import {
  PAGE_HEADER_HEIGHT,
  PAGE_HEADER_BACK_ICON_SIZE,
  PAGE_HEADER_TITLE_FONT_SIZE,
  PAGE_HEADER_TITLE_FONT_WEIGHT,
  PAGE_HEADER_TITLE_MARGIN_LEFT,
  PAGE_HEADER_PADDING_HORIZONTAL,
} from '../constants/ui';
import { getSafeAreaInsets } from '../utils/layout';

interface PageHeaderProps {
  /** 页面标题 */
  title: string;
  /** 返回按钮点击回调 */
  onBack: () => void;
  /** 右侧额外内容（如导入页的筛选按钮等） */
  rightContent?: React.ReactNode;
  /** 是否使用 sticky 定位（默认 false） */
  sticky?: boolean;
  /** 背景颜色（默认白色） */
  backgroundColor?: string;
  /** 自定义容器样式 */
  style?: React.CSSProperties;
}

/**
 * 页面顶部栏公共组件
 * 用于关于、设置、统计、导入等二级页面，统一返回图标和标题样式
 */
export const PageHeader: React.FC<PageHeaderProps> = ({
  title,
  onBack,
  rightContent,
  sticky = false,
  backgroundColor = '#ffffff',
  style,
}) => {
  const safeArea = getSafeAreaInsets();

  return (
    <div
      style={{
        backgroundColor,
        height: PAGE_HEADER_HEIGHT,
        display: 'flex',
        alignItems: 'center',
        padding: `0 ${PAGE_HEADER_PADDING_HORIZONTAL}px`,
        paddingTop: safeArea.top,
        boxSizing: 'content-box',
        ...(sticky ? {
          position: 'sticky',
          top: 0,
          zIndex: 100,
        } : {}),
        ...style,
      }}
    >
      {/* 返回按钮 - 统一 SVG 箭头图标（与关于页一致） */}
      <svg
        width={PAGE_HEADER_BACK_ICON_SIZE}
        height={PAGE_HEADER_BACK_ICON_SIZE}
        viewBox="0 0 24 24"
        fill="#212121"
        onClick={onBack}
        style={{ cursor: 'pointer', flexShrink: 0 }}
      >
        <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" />
      </svg>

      {/* 标题 - 靠左对齐 */}
      <h1
        style={{
          margin: 0,
          fontSize: PAGE_HEADER_TITLE_FONT_SIZE,
          fontWeight: PAGE_HEADER_TITLE_FONT_WEIGHT,
          marginLeft: PAGE_HEADER_TITLE_MARGIN_LEFT,
          color: '#212121',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {title}
      </h1>

      {/* 占位区域，将右侧内容推到最右边 */}
      <div style={{ flex: 1 }} />

      {/* 右侧内容区（可选） */}
      {rightContent && (
        <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
          {rightContent}
        </div>
      )}
    </div>
  );
};

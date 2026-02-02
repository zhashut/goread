import React from 'react';

export interface PageDividerProps {
  height?: number;
  color?: string;
  marginTop?: number;
  marginBottom?: number;
  fullBleed?: boolean;
  hidden?: boolean;
  className?: string;
}

/**
 * 分页分隔线组件
 */
export const PageDivider: React.FC<PageDividerProps> = ({
  height = 0,
  color,
  marginTop = 0,
  marginBottom = 0,
  fullBleed = false,
  hidden = false,
  className = '',
}) => {
  if (hidden) return null;

  const style: React.CSSProperties = {
    height: `${height}px`,
    backgroundColor: color,
    marginTop: `${marginTop}px`,
    marginBottom: `${marginBottom}px`,
    width: '100%',
  };

  if (fullBleed) {
    style.marginLeft = '-16px';
    style.marginRight = '-16px';
    style.width = 'calc(100% + 32px)';
  }

  return <div className={className} style={style} />;
};

/**
 * 创建原生 DOM 分隔线元素
 */
export const createDividerEl = (options: PageDividerProps): HTMLDivElement => {
  const div = document.createElement('div');
  updateDividerStyle(div, options);
  return div;
};

/**
 * 更新原生 DOM 分隔线样式
 */
export const updateDividerStyle = (el: HTMLDivElement, options: PageDividerProps) => {
  const {
    height = 0,
    color,
    marginTop = 0,
    marginBottom = 0,
    fullBleed = false,
    hidden = false,
  } = options;

  if (hidden) {
    el.style.display = 'none';
  } else {
    el.style.display = 'block';
    el.style.height = `${height}px`;
    if (color) el.style.backgroundColor = color;
    el.style.marginTop = `${marginTop}px`;
    el.style.marginBottom = `${marginBottom}px`;
    el.style.width = '100%';

    if (fullBleed) {
      el.style.marginLeft = '-16px';
      el.style.marginRight = '-16px';
      el.style.width = 'calc(100% + 32px)';
    } else {
      el.style.marginLeft = '0';
      el.style.marginRight = '0';
    }
  }
};

/**
 * 切换分隔线可见性
 */
export const toggleDividerVisibility = (el: HTMLDivElement, hidden: boolean) => {
  el.style.display = hidden ? 'none' : 'block';
};

/**
 * 计算分隔线样式配置
 */
export const getDividerStyle = (
  pageGap: number,
  theme: string,
  variant: 'normal' | 'fullBleed' = 'normal'
): PageDividerProps => {
  // 高度计算公式：pageGap * 2 + 1 (1px border line visual) -> 实际上这里只控制整体高度，颜色填充区域由 height 控制
  // 通常 PDF/Reader.tsx 中：style={{ height: pageGap * 2 + 1, backgroundColor: isDark ? '#000' : '#e0e0e0' ... }}
  // 但 Reader.tsx 实际上是用作 gap，颜色由背景色决定？
  // 检查 Reader.tsx 的实现：
  // <div style={{ height: settings.pageGap * 2 + 1, backgroundColor: isDark ? '#333' : '#ccc', ... }} />
  
  const isDark = theme === 'dark';
  const color = isDark ? '#333333' : '#cccccc'; // 默认颜色，具体业务可能不同，这里给一个合理默认值
  
  return {
    height: pageGap * 2 + 1,
    color,
    marginTop: 0,
    marginBottom: 0,
    fullBleed: variant === 'fullBleed',
    hidden: false,
  };
};

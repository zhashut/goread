import React from 'react';

interface LoadingProps {
  /** 控制显示隐藏 */
  visible?: boolean;
  /** 加载提示文案 */
  text?: string;
  /** 
   * 加载图标颜色
   * @default '#d15158'
   */
  color?: string;
  /** 
   * 加载图标大小 (px)
   * @default 40
   */
  size?: number;
  /** 
   * 是否显示遮罩层
   * @default true
   */
  overlay?: boolean;
  /**
   * 遮罩层背景色
   * @default 'rgba(255, 255, 255, 0.8)'
   */
  overlayColor?: string;
  /**
   * z-index 层级
   * @default 2000
   */
  zIndex?: number;
  /**
   * 是否显示加载转圈
   * @default true
   */
  showSpinner?: boolean;
  /**
   * 自定义容器样式
   */
  style?: React.CSSProperties;
  /**
   * 自定义类名
   */
  className?: string;
  overlayStyle?: React.CSSProperties;
  textStyle?: React.CSSProperties;
}

export const Loading: React.FC<LoadingProps> = ({
  visible = true,
  text,
  color = '#d15158',
  size = 40,
  overlay = true,
  overlayColor = 'rgba(255, 255, 255, 0.8)',
  zIndex = 2000,
  showSpinner = true,
  style,
  className,
  overlayStyle,
  textStyle,
}) => {
  if (!visible) return null;

  const content = (
    <div
      className={className}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        ...style,
      }}
    >
      {showSpinner && (
        <div
          className="loading-spinner"
          style={{
            width: size,
            height: size,
            border: `3px solid ${color}33`, // 20% opacity for track
            borderTopColor: color,
            borderRadius: '50%',
          }}
        />
      )}
      {text && (
        <div
          style={{
            marginTop: showSpinner ? 12 : 0,
            color: '#666',
            fontSize: 14,
            fontWeight: 500,
            ...textStyle,
          }}
        >
          {text}
        </div>
      )}
      <style>
        {`
          .loading-spinner {
            animation: spin 1s linear infinite;
          }
          @keyframes spin {
            to { transform: rotate(360deg); }
          }
        `}
      </style>
    </div>
  );

  if (overlay) {
    return (
      <div
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: overlayColor,
          zIndex,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          ...overlayStyle,
        }}
        onClick={(e) => e.stopPropagation()} // 阻止点击穿透
      >
        {content}
      </div>
    );
  }

  return content;
};

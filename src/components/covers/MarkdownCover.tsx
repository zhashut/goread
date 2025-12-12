import React from "react";

export const MarkdownCover: React.FC<{ style?: React.CSSProperties; className?: string }> = ({
  style,
  className,
}) => {
  return (
    <svg
      viewBox="0 0 200 280"
      width="100%"
      height="100%"
      preserveAspectRatio="xMidYMid slice" // 类似 object-fit: cover，确保填满容器
      style={{
        backgroundColor: "#ffffff",
        display: "block",
        pointerEvents: "none",
        userSelect: "none",
        WebkitUserSelect: "none",
        msUserSelect: "none",
        ...style,
      }}
      aria-hidden="true"
      role="presentation"
      className={className ? `md-cover ${className}` : 'md-cover'}
    >
      {/* 1. 顶部黑色装饰条 */}
      <rect x="0" y="0" width="200" height="12" fill="#333333" />

      {/* 2. 中间 Logo 区域 (整体下移) */}
      <g transform="translate(60, 70)">
        {/* 外框 */}
        <rect
          x="0"
          y="0"
          width="80"
          height="50"
          fill="none"
          stroke="#333333"
          strokeWidth="3"
          rx="4"
        />
        
        {/* 内部 M 图形 */}
        <g transform="translate(8, 10)">
           {/* M 的左腿 */}
           <rect x="0" y="0" width="5" height="25" fill="#333333" />
           {/* M 的右腿 */}
           <rect x="20" y="0" width="5" height="25" fill="#333333" />
           {/* M 的中间倒三角 */}
           <path d="M0 0 L25 0 L12.5 12 Z" fill="#333333" />
        </g>

        {/* 内部 箭头 图形 */}
        <g transform="translate(56, 10)">
           {/* 箭身 */}
           <rect x="5" y="0" width="6" height="18" fill="#333333" />
           {/* 箭头 */}
           <path d="M-3 18 L19 18 L8 28 Z" fill="#333333" />
        </g>
      </g>

      {/* 3. 文字区域 */}
      <text
        x="100"
        y="170"
        textAnchor="middle"
        fontFamily="'Courier New', Courier, monospace"
        fontWeight="bold"
        fontSize="24"
        fill="#333333"
        letterSpacing="-1"
        style={{ userSelect: 'none', WebkitUserSelect: 'none', msUserSelect: 'none' }}
      >
        Markdown
      </text>

      {/* 4. 底部页码 */}
      <text
        x="100"
        y="260"
        textAnchor="middle"
        fontFamily="'Courier New', Courier, monospace"
        fontSize="12"
        fill="#cccccc"
        letterSpacing="2"
        style={{ userSelect: 'none', WebkitUserSelect: 'none', msUserSelect: 'none' }}
      >
        1 / ∞
      </text>
    </svg>
  );
};

export default MarkdownCover;

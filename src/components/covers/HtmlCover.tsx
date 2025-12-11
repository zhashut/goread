import React from "react";

export const HtmlCover: React.FC<{ style?: React.CSSProperties; className?: string }> = ({
  style,
  className,
}) => {
  return (
    <svg
      viewBox="0 0 200 280"
      width="100%"
      height="100%"
      preserveAspectRatio="xMidYMid slice"
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
      className={className ? `html-cover ${className}` : 'html-cover'}
    >
      {/* 1. 顶部浏览器栏 */}
      <rect x="0" y="0" width="200" height="24" fill="#E0E0E0" />
      <circle cx="15" cy="12" r="4" fill="#FF5F57" />
      <circle cx="30" cy="12" r="4" fill="#FFBD2E" />
      <circle cx="45" cy="12" r="4" fill="#28C940" />
      
      {/* 浏览器地址栏 */}
      <rect x="60" y="5" width="130" height="14" rx="7" fill="#FFFFFF" />

      {/* 2. 页面内容模拟 */}
      <g transform="translate(20, 50)">
        {/* 标题 */}
        <rect x="0" y="0" width="100" height="12" fill="#E34C26" />
        
        {/* 段落 1 */}
        <rect x="0" y="25" width="160" height="6" fill="#D0D0D0" />
        <rect x="0" y="35" width="140" height="6" fill="#D0D0D0" />
        <rect x="0" y="45" width="150" height="6" fill="#D0D0D0" />

        {/* 图片占位符 */}
        <rect x="0" y="65" width="160" height="80" fill="#F0F0F0" stroke="#D0D0D0" />
        <path d="M60 105 L80 85 L100 105 L120 95 L140 115" stroke="#B0B0B0" fill="none" strokeWidth="2" />

        {/* 段落 2 */}
        <rect x="0" y="160" width="150" height="6" fill="#D0D0D0" />
        <rect x="0" y="170" width="130" height="6" fill="#D0D0D0" />
        <rect x="0" y="180" width="140" height="6" fill="#D0D0D0" />
      </g>

      {/* 3. HTML 标识 */}
      <text
        x="100"
        y="250"
        textAnchor="middle"
        fontFamily="'Courier New', Courier, monospace"
        fontWeight="bold"
        fontSize="32"
        fill="#E34C26"
        letterSpacing="1"
        style={{ userSelect: 'none', WebkitUserSelect: 'none', msUserSelect: 'none' }}
      >
        &lt;HTML&gt;
      </text>
    </svg>
  );
};

export default HtmlCover;

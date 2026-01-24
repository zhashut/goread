import React from "react";

/**
 * TXT 封面 - 官方灰色风格 (System Gray) - 间距优化版
 * 调整了图标位置，增加了与标题的间距
 */
export const TxtCover: React.FC<{ style?: React.CSSProperties; className?: string }> = ({
  style,
  className,
}) => {
  return (
    <svg
      viewBox="0 0 200 280"
      width="100%"
      height="100%"
      preserveAspectRatio="xMidYMid slice"
      style={{ backgroundColor: "#ffffff", display: "block", ...style }}
      className={className}
    >
      {/* 1. 顶部装饰条 */}
      <rect x="0" y="0" width="200" height="12" fill="#757575" />

      {/* 
         2. 中间 Logo 区域 
         [修改点] 将 Y 轴从 70 改为 55，整体上移，从而拉大与下方文字的距离
      */}
      <g transform="translate(60, 55)"> 
        
        {/* 纸张轮廓 */}
        <path
          d="M0 0 L55 0 L80 25 L80 110 L0 110 Z"
          fill="#FFFFFF"
          stroke="#757575"
          strokeWidth="3"
          strokeLinejoin="round"
        />

        {/* 右上角折角 */}
        <path
          d="M55 0 L55 25 L80 25"
          fill="#EEEEEE" 
          stroke="#757575"
          strokeWidth="3"
          strokeLinejoin="round"
        />

        {/* 内部横线 */}
        <g stroke="#BDBDBD" strokeWidth="3" strokeLinecap="round">
            <line x1="15" y1="20" x2="40" y2="20" />
            <line x1="15" y1="35" x2="65" y2="35" />
            <line x1="15" y1="48" x2="65" y2="48" />
            <line x1="15" y1="61" x2="65" y2="61" />
            <line x1="15" y1="74" x2="65" y2="74" />
            <line x1="15" y1="87" x2="50" y2="87" />
        </g>
      </g>

      {/* 3. 文字区域 (保持位置不变，因为图标上移了，间距自然变大) */}
      <text
        x="100"
        y="210"
        textAnchor="middle"
        fontFamily="'Courier New', Courier, monospace"
        fontWeight="bold"
        fontSize="34"
        fill="#616161"
        letterSpacing="-1"
      >
        TXT
      </text>

      <text
        x="100"
        y="235"
        textAnchor="middle"
        fontFamily="'Courier New', Courier, monospace"
        fontSize="12"
        fill="#9e9e9e"
        letterSpacing="1"
      >
        plain text
      </text>

      {/* 4. 底部页码 */}
      <text
        x="100"
        y="260"
        textAnchor="middle"
        fontFamily="'Courier New', Courier, monospace"
        fontSize="10"
        fill="#bdbdbd"
        letterSpacing="2"
      >
        1 / ∞
      </text>
    </svg>
  );
};

export default TxtCover;
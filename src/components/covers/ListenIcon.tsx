import React from "react";

export type ListenIconProps = {
  size?: number;
  style?: React.CSSProperties;
  className?: string;
  /**
   * 是否处于开启(听书)状态
   * true: 显示高亮色 (#d15158)
   * false: 显示默认色 (currentColor)
   */
  isActive?: boolean;
};

export const ListenIcon: React.FC<ListenIconProps> = ({ 
  size = 28, 
  style, 
  className, 
  isActive = false 
}) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      // 核心逻辑：开启时用红色，关闭时继承父级颜色
      fill={isActive ? "#d15158" : "currentColor"}
      stroke="none"
      style={{ display: "block", ...style }}
      aria-hidden="true"
      role="presentation"
      className={className ? `listen-icon ${className}` : "listen-icon"}
    >
      <path d="M12 2c-5.52 0-10 4.48-10 10v7h4v-7c0-3.31 2.69-6 6-6s6 2.69 6 6v7h4v-7c0-5.52-4.48-10-10-10zm-2 15h-2v-4h2v4zm6 0h-2v-4h2v4z" />
    </svg>
  );
};

export default ListenIcon;
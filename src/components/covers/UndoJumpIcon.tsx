import React from "react";

export type ThemeIconProps = {
  size?: number;
  color?: string;
  style?: React.CSSProperties;
  className?: string;
};

export const UndoJumpIcon: React.FC<ThemeIconProps> = ({ size = 28, color, style, className }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={color || "currentColor"}
      style={{ display: "block", ...style }}
      aria-hidden="true"
      role="presentation"
      className={className ? `undo-jump-icon ${className}` : "undo-jump-icon"}
    >
      <path d="M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z"/>
    </svg>
  );
};

export default UndoJumpIcon;

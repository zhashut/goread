import React from "react";

export type ThemeIconProps = {
  size?: number;
  style?: React.CSSProperties;
  className?: string;
};

export const ThemeMoonIcon: React.FC<ThemeIconProps> = ({ size = 28, style, className }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      stroke="none"
      style={{ display: "block", ...style }}
      aria-hidden="true"
      role="presentation"
      className={className ? `theme-moon-icon ${className}` : "theme-moon-icon"}
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
};

export default ThemeMoonIcon;

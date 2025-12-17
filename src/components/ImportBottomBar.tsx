import React from "react";
import { getSafeAreaInsets } from "../utils/layout";

interface ImportBottomBarProps {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  useSafeAreaPadding?: boolean;
}

export const ImportBottomBar: React.FC<ImportBottomBarProps> = ({
  label,
  onClick,
  disabled = false,
  useSafeAreaPadding = false,
}) => {
  const paddingBottom = useSafeAreaPadding ? getSafeAreaInsets().bottom : 0;

  const handleClick = () => {
    if (disabled) return;
    onClick();
  };

  return (
    <div
      style={{
        flex: "none",
        paddingBottom,
        background: "#d23c3c",
        zIndex: 10,
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          padding: "10px 16px",
          color: "#fff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: disabled ? "default" : "pointer",
          userSelect: "none",
          textAlign: "center",
        }}
        onClick={handleClick}
      >
        <span style={{ fontSize: 14, letterSpacing: 1 }}>{label}</span>
      </div>
    </div>
  );
};


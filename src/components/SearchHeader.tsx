import React, { useEffect, useRef } from "react";
import { getSafeAreaInsets } from "../utils/layout";

interface SearchHeaderProps {
  value: string;
  onChange: (val: string) => void;
  onClose: () => void;
  onClear?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  autoFocusDelay?: number;
}

export const SearchHeader: React.FC<SearchHeaderProps> = ({
  value,
  onChange,
  onClose,
  onClear,
  placeholder,
  autoFocus = false,
  autoFocusDelay = 0,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!autoFocus) return;
    const timer = setTimeout(() => {
      inputRef.current?.focus();
    }, autoFocusDelay);
    return () => clearTimeout(timer);
  }, [autoFocus, autoFocusDelay]);

  const handleClear = () => {
    if (onClear) {
      onClear();
    } else {
      onChange("");
    }
  };

  return (
    <div style={{ padding: "10px 12px", paddingTop: `calc(${getSafeAreaInsets().top} + 10px)` }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          background: "#efefef",
          borderRadius: 12,
          height: 40,
          padding: "0 8px",
          overflow: "hidden",
        }}
      >
        <button
          onClick={onClose}
          aria-label="返回"
          title="返回"
          style={{
            background: "transparent",
            border: "none",
            width: 32,
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 0,
            margin: 0,
            cursor: "pointer",
            color: "#666",
            boxShadow: "none",
            borderRadius: 0,
          }}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
            <path
              d="M15 18l-6-6 6-6"
              stroke="#666"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          style={{
            flex: 1,
            padding: "0 6px",
            border: "none",
            background: "transparent",
            outline: "none",
            fontSize: 14,
            color: "#333",
            caretColor: "#d15158",
            height: "100%",
            boxShadow: "none",
            WebkitAppearance: "none",
            appearance: "none",
            borderRadius: 0,
          }}
        />
        {value && (
          <button
            onClick={handleClear}
            title="清除"
            aria-label="清除"
            style={{
              background: "transparent",
              border: "none",
              padding: "0 4px",
              height: "100%",
              display: "flex",
              alignItems: "center",
              cursor: "pointer",
              boxShadow: "none",
              borderRadius: 0,
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="#999" strokeWidth="2" />
              <path
                d="M9 9l6 6m0-6l-6 6"
                stroke="#999"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
};


import React, { useState, useRef, useEffect, useCallback } from "react";
import { SELECT_MIN_WIDTH } from "../constants/ui";

interface Option {
  value: string | number;
  label: string | number;
}

interface CustomSelectProps {
  value: string | number;
  options: Option[];
  onChange: (value: string | number) => void;
  style?: React.CSSProperties;
  dropdownDirection?: "down" | "up";
  dropdownMaxHeight?: number;
  adaptiveMaxHeight?: boolean;
  viewportMargin?: number;
  hideScrollbar?: boolean;
  disabled?: boolean;
}

export const CustomSelect: React.FC<CustomSelectProps> = ({
  value,
  options,
  onChange,
  style,
  dropdownDirection = "down",
  dropdownMaxHeight = 250,
  adaptiveMaxHeight = false,
  viewportMargin = 12,
  hideScrollbar = false,
  disabled = false,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [computedMaxHeight, setComputedMaxHeight] = useState<number>(dropdownMaxHeight);
  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const updateDropdownMaxHeight = useCallback(() => {
    if (!adaptiveMaxHeight) return;
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const available =
      dropdownDirection === "up"
        ? rect.top
        : window.innerHeight - rect.bottom;
    const next = Math.max(0, Math.min(dropdownMaxHeight, available - viewportMargin));
    setComputedMaxHeight(next);
  }, [adaptiveMaxHeight, dropdownDirection, dropdownMaxHeight, viewportMargin]);

  const scrollToSelected = useCallback(() => {
    const dropdown = dropdownRef.current;
    if (!dropdown) return;
    const targetValue = String(value);
    const children = Array.from(dropdown.children) as HTMLElement[];
    const target = children.find((el) => el.dataset.value === targetValue);
    if (!target) return;
    target.scrollIntoView({ block: "nearest" });
  }, [value]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent | TouchEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("touchstart", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("touchstart", handleClickOutside);
    };
  }, []);

  useEffect(() => {
    if (disabled && isOpen) setIsOpen(false);
    if (!isOpen) return;
    updateDropdownMaxHeight();
    requestAnimationFrame(() => scrollToSelected());
    window.addEventListener("resize", updateDropdownMaxHeight);
    return () => {
      window.removeEventListener("resize", updateDropdownMaxHeight);
    };
  }, [disabled, isOpen, scrollToSelected, updateDropdownMaxHeight]);

  const selectedOption = options.find((o) => o.value === value);

  return (
    <div
      ref={containerRef}
      style={{
        position: "relative",
        minWidth: SELECT_MIN_WIDTH,
        ...style,
      }}
    >
      <div
        onClick={() => {
          if (disabled) return;
          setIsOpen(!isOpen);
        }}
        style={{
          padding: "6px 12px",
          border: "1px solid #ddd",
          borderRadius: "4px",
          backgroundColor: "#fff",
          cursor: disabled ? "not-allowed" : "pointer",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontSize: "14px",
          color: "#333",
          opacity: disabled ? 0.6 : 1,
          userSelect: "none",
        }}
      >
        <span style={{ marginRight: "8px" }}>
          {selectedOption ? selectedOption.label : value}
        </span>
        <span
          style={{
            fontSize: "10px",
            color: "#999",
            transform: isOpen ? "rotate(180deg)" : "rotate(0deg)",
            transition: "transform 0.2s",
          }}
        >
          ▼
        </span>
      </div>
      {isOpen && (
        <>
          {hideScrollbar && (
            <style>{`
              .custom-select-hide-scrollbar::-webkit-scrollbar { display: none; }
            `}</style>
          )}
          <div
            ref={dropdownRef}
            className={hideScrollbar ? "custom-select-hide-scrollbar" : undefined}
            style={{
              position: "absolute",
              ...(dropdownDirection === "up"
                ? { bottom: "100%", marginBottom: "4px" }
                : { top: "100%", marginTop: "4px" }),
              right: 0,
              zIndex: 1000,
              backgroundColor: "#fff",
              border: "1px solid #eee",
              borderRadius: "4px",
              boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
              maxHeight: `${adaptiveMaxHeight ? computedMaxHeight : dropdownMaxHeight}px`,
              overflowY: "auto",
              ...(hideScrollbar
                ? { scrollbarWidth: "none", msOverflowStyle: "none" }
                : null),
              minWidth: "100%",
              width: "max-content",
            }}
          >
            {options.map((option) => (
              <div
                key={option.value}
                data-value={String(option.value)}
                onClick={() => {
                  onChange(option.value);
                  setIsOpen(false);
                }}
                style={{
                  padding: "8px 16px",
                  cursor: "pointer",
                  backgroundColor: option.value === value ? "#f5f5f5" : "#fff",
                  color: option.value === value ? "#d15158" : "#333",
                  fontSize: "14px",
                  whiteSpace: "nowrap",
                  borderBottom: "1px solid #f9f9f9",
                }}
              >
                {option.label}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
};

import React, { useState, useRef, useEffect } from "react";

interface Option {
  value: string | number;
  label: string | number;
}

interface CustomSelectProps {
  value: string | number;
  options: Option[];
  onChange: (value: string | number) => void;
  style?: React.CSSProperties;
}

export const CustomSelect: React.FC<CustomSelectProps> = ({
  value,
  options,
  onChange,
  style,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

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

  const selectedOption = options.find((o) => o.value === value);

  return (
    <div
      ref={containerRef}
      style={{
        position: "relative",
        minWidth: "80px",
        ...style,
      }}
    >
      <div
        onClick={() => setIsOpen(!isOpen)}
        style={{
          padding: "6px 12px",
          border: "1px solid #ddd",
          borderRadius: "4px",
          backgroundColor: "#fff",
          cursor: "pointer",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontSize: "14px",
          color: "#333",
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
        <div
          style={{
            position: "absolute",
            top: "100%",
            right: 0,
            zIndex: 1000,
            backgroundColor: "#fff",
            border: "1px solid #eee",
            borderRadius: "4px",
            boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
            marginTop: "4px",
            maxHeight: "250px",
            overflowY: "auto",
            minWidth: "100%",
            width: "max-content",
          }}
        >
          {options.map((option) => (
            <div
              key={option.value}
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
      )}
    </div>
  );
};

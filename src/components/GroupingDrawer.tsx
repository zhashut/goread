import React, { useEffect, useState, useRef } from "react";

import { getSafeAreaInsets } from "../utils/layout";

interface GroupingDrawerProps {
  open: boolean;
  onClose: () => void;
  newGroupName: string;
  onNewGroupNameChange: (value: string) => void;
  onChooseExistingGroup: () => void;
  onConfirmName: () => void;
  loading?: boolean;
}

const GroupingDrawer: React.FC<GroupingDrawerProps> = ({
  open,
  onClose,
  newGroupName,
  onNewGroupNameChange,
  onChooseExistingGroup,
  onConfirmName,
  loading = false,
}) => {
  // 本地输入状态，配合输入法合成事件，避免中文输入被打断
  const [localValue, setLocalValue] = useState<string>(newGroupName || "");
  const [isComposing, setIsComposing] = useState<boolean>(false);
  const [isInputFocused, setIsInputFocused] = useState<boolean>(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastHeightRef = useRef(window.innerHeight);

  useEffect(() => {
    setLocalValue(newGroupName || "");
  }, [newGroupName]);

  // 监听视口高度变化，处理键盘收起但未失焦的情况
  useEffect(() => {
    const handleResize = () => {
      const currentHeight = window.innerHeight;
      // 如果高度显著增加（>200px），说明键盘收起了
      if (currentHeight - lastHeightRef.current > 200) {
        setIsInputFocused(false);
        inputRef.current?.blur();
      }
      lastHeightRef.current = currentHeight;
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  return (
    <div
      aria-live="polite"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: "rgba(0,0,0,0.35)",
        display: open ? "flex" : "none",
        alignItems: "flex-end",
        zIndex: 1000,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div
        role="dialog"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          background: "#fff",
          borderTopLeftRadius: 20,
          borderTopRightRadius: 20,
          padding: `14px 16px calc(14px + ${getSafeAreaInsets().bottom}) 16px`,
          boxSizing: "border-box",
          display: "flex",
          flexDirection: "column",
          maxHeight: "90vh",
          overflowY: "auto",
        }}
      >
        <div
          style={{
            color: "#333",
            fontSize: 15,
            fontWeight: 600,
            marginBottom: 30,
          }}
        >
          如何分组？
        </div>
        <input
          ref={inputRef}
          value={localValue}
          onChange={(e) => {
            const val = e.target.value;
            setLocalValue(val);
            if (!isComposing) {
              onNewGroupNameChange(val);
            }
          }}
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={(e) => {
            setIsComposing(false);
            const val = (e.target as HTMLInputElement).value;
            onNewGroupNameChange(val);
          }}
          placeholder="输入新的分组名"
          onFocus={() => setIsInputFocused(true)}
          onBlur={() => setIsInputFocused(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && localValue.trim() && !loading) {
              onConfirmName();
              // 失去焦点以收起键盘
              (e.target as HTMLInputElement).blur();
            }
          }}
          style={{
            width: "100%",
            border: "none",
            borderBottom: "1px solid #d23c3c",
            outline: "none",
            fontSize: 13,
            padding: "8px 2px",
            boxShadow: "none",
            borderRadius: 0,
            color: "#333",
            background: "transparent",
          }}
        />
        {/* 独立灰色分隔线，增强与操作区的分割感 */}
        <div style={{ height: 2, background: "#d23c3c", marginTop: 8 }} />

        {!isInputFocused && (
          <div
            style={{
              marginTop: "auto",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              paddingTop: 30,
              paddingBottom: 8,
              color: "#666",
              fontSize: 13,
            }}
          >
            <button
              onClick={onChooseExistingGroup}
              style={{
                background: "none",
                border: "none",
                color: "#999",
                cursor: "pointer",
                padding: 0,
              }}
            >
              导入到现有分组
            </button>
            <button
              onClick={onConfirmName}
              disabled={!localValue.trim() || loading}
              style={{
                background: "none",
                border: "none",
                color: "#d23c3c",
                cursor: localValue.trim() ? "pointer" : "not-allowed",
                opacity: localValue.trim() ? 1 : 0.6,
                padding: 0,
              }}
            >
              确定命名
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default GroupingDrawer;

import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export interface CreateGroupDialogProps {
  /** 是否显示抽屉 */
  open: boolean;
  /** 创建中，禁止重复提交 */
  loading?: boolean;
  onCancel: () => void;
  /** 确认创建，携带去除首尾空白后的名称 */
  onConfirm: (name: string) => void;
}

/**
 * 新建文件夹（分组）底部抽屉
 * 提供名称输入与取消/创建操作，样式与 ConfirmDeleteDrawer 底部抽屉一致
 */
const CreateGroupDialog: React.FC<CreateGroupDialogProps> = ({
  open,
  loading = false,
  onCancel,
  onConfirm,
}) => {
  const { t } = useTranslation("bookshelf");
  const { t: tc } = useTranslation("common");
  // 本地输入状态，避免中文输入法合成期间被外部状态打断
  const [localValue, setLocalValue] = useState<string>("");
  const inputRef = useRef<HTMLInputElement>(null);

  // 每次打开时清空输入并自动聚焦
  useEffect(() => {
    if (open) {
      setLocalValue("");
      const timer = window.setTimeout(() => inputRef.current?.focus(), 100);
      return () => window.clearTimeout(timer);
    }
  }, [open]);

  const trimmed = localValue.trim();

  return (
    <div
      onClick={onCancel}
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "rgba(0,0,0,0.5)",
        display: "flex",
        flexDirection: "column",
        justifyContent: "flex-end",
        zIndex: 1001,
        visibility: open ? "visible" : "hidden",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={t("createFolder")}
        style={{
          width: "100%",
          background: "#fff",
          borderTopLeftRadius: 20,
          borderTopRightRadius: 20,
          overflow: "hidden",
          boxSizing: "border-box",
          backgroundClip: "padding-box",
          padding: "18px 18px 0 18px",
          boxShadow: "0 -6px 20px rgba(0,0,0,0.2)",
        }}
      >
        <div style={{ fontSize: "16px", fontWeight: 600, marginBottom: "18px" }}>
          {t("createFolder")}
        </div>
        <input
          ref={inputRef}
          value={localValue}
          maxLength={50}
          disabled={loading}
          onChange={(e) => {
            setLocalValue(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && trimmed && !loading) {
              onConfirm(trimmed);
            }
          }}
          placeholder={t("folderNamePlaceholder")}
          style={{
            width: "100%",
            boxSizing: "border-box",
            border: "none",
            outline: "none",
            fontSize: "14px",
            padding: "10px 2px",
            boxShadow: "none",
            borderRadius: 0,
            color: "#333",
            background: "transparent",
            borderBottom: "1px solid #d15158",
          }}
        />
        <div
          style={{
            marginTop: 16,
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            borderTop: "1px solid #eee",
            // 避让全局底部菜单栏（变量已含底部安全区高度）
            padding: `12px 0 calc(12px + var(--goread-navbar-h))`,
          }}
        >
          <button
            onClick={onCancel}
            disabled={loading}
            style={{
              background: "transparent",
              border: "none",
              boxShadow: "none",
              borderRadius: 0,
              outline: "none",
              WebkitAppearance: "none",
              MozAppearance: "none",
              appearance: "none",
              padding: "8px 0",
              color: "#333",
              fontSize: "16px",
              cursor: "pointer",
              width: "100%",
              textAlign: "center",
            }}
          >
            {tc("cancel")}
          </button>
          <button
            onClick={() => {
              if (trimmed && !loading) onConfirm(trimmed);
            }}
            disabled={!trimmed || loading}
            style={{
              background: "transparent",
              border: "none",
              boxShadow: "none",
              borderRadius: 0,
              outline: "none",
              WebkitAppearance: "none",
              MozAppearance: "none",
              appearance: "none",
              padding: "8px 0",
              color: "#d15158",
              fontSize: "16px",
              cursor: trimmed && !loading ? "pointer" : "not-allowed",
              opacity: trimmed && !loading ? 1 : 0.5,
              borderLeft: "1px solid #eee",
              width: "100%",
              textAlign: "center",
            }}
          >
            {loading ? tc("loading") : tc("confirm")}
          </button>
        </div>
      </div>
    </div>
  );
};

export default CreateGroupDialog;

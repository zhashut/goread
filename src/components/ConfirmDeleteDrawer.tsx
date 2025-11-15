import React from "react";

export type DeleteContext = "recent" | "all-groups";

export interface ConfirmDeleteDrawerProps {
  open: boolean;
  context: DeleteContext;
  count: number;
  onCancel: () => void;
  onConfirm: () => void;
}

const ConfirmDeleteDrawer: React.FC<ConfirmDeleteDrawerProps> = ({
  open,
  context,
  count,
  onCancel,
  onConfirm,
}) => {
  if (!open) return null;
  const title = "注意!";
  const desc =
    context === "recent"
      ? `本次操作将会删除 ${count} 个最近阅读记录（不清除阅读进度），是否继续？`
      : `本次操作将会删除 ${count} 个分组（包含分组内所有书籍信息等，不影响源文件），是否继续？`;

  return (
    <div
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0,0,0,0.5)",
        display: "flex",
        flexDirection: "column",
        justifyContent: "flex-end",
        // 提升层级，避免被其他抽屉或浮层覆盖（影响右上圆角视觉）
        zIndex: 1001,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          background: "#fff",
          // 与其它抽屉统一为 20px，圆角更明显
          borderTopLeftRadius: 20,
          borderTopRightRadius: 20,
          overflow: "hidden",
          boxSizing: "border-box",
          backgroundClip: "padding-box",
          // 抽屉高度适中，操作区贴底（容器去掉底部内边距）
          minHeight: "150px",
          padding: "18px 18px 0 18px",
          boxShadow: "0 -6px 20px rgba(0,0,0,0.2)",
        }}
      >
        <div
          style={{ fontSize: "16px", fontWeight: 600, marginBottom: "10px" }}
        >
          {title}
        </div>
        <div
          style={{
            fontSize: "14px",
            color: "#555",
            lineHeight: 1.6,
            marginBottom: "12px",
          }}
        >
          {desc}
        </div>
        {context === "all-groups" && (
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              marginTop: "16px",
            }}
          >
            <input type="checkbox" />
            <span style={{ fontSize: "13px", color: "#777" }}>
              删除本地文件
            </span>
          </label>
        )}
        <div
          style={{
            // 操作区贴着底部，左右两栏并列（参考图2）
            marginTop: 8,
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            borderTop: "1px solid #eee",
            padding: "12px 0 12px",
          }}
        >
          <button
            onClick={onCancel}
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
            取消
          </button>
          <button
            onClick={onConfirm}
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
              cursor: "pointer",
              borderLeft: "1px solid #eee",
              width: "100%",
              textAlign: "center",
            }}
          >
            删除
          </button>
        </div>
      </div>
    </div>
  );
};

export default ConfirmDeleteDrawer;

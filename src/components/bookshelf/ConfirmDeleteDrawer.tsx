import React from "react";
import { useTranslation } from "react-i18next";

export type DeleteContext = "recent" | "all" | "group-detail";

export interface ConfirmDeleteDrawerProps {
  open: boolean;
  context: DeleteContext;
  count: number;
  onCancel: () => void;
  onConfirm: (deleteLocal?: boolean) => void;
}

const ConfirmDeleteDrawer: React.FC<ConfirmDeleteDrawerProps> = ({
  open,
  context,
  count,
  onCancel,
  onConfirm,
}) => {
  // Hooks 必须在条件 return 之前调用：本组件常驻挂载（open 控制渲染），
  // 若任一 Hook 放在 return null 之后，open 在 false/true 间切换会导致
  // hooks 数量跳变，违反 React Hooks 规则（React error #310），渲染崩溃
  const [deleteLocal, setDeleteLocal] = React.useState(false);
  const { t } = useTranslation("bookshelf");
  if (!open) return null;
  const title = t("deleteDrawer.title");
  const desc =
    context === "recent"
      ? t("deleteDrawer.descRecent", { count })
      : context === "all"
        ? t("deleteDrawer.descAll", { count })
        : t("deleteDrawer.descGroupDetail", { count });

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
        {["all", "group-detail"].includes(context) && (
          <button
            onClick={() => setDeleteLocal((v) => !v)}
            style={{
              marginTop: "16px",
              background: "transparent",
              border: "none",
              boxShadow: "none",
              borderRadius: 0,
              WebkitAppearance: "none",
              MozAppearance: "none",
              appearance: "none",
              padding: 0,
              display: "flex",
              alignItems: "center",
              cursor: "pointer",
            }}
            title={deleteLocal ? "取消删除本地文件" : "删除本地文件"}
          >
            {deleteLocal ? (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" style={{ marginRight: "8px" }}>
                <circle cx="12" cy="12" r="9" fill="#d23c3c" />
                <path
                  d="M9 12l2 2 4-4"
                  stroke="#fff"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            ) : (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                <circle
                  cx="12"
                  cy="12"
                  r="9"
                  fill="#fff"
                  stroke="#d23c3c"
                  strokeWidth="2"
                />
              </svg>
            )}
            <span style={{ fontSize: "13px", color: "#777" }}>
              {t("deleteDrawer.deleteLocalFile")}
            </span>
          </button>
        )}
        <div
          style={{
            // 操作区贴着底部，左右两栏并列（参考图2）
            marginTop: 8,
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            borderTop: "1px solid #eee",
            // 避让全局底部菜单栏（变量已含底部安全区高度）
            padding: `12px 0 calc(12px + var(--goread-navbar-h))`,
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
            {t("deleteDrawer.cancel")}
          </button>
          <button
            onClick={() => onConfirm(deleteLocal)}
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
            {t("deleteDrawer.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ConfirmDeleteDrawer;

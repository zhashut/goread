import React from "react";
import { useTranslation } from "react-i18next";
import { IGroup } from "../../types";

export interface MoveToGroupDrawerProps {
  /** 是否显示抽屉 */
  open: boolean;
  /** 可选目标分组列表（不含当前所在分组） */
  groups: IGroup[];
  /** 移动中，禁止重复点击 */
  loading?: boolean;
  onClose: () => void;
  /** 选择目标分组回调；groupId 为 null 表示移出分组 */
  onSelectGroup: (groupId: number | null) => void;
}

/**
 * 「移动到」分组选择底部抽屉
 *
 * 功能描述：批量移动书籍时展示，样式与 CreateGroupDialog 底部抽屉一致；
 *          提供「移出分组」快捷项与全部分组名称列表，点击任一项即以该
 *          分组（或 null = 移出分组）作为目标完成移动。
 *
 * 参数说明：open —— 是否显示抽屉；
 *          groups —— 可选目标分组列表；
 *          loading —— 移动中标志，禁用重复点击；
 *          onClose —— 关闭抽屉回调；
 *          onSelectGroup —— 选择目标分组回调，参数为分组 id，null 表示移出分组。
 *
 * 返回值类型：React.FC，渲染分组选择底部抽屉元素。
 */
const MoveToGroupDrawer: React.FC<MoveToGroupDrawerProps> = ({
  open,
  groups,
  loading = false,
  onClose,
  onSelectGroup,
}) => {
  const { t } = useTranslation('bookshelf');
  const { t: tc } = useTranslation('common');

  return (
    <div
      onClick={() => {
        if (loading) return;
        onClose();
      }}
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
        aria-label={t('moveTo')}
        style={{
          width: "100%",
          background: "#fff",
          borderTopLeftRadius: 20,
          borderTopRightRadius: 20,
          overflow: "hidden",
          boxSizing: "border-box",
          backgroundClip: "padding-box",
          padding: "18px 0 6px",
          boxShadow: "0 -6px 20px rgba(0,0,0,0.2)",
          maxHeight: "60vh",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{ fontSize: "16px", fontWeight: 600, marginBottom: "8px", padding: "0 18px" }}>
          {t('moveTo')}
        </div>
        <div
          className="no-scrollbar"
          style={{ flex: 1, overflowY: "auto", minHeight: 0 }}
        >
          {/* 移出分组快捷项 */}
          <button
            onClick={() => {
              if (loading) return;
              onSelectGroup(null);
            }}
            disabled={loading}
            style={{
              width: "100%",
              minHeight: "48px",
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "0 18px",
              background: "transparent",
              border: "none",
              boxShadow: "none",
              borderRadius: 0,
              cursor: loading ? "not-allowed" : "pointer",
              boxSizing: "border-box",
              textAlign: "left",
            }}
          >
            <span
              style={{
                width: 20,
                height: 20,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              {/* 移出分组图标：文件夹 + 左向箭头 */}
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  d="M3.5 7C3.5 5.9 4.4 5 5.5 5H9.2C9.7 5 10.2 5.2 10.5 5.6L11.7 7H18.5C19.6 7 20.5 7.9 20.5 9V17C20.5 18.1 19.6 19 18.5 19H5.5C4.4 19 3.5 18.1 3.5 17V7Z"
                  stroke="#666"
                  strokeWidth="1.8"
                  strokeLinejoin="round"
                />
                <path
                  d="M13.5 13H8.7m0 0l1.9-1.9M8.7 13l1.9 1.9"
                  stroke="#666"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <span style={{ fontSize: 14, color: "#333" }}>
              {t('removeFromGroup')}
            </span>
          </button>
          {/* 分组列表 */}
          {groups.map((g) => (
            <button
              key={g.id}
              onClick={() => {
                if (loading) return;
                onSelectGroup(g.id);
              }}
              disabled={loading}
              style={{
                width: "100%",
                minHeight: "48px",
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "0 18px",
                background: "transparent",
                border: "none",
                boxShadow: "none",
                borderRadius: 0,
                cursor: loading ? "not-allowed" : "pointer",
                boxSizing: "border-box",
                textAlign: "left",
              }}
            >
              <span
                style={{
                  width: 20,
                  height: 20,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                {/* 分组图标：黄色填充文件夹 */}
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path d="M3.5 7C3.5 5.9 4.4 5 5.5 5H9.2C9.7 5 10.2 5.2 10.5 5.6L11.7 7H18.5C19.6 7 20.5 7.9 20.5 9V17C20.5 18.1 19.6 19 18.5 19H5.5C4.4 19 3.5 18.1 3.5 17V7Z" fill="#F5B840" />
                </svg>
              </span>
              <span
                style={{
                  fontSize: 14,
                  color: "#333",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {g.name}
              </span>
            </button>
          ))}
          {groups.length === 0 && (
            <div
              style={{
                padding: "12px 18px 16px",
                fontSize: 13,
                color: "#999",
                textAlign: "center",
              }}
            >
              {t('noGroups')}
            </div>
          )}
        </div>
        {/* 底部取消按钮（安全区适配） */}
        <div
          style={{
            borderTop: "1px solid #eee",
            // 避让全局底部菜单栏（变量已含底部安全区高度）
            padding: `0 0 calc(6px + var(--goread-navbar-h))`,
          }}
        >
          <button
            onClick={() => {
              if (loading) return;
              onClose();
            }}
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
              padding: "12px 0",
              margin: 0,
              color: "#333",
              fontSize: "16px",
              cursor: loading ? "not-allowed" : "pointer",
              width: "100%",
              textAlign: "center",
            }}
          >
            {loading ? tc('loading') : tc('cancel')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default MoveToGroupDrawer;

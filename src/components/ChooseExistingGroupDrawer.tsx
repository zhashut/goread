import React from "react";
import { useTranslation } from 'react-i18next';
import { IGroup } from "../types";
import GroupCoverGrid from "./bookshelf/GroupCoverGrid";
import { GROUP_GRID_COLUMNS, GROUP_GRID_GAP } from "../constants/ui";

export interface ChooseExistingGroupDrawerProps {
  open: boolean;
  title?: string;
  groups: IGroup[];
  groupPreviews: Record<number, string[]>;
  onClose: () => void;
  onSelectGroup: (groupId: number) => void;
  /** 可选：点击「移到根目录」入口回调；传入时在分组网格最前显示该入口 */
  onSelectRoot?: () => void;
  /** 可选：根目录入口文案；缺省用 group 命名空间的「移到根目录」（导入场景传「书架根目录」） */
  rootLabel?: string;
}

const ChooseExistingGroupDrawer: React.FC<ChooseExistingGroupDrawerProps> = ({
  open,
  title,
  groups,
  groupPreviews,
  onClose,
  onSelectGroup,
  onSelectRoot,
  rootLabel,
}) => {
  const { t } = useTranslation('import');
  const { t: tg } = useTranslation('group');
  const displayTitle = title || t('existingGroups');

  if (!open) return null;

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
        display: "flex",
        alignItems: "flex-end",
        zIndex: 1001,
      }}
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        role="dialog"
        onClick={(e) => e.stopPropagation()}
        className="no-scrollbar"
        style={{
          width: "100%",
          background: "#fff",
          borderTopLeftRadius: 20,
          borderTopRightRadius: 20,
          // 避让全局底部菜单栏（变量已含底部安全区高度）
          padding: `18px 16px calc(24px + var(--goread-navbar-h)) 16px`,
          boxSizing: "border-box",
          height: "50vh",
          maxHeight: "50vh",
          overflowY: "auto",
        }}
      >
        <div style={{ color: "#333", fontSize: 16, fontWeight: 600, marginBottom: 12 }}>
          {displayTitle}
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${GROUP_GRID_COLUMNS}, 1fr)`,
            gap: GROUP_GRID_GAP,
          }}
        >
          {/* 移到根目录入口：与分组卡片并列，将选中书籍移出分组回到书架根目录 */}
          {onSelectRoot && (
            <button
              onClick={() => onSelectRoot()}
              style={{
                appearance: "none",
                WebkitAppearance: "none",
                background: "transparent",
                border: "none",
                outline: "none",
                boxShadow: "none",
                padding: 0,
                textAlign: "left",
                cursor: "pointer",
                width: "100%",
              }}
            >
              <div
                style={{
                  marginBottom: 6,
                  aspectRatio: "3 / 4",
                  borderRadius: 8,
                  background: "#f7f7f7",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {/* 图标：黄色文件夹 + 上向箭头，表示移出到根目录 */}
                <svg width="36" height="36" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M3.5 7C3.5 5.9 4.4 5 5.5 5H9.2C9.7 5 10.2 5.2 10.5 5.6L11.7 7H18.5C19.6 7 20.5 7.9 20.5 9V17C20.5 18.1 19.6 19 18.5 19H5.5C4.4 19 3.5 18.1 3.5 17V7Z" fill="#F5B840" />
                  <path d="M12 15.5V10.5m0 0l-2.2 2.2M12 10.5l2.2 2.2" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              <div style={{ color: "#333", fontSize: 14 }}>{rootLabel || tg('moveToRoot')}</div>
            </button>
          )}
          {groups.map((g) => (
            <button
              key={g.id}
              onClick={() => onSelectGroup(g.id)}
              style={{
                appearance: "none",
                WebkitAppearance: "none",
                background: "transparent",
                border: "none",
                outline: "none",
                boxShadow: "none",
                padding: 0,
                textAlign: "left",
                cursor: "pointer",
                width: "100%",
              }}
            >
              <div style={{ marginBottom: 6 }}>
                <GroupCoverGrid covers={groupPreviews[g.id] || []} variant="compact" tileRatio="3 / 4" />
              </div>
              <div style={{ color: "#333", fontSize: 14 }}>{g.name}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

export default ChooseExistingGroupDrawer;

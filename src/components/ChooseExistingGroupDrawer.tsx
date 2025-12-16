import React from "react";
import { IGroup } from "../types";
import GroupCoverGrid from "./GroupCoverGrid";
import { getSafeAreaInsets } from "../utils/layout";

export interface ChooseExistingGroupDrawerProps {
  open: boolean;
  title?: string;
  groups: IGroup[];
  groupPreviews: Record<number, string[]>;
  onClose: () => void;
  onSelectGroup: (groupId: number) => void;
}

const ChooseExistingGroupDrawer: React.FC<ChooseExistingGroupDrawerProps> = ({
  open,
  title = "现有分组",
  groups,
  groupPreviews,
  onClose,
  onSelectGroup,
}) => {
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
      onClick={onClose}
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
          padding: `18px 16px calc(24px + ${getSafeAreaInsets().bottom}) 16px`,
          boxSizing: "border-box",
          height: "50vh",
          maxHeight: "50vh",
          overflowY: "auto",
        }}
      >
        <div style={{ color: "#333", fontSize: 16, fontWeight: 600, marginBottom: 12 }}>
          {title}
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: 12,
          }}
        >
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
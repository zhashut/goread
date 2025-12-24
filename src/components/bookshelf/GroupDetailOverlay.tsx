import React, { useState, useRef, useEffect } from "react";
import { useTranslation } from 'react-i18next';
import { useAppNav } from "../../router/useAppNav";
import { IGroup } from "../../types";
import { IconDelete, IconMove } from "../Icons";
import { TOP_BAR_MARGIN_BOTTOM } from "../../constants/ui";
import { TopBar } from "./TopBar";
import { Toast } from "../Toast";
import { groupService } from "../../services";
import { GroupDetail } from "../GroupDetail";
import { getSafeAreaInsets } from "../../utils/layout";
import { useDragGuard } from "../../utils/gesture";

interface GroupDetailOverlayProps {
  groupId: number;
  groups: IGroup[];
  onClose: () => void;
  onGroupUpdate: (groupId: number, newName: string) => void;
}

export const GroupDetailOverlay: React.FC<GroupDetailOverlayProps> = ({
  groupId,
  groups,
  onClose,
  onGroupUpdate,
}) => {
  const { t } = useTranslation('group');
  const nav = useAppNav();
  const { dragActive } = useDragGuard();

  const [groupDetailSelectionActive, setGroupDetailSelectionActive] = useState(false);
  const [groupDetailSelectedCount, setGroupDetailSelectedCount] = useState(0);

  // 分组重命名状态
  const [isEditingGroupName, setIsEditingGroupName] = useState(false);
  const [editingGroupName, setEditingGroupName] = useState("");
  const [toastMsg, setToastMsg] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);
  const justFinishedEditingRef = useRef(false);

  useEffect(() => {
    const onSel = (e: Event) => {
      const detail: any = (e as any).detail || {};
      setGroupDetailSelectionActive(!!detail.active);
      setGroupDetailSelectedCount(Number(detail.count) || 0);
    };
    window.addEventListener("goread:group-detail:selection", onSel as any);
    return () => window.removeEventListener("goread:group-detail:selection", onSel as any);
  }, []);

  const handleSaveGroupName = async () => {
    const name = editingGroupName.trim();
    if (!name) {
      // 如果名称为空，视为取消修改，恢复原名并退出编辑态
      const currentGroup = groups.find(g => g.id === groupId);
      if (currentGroup) {
        setEditingGroupName(currentGroup.name);
      }
      justFinishedEditingRef.current = true;
      setTimeout(() => { justFinishedEditingRef.current = false; }, 300);
      setIsEditingGroupName(false);
      return;
    }

    const currentGroup = groups.find(g => g.id === groupId);
    if (currentGroup && name === currentGroup.name) {
      justFinishedEditingRef.current = true;
      setTimeout(() => { justFinishedEditingRef.current = false; }, 300);
      setIsEditingGroupName(false);
      return;
    }

    // 前端查重（排除当前分组）
    const isDuplicate = groups.some(g => g.name === name && g.id !== groupId);
    if (isDuplicate) {
      setToastMsg(t('groupNameExists'));
      setTimeout(() => editInputRef.current?.focus(), 0);
      return;
    }

    try {
      await groupService.updateGroup(groupId, name);
      // 更新本地状态
      onGroupUpdate(groupId, name);
      justFinishedEditingRef.current = true;
      setTimeout(() => { justFinishedEditingRef.current = false; }, 300);
      setIsEditingGroupName(false);
    } catch (e: any) {
      console.error("Update group name failed", e);
      setToastMsg(typeof e === 'string' ? e : (e.message || t('updateFailed')));
      setTimeout(() => editInputRef.current?.focus(), 0);
    }
  };

  return (
    <div
      onClick={() => {
        if (isEditingGroupName || justFinishedEditingRef.current) {
          // 如果正在编辑或刚结束编辑，点击外部仅触发 blur 提交/退出编辑态，不关闭详情页
          return;
        }
        if (groupDetailSelectionActive) {
          const evt = new Event("goread:group-detail:exit-selection");
          window.dispatchEvent(evt);
          return;
        }
        onClose();
        setGroupDetailSelectionActive(false);
        setGroupDetailSelectedCount(0);
      }}
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: "rgba(225,225,225,0.6)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {groupDetailSelectionActive && (
        <TopBar
          mode="selection"
          selectedCount={groupDetailSelectedCount}
          onExitSelection={() => nav.goBack()}
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            background: "#fff",
            zIndex: 101,
            padding: `calc(${getSafeAreaInsets().top} + 12px) 0 8px 16px`,
            marginBottom: 0,
          }}
          selectionActions={
            <>
              <button
                aria-label={t('changeGroup')}
                title={t('changeGroup')}
                style={{
                  background: "none",
                  border: "none",
                  boxShadow: "none",
                  borderRadius: 0,
                  cursor: groupDetailSelectedCount === 0 || dragActive ? "not-allowed" : "pointer",
                  opacity: groupDetailSelectedCount === 0 || dragActive ? 0.4 : 1,
                  padding: 0,
                  width: "36px",
                  height: "36px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
                disabled={groupDetailSelectedCount === 0 || dragActive}
                onClick={() => {
                  if (groupDetailSelectedCount === 0 || dragActive) return;
                  const evt = new Event("goread:group-detail:open-move");
                  window.dispatchEvent(evt);
                }}
              >
                <IconMove width={24} height={24} fill="#333" />
              </button>
              <button
                aria-label={t('delete')}
                title={t('delete')}
                style={{
                  background: "none",
                  border: "none",
                  boxShadow: "none",
                  borderRadius: 0,
                  cursor: groupDetailSelectedCount === 0 || dragActive ? "not-allowed" : "pointer",
                  opacity: groupDetailSelectedCount === 0 || dragActive ? 0.4 : 1,
                  padding: 0,
                  width: "36px",
                  height: "36px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
                disabled={groupDetailSelectedCount === 0 || dragActive}
                onClick={() => {
                  if (groupDetailSelectedCount === 0 || dragActive) return;
                  const evt = new Event("goread:group-detail:open-confirm");
                  window.dispatchEvent(evt);
                }}
              >
                <IconDelete width={24} height={24} fill="#333" />
              </button>
              <button
                aria-label={t('selectAll')}
                title={t('selectAll')}
                style={{
                  background: "none",
                  border: "none",
                  boxShadow: "none",
                  borderRadius: 0,
                  cursor: "pointer",
                  padding: 0,
                  width: "36px",
                  height: "36px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
                onClick={() => {
                  const evt = new Event("goread:group-detail:select-all");
                  window.dispatchEvent(evt);
                }}
              >
                <svg
                  width={24}
                  height={24}
                  viewBox="0 0 24 24"
                  fill="none"
                >
                  {(() => {
                    const allCount = (groups.find((g) => g.id === groupId)?.book_count || 0);
                    const isAll = allCount > 0 && groupDetailSelectedCount === allCount;
                    const stroke = isAll ? "#d23c3c" : "#333";
                    return (
                      <>
                        <rect
                          x="3"
                          y="3"
                          width="7"
                          height="7"
                          stroke={stroke}
                          strokeWidth="2"
                          rx="1"
                        />
                        <rect
                          x="14"
                          y="3"
                          width="7"
                          height="7"
                          stroke={stroke}
                          strokeWidth="2"
                          rx="1"
                        />
                        <rect
                          x="3"
                          y="14"
                          width="7"
                          height="7"
                          stroke={stroke}
                          strokeWidth="2"
                          rx="1"
                        />
                        <rect
                          x="14"
                          y="14"
                          width="7"
                          height="7"
                          stroke={stroke}
                          strokeWidth="2"
                          rx="1"
                        />
                      </>
                    );
                  })()}
                </svg>
              </button>
            </>
          }
        />
      )}
      <div
        style={{
          width: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          marginTop: TOP_BAR_MARGIN_BOTTOM + 35,
        }}
      >
        {/* 标题在容器外居中 */}
        {/* 标题区域：支持点击编辑 */}
        {isEditingGroupName ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              marginBottom: "12px",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <input
              ref={editInputRef}
              value={editingGroupName}
              onChange={(e) => setEditingGroupName(e.target.value)}
              onBlur={handleSaveGroupName}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.currentTarget.blur();
                }
              }}
              style={{
                fontSize: "16px",
                fontWeight: 500,
                color: "#333",
                textAlign: "center",
                border: "none",
                background: "transparent",
                outline: "none",
                boxShadow: "none",
                width: `${Math.max(2, editingGroupName.length * 1.3)}em`,
                padding: "0",
                fontFamily: "inherit",
                caretColor: "#d23c3c",
              }}
              autoFocus
            />
            {editingGroupName && (
              <button
                onMouseDown={(e) => {
                  // 使用 onMouseDown 阻止默认行为，防止输入框失去焦点触发 blur
                  e.preventDefault();
                  setEditingGroupName("");
                  // 保持焦点
                  setTimeout(() => editInputRef.current?.focus(), 0);
                }}
                style={{
                  background: "transparent",
                  border: "none",
                  padding: "4px",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  boxShadow: "none",
                  marginLeft: "4px",
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" fill="#888" />
                  <path d="M8 8l8 8M16 8l-8 8" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
            )}
          </div>
        ) : (
          <div
            onClick={(e) => {
              e.stopPropagation();
              if (groupDetailSelectionActive) return; // 选择模式下禁用编辑
              const g = groups.find((g) => g.id === groupId);
              if (g) {
                setEditingGroupName(g.name);
                setIsEditingGroupName(true);
              }
            }}
            style={{
              fontSize: "16px",
              fontWeight: 500,
              color: "#333",
              textAlign: "center",
              marginBottom: "12px",
              cursor: "text",
              borderBottom: "1px solid transparent",
              display: "inline-block",
              padding: "0 4px",
              maxWidth: "80%",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis"
            }}
          >
            {groups.find((g) => g.id === groupId)?.name || t('defaultGroupName')}
          </div>
        )}
        {/* 抽屉主体：宽度占满，高度85%，居中位置 */}
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            width: "100%",
            height: "75vh",
            maxHeight: "75vh",
            overflow: "hidden",
            background: "#f7f7f7",
          }}
        >
          <div style={{ width: "100%", height: "100%" }}>
            <GroupDetail
              groupIdProp={groupId}
              onClose={() => {
                onClose();
              }}
            />
          </div>
        </div>
      </div>
      <Toast message={toastMsg} onClose={() => setToastMsg("")} />
    </div>
  );
};

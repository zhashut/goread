import React, { useEffect, useState, useRef } from "react";
import { useTranslation } from 'react-i18next';

interface GroupingDrawerProps {
  open: boolean;
  onClose: () => void;
  newGroupName: string;
  onNewGroupNameChange: (value: string) => void;
  onChooseExistingGroup: () => void;
  onConfirmName: () => void;
  /** 可选：点击「不分组，导入到书架根目录」入口回调；传入时在红色分隔线下显示该入口 */
  onImportToRoot?: () => void;
  loading?: boolean;
}

const GroupingDrawer: React.FC<GroupingDrawerProps> = ({
  open,
  onClose,
  newGroupName,
  onNewGroupNameChange,
  onChooseExistingGroup,
  onConfirmName,
  onImportToRoot,
  loading = false,
}) => {
  const { t } = useTranslation('import');
  // 本地输入状态，配合输入法合成事件，避免中文输入被打断
  const [localValue, setLocalValue] = useState<string>(newGroupName || "");
  const [isComposing, setIsComposing] = useState<boolean>(false);
  const [isInputFocused, setIsInputFocused] = useState<boolean>(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setLocalValue(newGroupName || "");
  }, [newGroupName]);

  // 监听键盘收起事件，处理点击键盘收起按钮但未触发 blur 的情况
  useEffect(() => {
    let useNativeEvent = false;
    const vp = window.visualViewport;
    let maxH = vp?.height ?? window.innerHeight;
    let lastW = window.innerWidth;

    // 键盘收起时让输入框失焦
    const blurInput = () => {
      if (document.activeElement === inputRef.current) {
        setIsInputFocused(false);
        inputRef.current?.blur();
      }
    };

    // 原生键盘事件（优先使用，由 tauri-plugin-virtual-keyboard 等插件提供）
    const onNativeHide = () => { useNativeEvent = true; blurInput(); };

    // 降级方案：通过视口高度变化检测键盘收起
    const onResize = () => {
      if (useNativeEvent) return;
      const h = vp?.height ?? window.innerHeight;
      const w = window.innerWidth;
      // 屏幕旋转时重置基准
      if (Math.abs(w - lastW) > 50) { lastW = w; maxH = h; return; }
      lastW = w;
      if (h > maxH) maxH = h;
      // 高度恢复到接近最大值时，判定键盘已收起
      if (maxH - h < 100) blurInput();
    };

    window.addEventListener("keyboardWillHide", onNativeHide);
    window.addEventListener("keyboardDidHide", onNativeHide);
    (vp || window).addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("keyboardWillHide", onNativeHide);
      window.removeEventListener("keyboardDidHide", onNativeHide);
      (vp || window).removeEventListener("resize", onResize);
    };
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
          // 避让全局底部菜单栏（变量已含底部安全区高度）
          padding: `14px 16px calc(14px + var(--goread-navbar-h)) 16px`,
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
          {t('howToGroup')}
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
          placeholder={t('inputNewGroupName')}
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

        {/* 不分组入口：跳过分组直接导入到书架根目录（仅键盘收起时显示，与操作行同规则） */}
        {onImportToRoot && !isInputFocused && (
          <button
            onClick={onImportToRoot}
            style={{
              background: "none",
              border: "none",
              color: "#999",
              cursor: "pointer",
              padding: 0,
              fontSize: 13,
              alignSelf: "flex-start",
              marginTop: 16,
            }}
          >
            {t('importToRoot')}
          </button>
        )}

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
              {t('importToExistingGroup')}
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
              {t('confirmName')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default GroupingDrawer;

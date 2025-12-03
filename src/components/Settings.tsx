import React, { useEffect, useState } from "react";
import {
  getReaderSettings,
  saveReaderSettings,
  ReaderSettings,
} from "../services";
import {
  RENDER_QUALITY_OPTIONS,
  RECENT_DISPLAY_COUNT_OPTIONS,
  RECENT_DISPLAY_COUNT_UNLIMITED,
  SCROLL_SPEED_MIN,
  SCROLL_SPEED_MAX,
  SCROLL_SPEED_STEP,
  PAGE_GAP_MIN,
  PAGE_GAP_MAX,
  PAGE_GAP_STEP,
  SETTINGS_SAVE_DEBOUNCE_MS,
} from "../constants/config";
import { getSafeAreaInsets } from "../utils/layout";
import { CustomSelect } from "./CustomSelect";

export const Settings: React.FC = () => {
  const [settings, setSettings] = useState<ReaderSettings>(getReaderSettings());

  const goBack = () => {
    window.history.back();
  };

  useEffect(() => {
    // 防抖保存
    const id = setTimeout(() => {
      saveReaderSettings(settings);
    }, SETTINGS_SAVE_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [settings]);

  const Row: React.FC<{ label: string; right?: React.ReactNode }> = ({
    label,
    right,
  }) => (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "12px 4px",
        borderBottom: "1px solid #eee",
      }}
    >
      <div style={{ color: "#333", fontSize: "15px" }}>{label}</div>
      <div>{right}</div>
    </div>
  );

  return (
    <div
      style={{
        minHeight: "100vh",
        backgroundColor: "#fafafa",
        display: "flex",
        flexDirection: "column",
        paddingBottom: getSafeAreaInsets().bottom,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: `calc(${getSafeAreaInsets().top} + 12px) 16px 12px 16px`,
          backgroundColor: "#fff",
          boxShadow: "0 1px 6px rgba(0,0,0,0.08)",
        }}
      >
        <button
          onClick={goBack}
          style={{
            background: "transparent",
            border: "none",
            color: "#333",
            fontSize: "25px",
            cursor: "pointer",
            marginRight: "20px",
            padding: 0,
            boxShadow: "none",
            borderRadius: 0,
            outline: "none",
            WebkitAppearance: "none",
            MozAppearance: "none",
            appearance: "none",
          }}
          title="返回"
        >
          {"<"}
        </button>
        <div style={{ fontSize: "17.5px", fontWeight: 600, color: "#333" }}>
          设置
        </div>
      </div>

      <div
        style={{
          backgroundColor: "#fff",
          borderRadius: "8px",
          padding: "4px 16px",
          margin: "16px",
          boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
        }}
      >
        <Row
          label="音量键翻页"
          right={
            <input
              className="settings-toggle"
              type="checkbox"
              checked={settings.volumeKeyTurnPage}
              onChange={(e) =>
                setSettings((s) => ({
                  ...s,
                  volumeKeyTurnPage: e.target.checked,
                }))
              }
            />
          }
        />
        <Row
          label="点击翻页"
          right={
            <input
              className="settings-toggle"
              type="checkbox"
              checked={settings.clickTurnPage}
              onChange={(e) =>
                setSettings((s) => ({ ...s, clickTurnPage: e.target.checked }))
              }
            />
          }
        />
        <Row
          label="显示状态栏"
          right={
            <input
              className="settings-toggle"
              type="checkbox"
              checked={settings.showStatusBar}
              onChange={(e) => {
                const checked = e.target.checked;
                setSettings((s) => ({ ...s, showStatusBar: checked }));
                // 仅在移动端浏览器尝试切换全屏；桌面 Tauri/Web 不触发，避免窗口最大化
                const ua = navigator.userAgent || "";
                const isMobile = /Android|iPhone|iPad|iPod/i.test(ua);
                const isTauri =
                  typeof (window as any).__TAURI__ !== "undefined";
                if (isMobile && !isTauri) {
                  if (checked) {
                    document.exitFullscreen?.().catch(() => {});
                  } else {
                    document.documentElement
                      .requestFullscreen?.()
                      .catch(() => {});
                  }
                }
              }}
            />
          }
        />
        <Row
          label="翻页动画"
          right={
            <input
              className="settings-toggle"
              type="checkbox"
              checked={settings.pageTransition}
              onChange={(e) =>
                setSettings((s) => ({ ...s, pageTransition: e.target.checked }))
              }
            />
          }
        />

        <Row
          label="最近显示数量"
          right={
            <CustomSelect
              value={settings.recentDisplayCount}
              options={[
                ...RECENT_DISPLAY_COUNT_OPTIONS.map((n) => ({
                  value: n,
                  label: n,
                })),
                { value: RECENT_DISPLAY_COUNT_UNLIMITED, label: "不限" },
              ]}
              onChange={(val) =>
                setSettings((s) => ({
                  ...s,
                  recentDisplayCount: Number(val),
                }))
              }
            />
          }
        />

        <Row
          label="书籍渲染质量"
          right={
            <CustomSelect
              value={settings.renderQuality || "standard"}
              options={RENDER_QUALITY_OPTIONS}
              onChange={(val) =>
                setSettings((s) => ({
                  ...s,
                  renderQuality: val as string,
                }))
              }
            />
          }
        />

        <div style={{ padding: "12px 0" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: "8px",
            }}
          >
            <span style={{ color: "#333", fontSize: "15px" }}>滚动速度</span>
            <span style={{ color: "#999", fontSize: "12px" }}>
              {settings.scrollSpeed} px/s
            </span>
          </div>
          {(() => {
            const min = SCROLL_SPEED_MIN,
              max = SCROLL_SPEED_MAX;
            const val = settings.scrollSpeed;
            const pct = Math.max(
              0,
              Math.min(100, Math.round(((val - min) / (max - min)) * 100))
            );
            const track = `linear-gradient(to right, #d15158 0%, #d15158 ${pct}%, #e0e0e0 ${pct}%, #e0e0e0 100%)`;
            return (
              <input
                className="settings-range"
                type="range"
                min={min}
                max={max}
                step={SCROLL_SPEED_STEP}
                value={val}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    scrollSpeed: Number(e.target.value),
                  }))
                }
                style={{ width: "100%", background: track }}
              />
            );
          })()}
        </div>

        <div style={{ padding: "12px 0" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: "8px",
            }}
          >
            <span style={{ color: "#333", fontSize: "15px" }}>页面间隙</span>
            <span style={{ color: "#999", fontSize: "12px" }}>
              {settings.pageGap} px
            </span>
          </div>
          {(() => {
            const min = PAGE_GAP_MIN,
              max = PAGE_GAP_MAX;
            const val = settings.pageGap;
            const pct = Math.max(
              0,
              Math.min(100, Math.round(((val - min) / (max - min)) * 100))
            );
            const track = `linear-gradient(to right, #d15158 0%, #d15158 ${pct}%, #e0e0e0 ${pct}%, #e0e0e0 100%)`;
            return (
              <input
                className="settings-range"
                type="range"
                min={min}
                max={max}
                step={PAGE_GAP_STEP}
                value={val}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    pageGap: Number(e.target.value),
                  }))
                }
                style={{ width: "100%", background: track }}
              />
            );
          })()}
        </div>
      </div>
    </div>
  );
};

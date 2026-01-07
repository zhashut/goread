import React, { useEffect, useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import { getReaderSettings, saveReaderSettings, ReaderSettings, LanguageSetting, bookService } from "../services";
import { cacheConfigService } from "../services/cacheConfigService";
import type { ReaderTheme } from "../services";
import { useAppNav } from "../router/useAppNav";
import { supportedLanguages, changeLanguage } from "../locales";
import { getSystemAppLanguage } from "../services/systemLanguageService";
// 注意：此处特意不导入 statusBarService
// 状态栏控制应仅在阅读页进行，而非设置页
import {
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
import {
  SETTINGS_BUTTON_PADDING,
  SETTINGS_BUTTON_FONT_SIZE,
  SETTINGS_BUTTON_RADIUS,
  SETTINGS_BUTTON_FONT_WEIGHT,
} from "../constants/ui";
import { getSafeAreaInsets } from "../utils/layout";
import { CustomSelect } from "./CustomSelect";
import { PageHeader } from "./PageHeader";
import { exportAppData, importAppData } from "../services/dataBackupService";
import { Toast } from "./Toast";
import { IconInfo } from "./Icons";

export const Settings: React.FC = () => {
  const { t } = useTranslation('settings');
  const [settings, setSettings] = useState<ReaderSettings>(getReaderSettings());
  const [toastMessage, setToastMessage] = useState("");
  const [showCacheHint, setShowCacheHint] = useState(false);
  const isFirstRender = useRef(true);

  const nav = useAppNav();

  const goBack = () => {
    nav.goBack();
  };

  // 处理语言切换
  const handleLanguageChange = async (lng: string | number) => {
    const value = String(lng) as LanguageSetting;

    if (value === 'system') {
      // 跟随系统：实时解析一次当前系统语言，并设置 i18n
      const appLang = await getSystemAppLanguage();
      await changeLanguage(appLang);
      setSettings((s) => ({ ...s, language: 'system' }));
    } else {
      // 显式选择 zh/en
      await changeLanguage(value as 'zh' | 'en');
      setSettings((s) => ({ ...s, language: value as 'zh' | 'en' }));
    }
  };

  // 获取渲染质量选项（根据当前语言）
  const getRenderQualityOptions = () => {
    return [
      { value: "thumbnail", label: t('quality.thumbnail') },
      { value: "standard", label: t('quality.standard') },
      { value: "high", label: t('quality.high') },
      { value: "best", label: t('quality.best') },
    ];
  };

  useEffect(() => {
    // 防抖保存
    const id = setTimeout(() => {
      saveReaderSettings(settings);
    }, SETTINGS_SAVE_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [settings]);

  // 缓存有效期变更时同步到后端
  const initialCacheExpiryDays = useRef(settings.cacheExpiryDays);
  useEffect(() => {
    // 跳过首次渲染，避免初始化时显示 Toast
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    // 只有当值实际发生变化时才同步到后端
    if (settings.cacheExpiryDays === initialCacheExpiryDays.current) {
      return;
    }
    initialCacheExpiryDays.current = settings.cacheExpiryDays;
    const days = typeof settings.cacheExpiryDays === "number" ? settings.cacheExpiryDays : 0;
    cacheConfigService.setCacheExpiry(days).then((success) => {
      if (success) {
        setToastMessage(t('cacheExpiry.updateSuccess'));
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.cacheExpiryDays]);

  const Row: React.FC<{ label: string | React.ReactNode; right?: React.ReactNode }> = ({
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
      <div style={{ color: "#333", fontSize: "15px", display: "flex", alignItems: "center" }}>{label}</div>
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
      {/* Tooltip Backdrop */}
      {showCacheHint && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 998,
            backgroundColor: "transparent",
          }}
          onClick={() => setShowCacheHint(false)}
        />
      )}
      
      <PageHeader
        title={t('title')}
        onBack={goBack}
        style={{ boxShadow: "0 1px 6px rgba(0,0,0,0.08)" }}
      />

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
          label={t('volumeKeyTurnPage')}
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
          label={t('clickTurnPage')}
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
          label={t('showStatusBar')}
          right={
            <input
              className="settings-toggle"
              type="checkbox"
              checked={settings.showStatusBar}
              onChange={(e) => {
                // 仅保存设置，实际的状态栏控制在阅读页进行
                setSettings((s) => ({ ...s, showStatusBar: e.target.checked }));
              }}
            />
          }
        />

        <Row
          label={t('recentDisplayCount')}
          right={
            <CustomSelect
              value={settings.recentDisplayCount}
              options={[
                { value: RECENT_DISPLAY_COUNT_UNLIMITED, label: t('unlimited') },
                ...RECENT_DISPLAY_COUNT_OPTIONS.map((n) => ({
                  value: n,
                  label: n,
                })),
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
          label={t('renderQuality')}
          right={
            <CustomSelect
              value={settings.renderQuality || "standard"}
              options={getRenderQualityOptions()}
              onChange={(val) =>
                setSettings((s) => ({
                  ...s,
                  renderQuality: val as string,
                }))
              }
            />
          }
        />

        <Row
          label={t('theme.label')}
          right={
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <CustomSelect
                value={settings.theme || "light"}
                options={[
                  { value: "light", label: t('theme.light') },
                  { value: "dark", label: t('theme.dark') },
                ]}
                onChange={(val) => {
                  const theme = String(val) as ReaderTheme;
                  setSettings((s) => ({
                    ...s,
                    theme,
                  }));
                  bookService.resetAllBookThemes().catch(() => { });
                }}
              />
              <button
                style={{
                  padding: SETTINGS_BUTTON_PADDING,
                  fontSize: SETTINGS_BUTTON_FONT_SIZE,
                  borderRadius: SETTINGS_BUTTON_RADIUS,
                  fontWeight: SETTINGS_BUTTON_FONT_WEIGHT,
                  border: "1px solid #d15158",
                  background: "#fff",
                  color: "#d15158",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
                onClick={async () => {
                  try {
                    await bookService.resetAllBookThemes();
                    setToastMessage(t('theme.resetSuccess'));
                  } catch {
                  }
                }}
              >
                {t('theme.reset')}
              </button>
            </div>
          }
        />

        <Row
          label={t('language')}
          right={
            <CustomSelect
              value={settings.language || 'system'}
              options={[
                { value: 'system', label: t('languageFollowSystem') },
                ...supportedLanguages.map((lang) => ({
                  value: lang.code,
                  label: lang.label,
                })),
              ]}
              onChange={handleLanguageChange}
            />
          }
        />

        <Row
          label={
            <div style={{ display: "flex", alignItems: "center", position: "relative" }}>
              {t('cacheExpiry.label')}
              {(typeof settings.cacheExpiryDays === "number" ? settings.cacheExpiryDays : 0) === 0 && (
                <div
                  style={{
                    width: 20,
                    height: 20,
                    marginLeft: 6,
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "#999",
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowCacheHint(!showCacheHint);
                  }}
                >
                  <IconInfo width="16" height="16" fill="currentColor" />
                </div>
              )}
              
              {/* Tooltip */}
              {showCacheHint && (
                <div
                  style={{
                    position: "absolute",
                    bottom: "100%",
                    left: "50%",
                    transform: "translateX(-20%)",
                    marginBottom: 10,
                    padding: "8px 12px",
                    backgroundColor: "rgba(0, 0, 0, 0.8)",
                    color: "#fff",
                    fontSize: "12px",
                    borderRadius: "6px",
                    zIndex: 999,
                    width: "max-content",
                    maxWidth: "200px",
                    lineHeight: 1.4,
                    boxShadow: "0 2px 10px rgba(0,0,0,0.2)",
                    whiteSpace: "normal",
                  }}
                  onClick={(e) => e.stopPropagation()} // 防止点击 tooltip 自身关闭
                >
                  {t('cacheExpiry.unlimitedHint')}
                  {/* Arrow */}
                  <div
                    style={{
                      position: "absolute",
                      top: "100%",
                      left: "20%",
                      marginLeft: "-5px",
                      borderWidth: "5px",
                      borderStyle: "solid",
                      borderColor: "rgba(0, 0, 0, 0.8) transparent transparent transparent",
                    }}
                  />
                </div>
              )}
            </div>
          }
          right={
            <CustomSelect
              value={typeof settings.cacheExpiryDays === "number" ? settings.cacheExpiryDays : 0}
              options={[
                { value: 0, label: t('unlimited') },
                { value: 1, label: t('cacheExpiry.days', { count: 1 }) },
                { value: 3, label: t('cacheExpiry.days', { count: 3 }) },
                { value: 7, label: t('cacheExpiry.days', { count: 7 }) },
                { value: 15, label: t('cacheExpiry.days', { count: 15 }) },
                { value: 30, label: t('cacheExpiry.days', { count: 30 }) },
              ]}
              onChange={(val) =>
                setSettings((s) => ({
                  ...s,
                  cacheExpiryDays: Number(val),
                }))
              }
            />
          }
        />

        <Row
          label={t('dataManagement')}
          right={
            <div style={{ display: "flex", gap: 10 }}>
              <button
                style={{
                  padding: SETTINGS_BUTTON_PADDING,
                  fontSize: SETTINGS_BUTTON_FONT_SIZE,
                  borderRadius: SETTINGS_BUTTON_RADIUS,
                  fontWeight: SETTINGS_BUTTON_FONT_WEIGHT,
                  border: "1px solid #d15158",
                  background: "#fff",
                  color: "#d15158",
                  cursor: "pointer",
                }}
                onClick={() => {
                  exportAppData();
                }}
              >
                {t('export')}
              </button>
              <button
                style={{
                  padding: SETTINGS_BUTTON_PADDING,
                  fontSize: SETTINGS_BUTTON_FONT_SIZE,
                  borderRadius: SETTINGS_BUTTON_RADIUS,
                  fontWeight: SETTINGS_BUTTON_FONT_WEIGHT,
                  border: "1px solid #d15158",
                  background: "#fff",
                  color: "#d15158",
                  cursor: "pointer",
                }}
                onClick={() => {
                  importAppData();
                }}
              >
                {t('import')}
              </button>
            </div>
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
            <span style={{ color: "#333", fontSize: "15px" }}>{t('scrollSpeed')}</span>
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
            <span style={{ color: "#333", fontSize: "15px" }}>{t('pageGap')}</span>
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
      {toastMessage && (
        <Toast
          message={toastMessage}
          onClose={() => setToastMessage("")}
        />
      )}
    </div>
  );
};

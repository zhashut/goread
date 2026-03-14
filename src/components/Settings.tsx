import React, { useEffect, useState, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { getReaderSettings, saveReaderSettings, ReaderSettings, LanguageSetting, bookService, log } from "../services";
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
  TTS_RATE_MIN,
  TTS_RATE_MAX,
  TTS_RATE_DEFAULT,
  TTS_RATE_STEP,
} from "../constants/tts";
import {
  SETTINGS_BUTTON_PADDING,
  SETTINGS_BUTTON_FONT_SIZE,
  SETTINGS_BUTTON_RADIUS,
  SETTINGS_BUTTON_FONT_WEIGHT,
} from "../constants/ui";
import { getSafeAreaInsets } from "../utils/layout";
import { CustomSelect } from "./CustomSelect";
import { PageHeader } from "./PageHeader";
import { exportAppData, importAppData, exitApp } from "../services/dataBackupService";
import { Toast } from "./Toast";
import { IconInfo } from "./Icons";
import { Loading } from "./Loading";
import { NativeTTSClient, WebSpeechClient } from "../services/tts";
import type { TTSVoice } from "../services/tts";

type TTSVoiceWithEngine = TTSVoice & { engine: string };

export const Settings: React.FC = () => {
  const { t } = useTranslation('settings');
  const [settings, setSettings] = useState<ReaderSettings>(getReaderSettings());
  const [toastMessage, setToastMessage] = useState("");
  const [showCacheHint, setShowCacheHint] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingText, setLoadingText] = useState("");
  const isFirstRender = useRef(true);
  const [ttsVoicesLoading, setTtsVoicesLoading] = useState(false);
  const [ttsVoices, setTtsVoices] = useState<TTSVoiceWithEngine[]>([]);

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

  const ttsLoadSeq = useRef(0);
  const reloadTtsVoices = useCallback(async (reason: string) => {
    const seq = ++ttsLoadSeq.current;
    setTtsVoicesLoading(true);
    try {
      const loadNative = async (): Promise<TTSVoiceWithEngine[]> => {
        const native = new NativeTTSClient();
        const ok = await native.init().catch(() => false);
        if (!ok) {
          await native.shutdown().catch(() => {});
          void log(`[TTS][Settings] NativeTTS init 失败: reason=${reason}`, "warn");
          return [];
        }
        const initInfo = native.getInitInfo?.();
        void log(
          `[TTS][Settings] NativeTTS init 成功: reason=${reason} mode=${initInfo?.mode} status=${initInfo?.status} offlineReady=${initInfo?.offlineReady} defaultEngine=${initInfo?.defaultEngine ?? ""}`,
          "info",
        );
        const defaultEngine = initInfo?.defaultEngine;
        if (defaultEngine) {
          const current = getReaderSettings();
          const prev = current.ttsNativeDefaultEngine;
          if (prev && prev !== defaultEngine) {
            void log(
              `[TTS][Settings] 系统默认 TTS 引擎已变更: ${prev} -> ${defaultEngine}，清理 native-tts 语音选择`,
              "warn",
            );
            saveReaderSettings({
              ttsNativeDefaultEngine: defaultEngine,
              ttsVoiceByEngine: {
                ...(current.ttsVoiceByEngine || {}),
                "native-tts": "default",
              },
            });
            setSettings((s) => ({
              ...s,
              ttsNativeDefaultEngine: defaultEngine,
              ttsVoiceByEngine: {
                ...(s.ttsVoiceByEngine || {}),
                "native-tts": "default",
              },
            }));
          } else if (!prev) {
            saveReaderSettings({ ttsNativeDefaultEngine: defaultEngine });
            setSettings((s) => ({ ...s, ttsNativeDefaultEngine: defaultEngine }));
          }
        }
        const voices = native.getVoices() || [];
        await native.shutdown().catch(() => {});
        void log(`[TTS][Settings] NativeTTS voices 数量: ${voices.length}`, "info");
        return voices.map((v) => ({ ...v, engine: native.name }));
      };

      const loadWebSpeech = async (): Promise<TTSVoiceWithEngine[]> => {
        const web = new WebSpeechClient({ allowRemoteVoices: true });
        const ok = await web.init().catch(() => false);
        if (!ok) {
          await web.shutdown().catch(() => {});
          void log(`[TTS][Settings] WebSpeech init 失败: reason=${reason}`, "warn");
          return [];
        }
        const voices = web.getVoices() || [];
        await web.shutdown().catch(() => {});
        void log(`[TTS][Settings] WebSpeech voices 数量: ${voices.length}`, "info");
        return voices.map((v) => ({ ...v, engine: web.name }));
      };

      const [nativeRes, webRes] = await Promise.allSettled([loadNative(), loadWebSpeech()]);
      if (ttsLoadSeq.current !== seq) return;

      const combined = [
        ...(nativeRes.status === "fulfilled" ? nativeRes.value : []),
        ...(webRes.status === "fulfilled" ? webRes.value : []),
      ];
      void log(
        `[TTS][Settings] voices 合并完成: reason=${reason} native=${nativeRes.status === "fulfilled" ? nativeRes.value.length : 0}, web=${webRes.status === "fulfilled" ? webRes.value.length : 0}, total=${combined.length}`,
        "info",
      );

      const dedup = new Map<string, TTSVoiceWithEngine>();
      for (const v of combined) {
        if (!v?.id) continue;
        const key = `${v.engine}::${v.id}`;
        if (!dedup.has(key)) dedup.set(key, v);
      }
      const list = Array.from(dedup.values());
      setTtsVoices(list);
      if (list.length === 0) {
        void log("[TTS][Settings] voices 列表为空", "warn");
      }
    } catch {
      if (ttsLoadSeq.current !== seq) return;
      setTtsVoices([]);
      void log("[TTS][Settings] voices 加载异常", "error");
    } finally {
      if (ttsLoadSeq.current === seq) setTtsVoicesLoading(false);
    }
  }, []);

  useEffect(() => {
    void reloadTtsVoices("initial");
  }, [reloadTtsVoices]);

  useEffect(() => {
    let disposed = false;
    let removeListener: any = null;

    const setup = async () => {
      const w = window as any;
      const injected =
        w?.__TAURI__?.core?.addPluginListener || w?.__TAURI__?.addPluginListener;
      let addPluginListener: any = injected;
      try {
        const coreMod = await import("@tauri-apps/api/core").catch(() => null as any);
        if (typeof (coreMod as any)?.addPluginListener === "function") {
          addPluginListener = (coreMod as any).addPluginListener;
        }
      } catch {
      }
      if (typeof addPluginListener !== "function") return;

      try {
        removeListener = await addPluginListener(
          "native-tts",
          "tts_events",
          (event: any) => {
            if (disposed) return;
            if ((event as any)?.code !== "engine_changed") return;
            const nextEngine = (event as any)?.engine;
            if (!nextEngine) return;
            const prevEngine = (event as any)?.prevEngine;
            const current = getReaderSettings();
            if (current.ttsNativeDefaultEngine === nextEngine) return;

            void log(
              `[TTS][Settings] 系统默认 TTS 引擎已变更(事件): ${prevEngine ?? ""} -> ${nextEngine}，清理 native-tts 语音选择`,
              "warn",
            );
            saveReaderSettings({
              ttsNativeDefaultEngine: nextEngine,
              ttsVoiceByEngine: {
                ...(current.ttsVoiceByEngine || {}),
                "native-tts": "default",
              },
            });
            setSettings((s) => ({
              ...s,
              ttsNativeDefaultEngine: nextEngine,
              ttsVoiceByEngine: {
                ...(s.ttsVoiceByEngine || {}),
                "native-tts": "default",
              },
            }));
            void reloadTtsVoices("engine_changed");
          },
        );
      } catch (e) {
        void log("[TTS][Settings] 注册 native-tts 事件监听失败", "warn", {
          error: String(e),
        });
      }
    };

    void setup();
    return () => {
      disposed = true;
      try {
        if (typeof removeListener === "function") removeListener();
        else removeListener?.remove?.();
      } catch {
      }
    };
  }, [reloadTtsVoices]);

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

  const toShortVoiceLabel = (name?: string) => {
    let s = String(name || "").trim();
    if (!s) return "";
    s = s.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
    const parts = s.split(" - ");
    if (parts.length >= 2) s = `${parts[0]} - ${parts[1]}`.trim();
    return s.trim();
  };

  const safeLanguageDisplayName = (locale: 'zh' | 'en', langTag: string): string => {
    try {
      const dn = new Intl.DisplayNames([locale], { type: 'language' });
      return dn.of(langTag) || '';
    } catch {
      return '';
    }
  };

  const computeVoiceLangTokenCandidates = (v: TTSVoiceWithEngine): string[] => {
    const langTag = (v.lang || '').trim();
    const base = langTag ? langTag.split('-')[0] : '';
    const tokens = new Set<string>();
    const push = (s: string | undefined) => {
      const v = String(s || '').trim();
      if (v) tokens.add(v);
    };
    push(v.display?.zh);
    push(v.display?.en);
    if (langTag) {
      push(safeLanguageDisplayName('zh', langTag));
      push(safeLanguageDisplayName('en', langTag));
    }
    if (base) {
      push(safeLanguageDisplayName('zh', base));
      push(safeLanguageDisplayName('en', base));
    }
    return Array.from(tokens);
  };

  const normalizeVoiceName = (v: TTSVoiceWithEngine): string => {
    const raw = String(v.name || '').trim();
    if (!raw) return '';
    const parts = raw.split(' - ').map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const tokens = computeVoiceLangTokenCandidates(v)
        .map((s) => s.toLowerCase())
        .filter(Boolean);
      let nextParts = [...parts];
      while (nextParts.length > 1) {
        const tail = nextParts[nextParts.length - 1].toLowerCase();
        if (!tokens.includes(tail)) break;
        nextParts = nextParts.slice(0, -1);
      }
      const joined =
        nextParts.length >= 2 ? `${nextParts[0]} - ${nextParts[1]}` : nextParts[0] || '';
      return toShortVoiceLabel(joined) || joined;
    }
    return toShortVoiceLabel(raw) || raw;
  };

  const getVoiceSourceLabel = (engine: string): string => {
    return engine === 'native-tts' ? 'Native' : 'Web';
  };

  const getVoiceDisambiguator = (v: TTSVoiceWithEngine): string => {
    const id = String(v.id || '').trim();
    if (!id) return '';
    const parts = id.split(/[-_]/).filter(Boolean);
    const tail = parts.slice(-2).join('-');
    const baseName = normalizeVoiceName(v);
    if (tail && tail !== baseName) return tail;
    if (id.length <= 16 && id !== baseName) return id;
    const short = id.slice(-10);
    if (short && short !== baseName) return short;
    return '';
  };

  const ttsVoiceOptions = (() => {
    const dedup = new Map<string, TTSVoiceWithEngine>();
    for (const v of ttsVoices) {
      if (!v?.id) continue;
      const key = `${v.engine}::${v.id}`;
      if (!dedup.has(key)) dedup.set(key, v);
    }

    const sorted = Array.from(dedup.values()).sort((a, b) => {
      const la = `${a.engine || ""} ${a.lang || ""} ${a.name || ""}`.toLowerCase();
      const lb = `${b.engine || ""} ${b.lang || ""} ${b.name || ""}`.toLowerCase();
      return la.localeCompare(lb);
    });

    if (sorted.length === 0) {
      return [{ value: "none", label: t("ttsVoiceLoadFailed") }];
    }

    const baseNameCount = new Map<string, number>();
    const baseNameLangCount = new Map<string, number>();
    const baseNameLangSourceCount = new Map<string, number>();
    for (const v of sorted) {
      const baseName = normalizeVoiceName(v) || v.name || v.id;
      const langShort = String(v.lang || "").trim();
      const source = getVoiceSourceLabel(v.engine);
      const k1 = baseName;
      const k2 = `${baseName}||${langShort}`;
      const k3 = `${baseName}||${langShort}||${source}`;
      baseNameCount.set(k1, (baseNameCount.get(k1) || 0) + 1);
      baseNameLangCount.set(k2, (baseNameLangCount.get(k2) || 0) + 1);
      baseNameLangSourceCount.set(k3, (baseNameLangSourceCount.get(k3) || 0) + 1);
    }

    const labelIndex = new Map<string, number>();

    return [
      { value: "default", label: t("ttsVoiceSystemDefault") },
      ...sorted.map((v) => ({
        value: `${v.engine}::${v.id}`,
        label: (() => {
          const baseName = normalizeVoiceName(v) || v.name || v.id;
          const langShort = String(v.lang || "").trim();
          const source = getVoiceSourceLabel(v.engine);

          const parts: string[] = [baseName];
          const baseNameDup = (baseNameCount.get(baseName) || 0) > 1;
          if (baseNameDup && langShort) parts.push(langShort);

          const k2 = `${baseName}||${langShort}`;
          const baseNameLangDup = (baseNameLangCount.get(k2) || 0) > 1;
          if (baseNameLangDup) parts.push(source);

          const k3 = `${baseName}||${langShort}||${source}`;
          const baseNameLangSourceDup = (baseNameLangSourceCount.get(k3) || 0) > 1;
          if (baseNameLangSourceDup) {
            const disambiguator = getVoiceDisambiguator(v);
            if (disambiguator) parts.push(disambiguator);
          }

          const labelBase = parts.join(" · ");
          const next = (labelIndex.get(labelBase) || 0) + 1;
          labelIndex.set(labelBase, next);
          return next > 1 ? `${labelBase} · ${next}` : labelBase;
        })(),
      })),
    ];
  })();

  const selectedTtsVoiceValue = (() => {
    if (ttsVoices.length === 0) return "none";
    const voiceByEngine = settings.ttsVoiceByEngine || {};
    const preferredEngine = settings.ttsPreferredEngine;
    if (preferredEngine) {
      const vid = voiceByEngine[preferredEngine];
      if (vid && vid !== "default") return `${preferredEngine}::${vid}`;
      return "default";
    }
    const order = ["native-tts", "web-speech"];
    for (const eng of order) {
      const vid = voiceByEngine[eng];
      if (vid && vid !== "default") return `${eng}::${vid}`;
    }
    return "default";
  })();

  return (
    <div
      style={{
        height: "100vh",
        backgroundColor: "#fafafa",
        display: "flex",
        flexDirection: "column",
        paddingBottom: getSafeAreaInsets().bottom,
        overflow: "hidden",
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
        className="no-scrollbar"
        style={{
          flex: 1,
          overflowY: "auto",
          WebkitOverflowScrolling: "touch",
        }}
      >
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
                onClick={async () => {
                  try {
                    setLoading(true);
                    setLoadingText(t('exporting') || "正在导出...");
                    // 给一个极短的延时确保 loading 渲染出来
                    await new Promise(resolve => setTimeout(resolve, 50));
                    const success = await exportAppData();
                    setLoading(false);
                    // 确保 loading 消失后再弹出成功提示
                    if (success) {
                      setTimeout(() => {
                        alert(t('backup.exportSuccess'));
                      }, 100);
                    }
                  } catch (e: any) {
                    setLoading(false);
                    const msg = typeof e?.message === 'string' ? e.message : String(e);
                    setTimeout(() => {
                      alert(t('backup.exportFailedWithReason', { reason: msg }));
                    }, 100);
                  }
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
                onClick={async () => {
                  try {
                    setLoading(true);
                    setLoadingText(t('importing') || "正在导入...");
                    // 给一个极短的延时确保 loading 渲染出来
                    await new Promise(resolve => setTimeout(resolve, 50));
                    const success = await importAppData();
                    setLoading(false);
                    if (success) {
                        setTimeout(async () => {
                            alert(t('backup.importSuccess'));
                            await exitApp();
                        }, 100);
                    }
                  } catch (e: any) {
                    setLoading(false);
                    const msg = typeof e?.message === 'string' ? e.message : String(e);
                    setTimeout(() => {
                      alert(t('backup.importFailedWithReason', { reason: msg }));
                    }, 100);
                  }
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

          <Row
            label={t("ttsVoice")}
            right={
              <CustomSelect
                value={selectedTtsVoiceValue}
                options={ttsVoiceOptions}
                onChange={(val) => {
                  const raw = String(val);
                  void log(`[TTS][Settings] 选择语音: ${raw}`, "info");
                  if (raw === "none") return;
                  if (raw === "default") {
                    setSettings((s) => ({
                      ...s,
                      ttsPreferredEngine: undefined,
                      ttsVoiceByEngine: {
                        ...(s.ttsVoiceByEngine || {}),
                        "native-tts": "default",
                        "web-speech": "default",
                      },
                    }));
                    return;
                  }
                  const idx = raw.indexOf("::");
                  if (idx <= 0) return;
                  const engine = raw.slice(0, idx);
                  const voiceId = raw.slice(idx + 2);
                  if (!engine || !voiceId) return;
                  void log(`[TTS][Settings] 设置语音: engine=${engine} voiceId=${voiceId}`, "info");
                  setSettings((s) => ({
                    ...s,
                    ttsPreferredEngine: engine,
                    ttsVoiceByEngine: {
                      ...(s.ttsVoiceByEngine || {}),
                      [engine]: voiceId,
                    },
                  }));
                }}
                style={{
                  opacity: ttsVoicesLoading ? 0.7 : 1,
                }}
                disabled={ttsVoices.length === 0}
                dropdownDirection="up"
                adaptiveMaxHeight
                dropdownMaxHeight={220}
                hideScrollbar
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
            <span style={{ color: "#333", fontSize: "15px" }}>{t('ttsRate')}</span>
            <span style={{ color: "#999", fontSize: "12px" }}>
              {settings.ttsRate ?? TTS_RATE_DEFAULT}x
            </span>
          </div>
          {(() => {
            const min = TTS_RATE_MIN,
              max = TTS_RATE_MAX;
            const val = settings.ttsRate ?? TTS_RATE_DEFAULT;
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
                step={TTS_RATE_STEP}
                value={val}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    ttsRate: Number(e.target.value),
                  }))
                }
                style={{ width: "100%", background: track }}
              />
            );
          })()}
          </div>
        </div>
      </div>
      {toastMessage && (
        <Toast
          message={toastMessage}
          onClose={() => setToastMessage("")}
        />
      )}
      
      <Loading visible={loading} text={loadingText} overlay />
    </div>
  );
};

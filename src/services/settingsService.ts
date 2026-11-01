/**
 * 阅读器设置服务模块
 * 提供阅读器相关设置的持久化服务
 */

import { DEFAULT_SETTINGS } from '../constants/config';
import { logError } from './commonService';
import type { ReaderTheme } from './formats/types';

// 语言设置类型
export type LanguageSetting = 'zh' | 'en' | 'system';

// 阅读器设置类型
export type ReaderSettings = {
  clickTurnPage: boolean;
  showStatusBar: boolean;
  recentDisplayCount: number;
  defaultFontSize?: number;
  defaultReadingMode?: 'horizontal' | 'vertical';
  /** TXT 章节识别正则（空白视为未配置，回退内置模式） */
  txtChapterRegex?: string;
  scrollSpeed: number;
  pageGap: number;
  fontSize?: number;
  hideDivider?: boolean;
  readingMode?: 'horizontal' | 'vertical';
  renderQuality?: string;
  language?: LanguageSetting;
  theme?: ReaderTheme;
  cacheExpiryDays?: number;
  ttsRate?: number;
  ttsVoiceByEngine?: Record<string, string>;
  ttsPreferredEngine?: string;
  ttsNativeDefaultEngine?: string;
  /** 按“引擎|语音|语言”持久化的实测语速（rate=1 字符/秒） */
  ttsVoiceSpeedProfiles?: Record<string, { cpsAtRate1: number; updatedAt: number }>;
};

const SETTINGS_KEY = 'reader_settings_v1';

// 获取阅读器设置
export const getReaderSettings = (): ReaderSettings => {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    const defaults: ReaderSettings = { ...DEFAULT_SETTINGS };
    return { ...defaults, ...(parsed || {}) } as ReaderSettings;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
};

// 保存阅读器设置
export const saveReaderSettings = (settings: Partial<ReaderSettings>) => {
  try {
    const current = getReaderSettings();
    const next = { ...current, ...settings } as ReaderSettings;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    return next;
  } catch (e) {
    logError('Save settings failed', { error: String(e) }).catch(() => {});
    return getReaderSettings();
  }
};

/**
 * 获取当前章节识别正则
 *
 * 功能描述：读取 TXT 章节识别正则设置，去除首尾空白后非空才生效。
 *
 * 参数说明：无。
 *
 * 返回值类型及用途：返回正则字符串（传给后端 Tauri 命令）或 undefined（使用内置模式）。
 */
export const getTxtChapterRegex = (): string | undefined => {
  const value = getReaderSettings().txtChapterRegex?.trim();
  return value ? value : undefined;
};

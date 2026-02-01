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
  volumeKeyTurnPage: boolean;
  clickTurnPage: boolean;
  showStatusBar: boolean;
  recentDisplayCount: number;
  scrollSpeed: number;
  pageGap: number;
  readingMode?: 'horizontal' | 'vertical';
  renderQuality?: string;
  language?: LanguageSetting;
  theme?: ReaderTheme;
  cacheExpiryDays?: number;
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

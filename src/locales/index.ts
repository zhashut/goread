import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { logError } from '../services';

// 中文语言包
import zhCommon from './zh/common.json';
import zhSettings from './zh/settings.json';
import zhBookshelf from './zh/bookshelf.json';
import zhAbout from './zh/about.json';
import zhStatistics from './zh/statistics.json';
import zhReader from './zh/reader.json';
import zhGroup from './zh/group.json';
import zhSearch from './zh/search.json';
import zhImport from './zh/import.json';

// 英文语言包
import enCommon from './en/common.json';
import enSettings from './en/settings.json';
import enBookshelf from './en/bookshelf.json';
import enAbout from './en/about.json';
import enStatistics from './en/statistics.json';
import enReader from './en/reader.json';
import enGroup from './en/group.json';
import enSearch from './en/search.json';
import enImport from './en/import.json';

// 语言资源配置
const resources = {
  zh: {
    common: zhCommon,
    settings: zhSettings,
    bookshelf: zhBookshelf,
    about: zhAbout,
    statistics: zhStatistics,
    reader: zhReader,
    group: zhGroup,
    search: zhSearch,
    import: zhImport,
  },
  en: {
    common: enCommon,
    settings: enSettings,
    bookshelf: enBookshelf,
    about: enAbout,
    statistics: enStatistics,
    reader: enReader,
    group: enGroup,
    search: enSearch,
    import: enImport,
  },
};

// 支持的语言列表
export const supportedLanguages = [
  { code: 'zh', label: '简体中文' },
  { code: 'en', label: 'English' },
] as const;

export type LanguageCode = typeof supportedLanguages[number]['code'];

/**
 * 检测系统语言并返回匹配的语言代码
 * 如果系统语言不在支持列表中，返回默认语言 'zh'
 */
export const getSystemLanguage = (): LanguageCode => {
  try {
    // navigator.language 返回如 'zh-CN', 'en-US', 'en' 等
    const browserLang = navigator.language || (navigator as any).userLanguage || '';
    const langCode = browserLang.toLowerCase().split('-')[0]; // 'zh-CN' -> 'zh'
    
    // 检查是否在支持的语言列表中
    const supported = supportedLanguages.find(lang => lang.code === langCode);
    if (supported) {
      return supported.code;
    }
  } catch (e) {
    logError('Failed to detect system language', { error: String(e) }).catch(() => {});
  }
  
  return 'zh'; // 默认中文
};

// 初始化 i18n
i18n.use(initReactI18next).init({
  resources,
  lng: 'zh', // 初始默认语言（会在 main.tsx 中根据设置或系统语言覆盖）
  fallbackLng: 'zh', // 回退语言
  defaultNS: 'common', // 默认命名空间
  ns: ['common', 'settings', 'bookshelf', 'about', 'statistics', 'reader', 'group', 'search', 'import'], // 所有命名空间
  interpolation: {
    escapeValue: false, // React 已自动转义，无需重复
  },
  react: {
    useSuspense: false, // 禁用 Suspense，避免 SSR 问题
  },
});

// 切换语言
export const changeLanguage = (lng: LanguageCode) => {
  return i18n.changeLanguage(lng);
};

// 获取当前语言
export const getCurrentLanguage = (): LanguageCode => {
  return i18n.language as LanguageCode;
};

export default i18n;

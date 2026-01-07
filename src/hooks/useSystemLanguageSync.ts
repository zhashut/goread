/**
 * 系统语言同步 Hook
 * 当应用从后台返回前台时，重新检测系统语言并同步到 i18n
 * 仅在语言设置为 'system' 时生效
 */

import { useEffect, useRef } from 'react';
import { getReaderSettings } from '../services';
import { getSystemAppLanguage, AppLanguage } from '../services/systemLanguageService';
import i18n from '../locales';

/**
 * 检测系统语言并同步到 i18n
 * 仅在设置为"跟随系统"时生效
 */
async function syncSystemLanguage(): Promise<void> {
  const settings = getReaderSettings();
  
  // 只有当设置为"跟随系统"时才同步
  if (settings.language !== 'system' && settings.language !== undefined) {
    return;
  }
  
  const currentLang = i18n.language as AppLanguage;
  const systemLang = await getSystemAppLanguage();
  
  // 仅当语言实际发生变化时才切换
  if (systemLang !== currentLang) {
    await i18n.changeLanguage(systemLang);
  }
}

/**
 * 系统语言同步 Hook
 * 监听应用可见性变化，当应用从后台返回前台时重新检测系统语言
 */
export function useSystemLanguageSync(): void {
  const isInitialMount = useRef(true);

  useEffect(() => {
    // 跳过首次挂载，因为 main.tsx 已经初始化语言
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }

    // 处理页面可见性变化
    const handleVisibilityChange = async () => {
      if (document.visibilityState === 'visible') {
        await syncSystemLanguage();
      }
    };

    // 处理页面获得焦点（桌面端备用）
    const handleFocus = async () => {
      await syncSystemLanguage();
    };

    // 添加事件监听
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleFocus);

    // 清理
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleFocus);
    };
  }, []);
}

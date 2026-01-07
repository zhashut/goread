/**
 * 系统语言服务
 * 提供统一的"系统语言"抽象接口，屏蔽插件/UA/Bridge 的细节
 * 可按平台（Android / iOS / Desktop / Web）拆分实现
 */

// ==================== 类型定义 ====================

export type AppLanguage = 'zh' | 'en';

export interface SystemLanguageProvider {
  /**
   * 返回系统原始语言标签（BCP‑47），如 "zh-CN" / "zh-TW" / "en-US"
   * 获取失败时返回 null
   */
  getRawLocale(): Promise<string | null>;

  /**
   * 将系统语言映射到应用语言（zh/en）
   * 内部应包含容错与默认策略
   */
  resolveAppLanguage(): Promise<AppLanguage>;
}

// ==================== 平台检测 ====================

type Platform = 'android' | 'ios' | 'desktop' | 'web' | 'unknown';

function detectPlatform(): Platform {
  const ua = navigator.userAgent.toLowerCase();

  if (/iphone|ipad|ipod/.test(ua)) return 'ios';
  if (/android/.test(ua)) return 'android';

  if (typeof (window as any).__TAURI__ !== 'undefined') {
    // Tauri 桌面端
    return 'desktop';
  }

  // 纯浏览器环境（开发调试）
  return 'web';
}

// ==================== 映射规则 ====================

/**
 * 将原始 locale 映射为应用语言
 * 规则：只要主语言是 zh（含简体/繁体），一律映射为 zh，其他映射为 en
 */
function mapLocaleToAppLanguage(rawLocale: string | null): AppLanguage {
  if (!rawLocale) return 'en';
  const lower = rawLocale.toLowerCase();
  // 中文（包含繁体 zh-Hant, zh-TW, zh-HK 等）均映射为 zh
  if (lower.startsWith('zh')) {
    return 'zh';
  }
  return 'en';
}

// ==================== 平台 Provider 实现 ====================

/**
 * Android 平台 Provider
 * 使用 @tauri-apps/plugin-os 的 locale() 获取系统语言
 */
class AndroidSystemLanguageProvider implements SystemLanguageProvider {
  async getRawLocale(): Promise<string | null> {
    try {
      const { locale } = await import('@tauri-apps/plugin-os');
      return await locale();
    } catch {
      // 兜底：回退到 navigator.language
      return navigator.language || null;
    }
  }

  async resolveAppLanguage(): Promise<AppLanguage> {
    const raw = await this.getRawLocale();
    return mapLocaleToAppLanguage(raw);
  }
}

/**
 * iOS 平台 Provider
 * 使用 @tauri-apps/plugin-os 的 locale() 获取系统语言
 */
class IOSSystemLanguageProvider implements SystemLanguageProvider {
  async getRawLocale(): Promise<string | null> {
    try {
      const { locale } = await import('@tauri-apps/plugin-os');
      return await locale();
    } catch {
      return navigator.language || null;
    }
  }

  async resolveAppLanguage(): Promise<AppLanguage> {
    const raw = await this.getRawLocale();
    return mapLocaleToAppLanguage(raw);
  }
}

/**
 * Desktop 平台 Provider
 * 使用 navigator.language 获取系统语言
 */
class DesktopSystemLanguageProvider implements SystemLanguageProvider {
  async getRawLocale(): Promise<string | null> {
    try {
      return navigator.language || null;
    } catch {
      return null;
    }
  }

  async resolveAppLanguage(): Promise<AppLanguage> {
    const raw = await this.getRawLocale();
    return mapLocaleToAppLanguage(raw);
  }
}

/**
 * Web Fallback Provider
 * 使用 navigator.language 获取系统语言
 */
class WebFallbackSystemLanguageProvider implements SystemLanguageProvider {
  async getRawLocale(): Promise<string | null> {
    return navigator.language || null;
  }

  async resolveAppLanguage(): Promise<AppLanguage> {
    const raw = await this.getRawLocale();
    return mapLocaleToAppLanguage(raw);
  }
}

// ==================== Provider 工厂 ====================

function createSystemLanguageProvider(): SystemLanguageProvider {
  const platform = detectPlatform();

  switch (platform) {
    case 'android':
      return new AndroidSystemLanguageProvider();
    case 'ios':
      return new IOSSystemLanguageProvider();
    case 'desktop':
      return new DesktopSystemLanguageProvider();
    case 'web':
    default:
      return new WebFallbackSystemLanguageProvider();
  }
}

// 单例 Provider
const systemLanguageProvider = createSystemLanguageProvider();

// ==================== 导出 API ====================

/**
 * 获取系统语言并映射为应用语言（zh/en）
 */
export async function getSystemAppLanguage(): Promise<AppLanguage> {
  return systemLanguageProvider.resolveAppLanguage();
}

/**
 * 获取系统原始语言标签（BCP-47）
 */
export async function getSystemRawLocale(): Promise<string | null> {
  return systemLanguageProvider.getRawLocale();
}

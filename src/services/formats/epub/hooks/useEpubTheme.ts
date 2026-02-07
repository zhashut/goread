/**
 * EPUB 主题样式 Hook
 * 处理阅读器主题样式的应用和生成
 */

import { RenderOptions } from '../../types';

/** 主题颜色配置 */
export interface ThemeColors {
  bgColor: string;
  textColor: string;
}

/** 主题样式 Hook 返回接口 */
export interface EpubThemeHook {
  /** 获取主题样式字符串（用于 Shadow DOM） */
  getThemeStyles: (options?: RenderOptions) => string;
  /** 计算主题颜色 */
  getThemeColors: (theme: string) => ThemeColors;
}

/**
 * EPUB 主题样式 Hook
 * 提供主题样式应用、样式字符串生成等功能
 */
export function useEpubTheme(): EpubThemeHook {
  /**
   * 计算主题颜色
   */
  const getThemeColors = (theme: string): ThemeColors => {
    let bgColor = '#ffffff';
    let textColor = '#24292e';

    if (theme === 'dark') {
      bgColor = '#1a1a1a';
      textColor = '#e0e0e0';
    } else if (theme === 'sepia') {
      bgColor = '#f4ecd8';
      textColor = '#5b4636';
    }

    return { bgColor, textColor };
  };

  /**
   * 获取主题样式字符串（用于 Shadow DOM）
   */
  const getThemeStyles = (options?: RenderOptions): string => {
    const theme = options?.theme || 'light';
    const fontSize = options?.fontSize || 16;
    const lineHeight = options?.lineHeight || 1.6;
    const fontFamily = options?.fontFamily || 'serif';

    const { bgColor, textColor } = getThemeColors(theme);

    return `
      :host {
        display: block;
        background-color: ${bgColor};
        color: ${textColor};
      }
      
      .epub-section-content {
        background-color: ${bgColor};
        color: ${textColor};
        font-size: ${fontSize}px;
        line-height: ${lineHeight};
        font-family: ${fontFamily};
        padding: 16px;
        max-width: 800px;
        margin: 0 auto;
      }
      
      .epub-section-content * {
        color: inherit;
      }
      
      .epub-section-content h1,
      .epub-section-content h2,
      .epub-section-content h3,
      .epub-section-content h4,
      .epub-section-content h5,
      .epub-section-content h6 {
        white-space: normal;
        word-break: break-word;
        overflow-wrap: anywhere;
        margin-top: 1.5em;
        margin-bottom: 0.5em;
      }
      
      .epub-section-content p {
        margin: 0.8em 0;
        text-indent: 2em;
      }
      
      .epub-section-content a {
        color: #58a6ff;
        text-decoration: none;
      }
      
      .epub-section-content a:hover {
        text-decoration: underline;
      }
      
      .epub-section-content img {
        max-width: 100%;
        height: auto;
      }
      
      .epub-section-content a {
        cursor: pointer;
      }
      
      .epub-section-content pre {
        background-color: rgba(128, 128, 128, 0.1);
        padding: 1em;
        overflow-x: auto;
        border-radius: 4px;
      }
      
      .epub-section-content code {
        font-family: 'Courier New', monospace;
        background-color: rgba(128, 128, 128, 0.1);
        padding: 0.2em 0.4em;
        border-radius: 3px;
      }
      
      .epub-section-content blockquote {
        border-left: 4px solid #666;
        padding-left: 1em;
        margin-left: 0;
        font-style: italic;
        opacity: 0.8;
      }
    `;
  };

  return {
    getThemeStyles,
    getThemeColors,
  };
}

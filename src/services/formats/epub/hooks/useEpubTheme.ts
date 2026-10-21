/**
 * EPUB 主题样式 Hook
 * 处理阅读器主题样式的应用和生成
 */

import { RenderOptions } from '../../types';
import { getReaderPageBackground } from '../../../../constants/readerTheme';
import { EPUB_FIXED_CONTENT_CLASS } from '../layout/fixedLayoutStage';

/** 主题颜色配置 */
export interface ThemeColors {
  bgColor: string;
  textColor: string;
}

/** 主题样式上下文 */
export interface EpubThemeStyleContext {
  /** 固定版式：只输出最小样式集，避免覆盖书籍的绝对尺寸与图片尺寸 */
  fixedLayout?: boolean;
}

/** 主题样式 Hook 返回接口 */
export interface EpubThemeHook {
  /** 获取主题样式字符串（用于 Shadow DOM） */
  getThemeStyles: (options?: RenderOptions, context?: EpubThemeStyleContext) => string;
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
    // 页面底色统一取自主题常量；文字色仍由各格式自行维护
    const bgColor = getReaderPageBackground(theme);
    let textColor = '#24292e';

    if (theme === 'dark') {
      textColor = '#e0e0e0';
    } else if (theme === 'sepia') {
      textColor = '#5b4636';
    }

    return { bgColor, textColor };
  };

  /**
   * 获取主题样式字符串（用于 Shadow DOM）
   * 固定版式使用独立的最小样式集，保持书籍自身的绝对尺寸与图片尺寸。
   */
  const getThemeStyles = (options?: RenderOptions, context?: EpubThemeStyleContext): string => {
    const theme = options?.theme || 'light';
    const readingMode = options?.readingMode || 'vertical';
    const fontSize = options?.fontSize || 16;
    const lineHeight = options?.lineHeight || 1.6;
    const fontFamily = options?.fontFamily || 'serif';

    const { bgColor, textColor } = getThemeColors(theme);

    // 固定版式：页面尺寸、字体与布局全部由书籍决定，阅读器只提供底色与信纸外留白
    if (context?.fixedLayout) {
      return getFixedLayoutStyles(bgColor, textColor);
    }

    const layoutCss = readingMode === 'horizontal'
      ? `
        .epub-section-content {
          box-sizing: border-box;
          width: 100%;
          height: 100%;
          padding: 16px;
          max-width: none;
          margin: 0;
          column-width: var(--epub-page-width, 360px);
          column-gap: var(--epub-page-gap, 16px);
          column-fill: auto;
        }
      `
      : `
        .epub-section-content {
          padding: 16px;
          max-width: 800px;
          margin: 0 auto;
        }
      `;

    return `
      :host {
        display: block;
        background-color: ${bgColor};
        color: ${textColor};
        font-size: ${fontSize}px;
      }
      
      .epub-section-content {
        background-color: ${bgColor};
        color: ${textColor};
        font-size: ${fontSize}px;
        line-height: ${lineHeight};
        font-family: ${fontFamily};
      }

      ${layoutCss}
      
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
      
      .epub-section-content a[href] {
        color: #58a6ff;
        text-decoration: none;
        cursor: pointer;
      }
      
      .epub-section-content a[href]:hover {
        text-decoration: underline;
      }

      .epub-section-content a:not([href]) {
        color: inherit;
        text-decoration: inherit;
        cursor: inherit;
      }
      
      .epub-section-content img {
        max-width: 100%;
        height: auto;
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

/**
 * 固定版式主题样式：只保留底色、字色与内容容器重置，
 * 不注入 padding / max-width / 分栏 / 图片自适应等流式规则，
 * 避免覆盖书籍以绝对像素写死的排版。
 * 根字号固定为 16px，不跟随阅读器字号设置；书籍自身的根字号规则会在其后覆盖。
 */
function getFixedLayoutStyles(bgColor: string, textColor: string): string {
  return `
      :host {
        display: block;
        background-color: ${bgColor};
        color: ${textColor};
        font-size: 16px;
      }

      .${EPUB_FIXED_CONTENT_CLASS} {
        padding: 0;
        margin: 0;
        max-width: none;
        width: 100%;
        height: 100%;
        box-sizing: border-box;
        column-width: auto;
        column-count: auto;
        column-fill: auto;
      }
    `;
}

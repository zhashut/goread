/**
 * EPUB 主题样式 Hook
 * 处理阅读器主题样式的应用和生成
 */

import { RenderOptions } from '../../types';

/** foliate-js 的 View 元素类型 */
export interface FoliateView extends HTMLElement {
  open(book: any): Promise<void>;
  close(): void;
  goTo(target: any): Promise<any>;
  goToFraction(frac: number): Promise<void>;
  prev(distance?: number): Promise<void>;
  next(distance?: number): Promise<void>;
  init(options: { lastLocation?: any; showTextStart?: boolean }): Promise<void>;
  book: any;
  renderer: any;
  lastLocation: any;
  history: any;
  setAttribute(name: string, value: string): void;
}

/** 主题颜色配置 */
export interface ThemeColors {
  bgColor: string;
  textColor: string;
}

/** 主题样式 Hook 返回接口 */
export interface EpubThemeHook {
  /** 应用主题样式到 foliate-view */
  applyTheme: (view: FoliateView, options?: RenderOptions) => void;
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
  // 保存当前的样式配置，确保 load 事件始终使用最新配置
  let currentOptions: RenderOptions = {
    theme: 'light',
    fontSize: 16,
    lineHeight: 1.6,
    fontFamily: 'serif',
  };

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
   * 生成 CSS 样式字符串
   */
  const generateStyleContent = (options: RenderOptions): string => {
    const theme = options.theme || 'light';
    const fontSize = options.fontSize || 16;
    const lineHeight = options.lineHeight || 1.6;
    const fontFamily = options.fontFamily || 'serif';

    const { bgColor, textColor } = getThemeColors(theme);

    return `
      html, body {
        background-color: ${bgColor} !important;
        color: ${textColor} !important;
        font-size: ${fontSize}px !important;
        line-height: ${lineHeight} !important;
        font-family: ${fontFamily} !important;
        /* 确保内容可以撑开 */
        height: auto !important;
        min-height: 100% !important;
        overflow: visible !important;
        /* 隐藏滚动条 */
        scrollbar-width: none; /* Firefox */
        -ms-overflow-style: none; /* IE/Edge */
      }
      /* 章节开篇标题换行，避免长标题溢出 */
      h1, h2, h3, h4, h5, h6 {
        white-space: normal !important;
        word-break: break-word !important;
        overflow-wrap: anywhere !important;
      }
      /* 隐藏滚动条 Chrome/Safari/Webkit */
      ::-webkit-scrollbar {
        display: none;
        width: 0;
        height: 0;
      }
      * {
        color: inherit !important;
      }
      a {
        color: #58a6ff !important;
      }
      img {
        max-width: 100% !important;
        height: auto !important;
      }
    `;
  };

  /**
   * 注入样式到文档
   */
  const injectStyleToDoc = (doc: Document, options: RenderOptions) => {
    if (!doc || !doc.head) return;

    // 移除旧样式（如果有）
    const oldStyle = doc.getElementById('epub-theme-style');
    if (oldStyle) {
      oldStyle.remove();
    }

    // 创建新样式
    const style = doc.createElement('style');
    style.id = 'epub-theme-style';
    style.textContent = generateStyleContent(options);
    doc.head.appendChild(style);

    // 章节开篇页特殊兼容：移除视口锁定布局
    try {
      const win = doc.defaultView;
      if (!win) return;
      
      const rootRect = doc.documentElement.getBoundingClientRect();
      const viewportH = Math.max(0, rootRect.height);
      // 注意：body 可能未完全加载，此处的计算仅作为尽力而为的尝试
      const contentH = Math.max(doc.body?.scrollHeight || 0, doc.documentElement.scrollHeight);
      const children = Array.from(doc.body?.children || []) as HTMLElement[];
      const hasHeading = !!doc.body?.querySelector('h1, h2, h3');
      const likelyOpening = hasHeading && children.length <= 3 && contentH <= viewportH + 4;
      
      if (likelyOpening) {
        for (const el of children) {
          const cs = win.getComputedStyle(el);
          const hasViewportLock = /vh/.test(`${cs.height}${cs.minHeight}${cs.maxHeight}`)
            || cs.position === 'absolute' || cs.position === 'fixed'
            || cs.overflow === 'hidden'
            || cs.display === 'grid' || cs.display === 'flex';
          if (hasViewportLock) {
            // 仅解除溢出限制，保留原有布局（如 flex/grid 居中）
            el.style.setProperty('overflow', 'visible', 'important');
            el.style.setProperty('max-height', 'none', 'important');
          }
        }
      }
    } catch {}
  };

  /**
   * 应用主题样式到 foliate-view
   */
  const applyTheme = (view: FoliateView, options?: RenderOptions): void => {
    // 更新当前配置
    if (options) {
      currentOptions = { ...currentOptions, ...options };
    }

    const { bgColor } = getThemeColors(currentOptions.theme || 'light');

    // 1. 设置外层容器背景色
    view.style.backgroundColor = bgColor;

    // 2. 注入样式到所有已加载的文档（针对当前可见页面）
    // @ts-ignore
    const renderer = view.renderer;
    if (renderer && renderer.getContents) {
      const contents = renderer.getContents();
      for (const content of contents) {
        if (content.doc) {
          injectStyleToDoc(content.doc, currentOptions);
        }
      }
    }

    // 3. 确保监听器只添加一次
    // 使用 WeakMap 或在 view 上标记已添加监听器
    // @ts-ignore
    if (!view._epubThemeListenerAdded) {
      view.addEventListener('load', (e: any) => {
        const { doc } = e.detail;
        if (!doc) return;

        // 转发点击事件
        doc.addEventListener('click', (ev: MouseEvent) => {
          const rect = view.getBoundingClientRect();
          const newEvent = new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            view: window,
            detail: ev.detail,
            screenX: ev.screenX,
            screenY: ev.screenY,
            clientX: ev.clientX + rect.left,
            clientY: ev.clientY + rect.top,
            ctrlKey: ev.ctrlKey,
            altKey: ev.altKey,
            shiftKey: ev.shiftKey,
            metaKey: ev.metaKey,
            button: ev.button,
            buttons: ev.buttons,
          });
          view.dispatchEvent(newEvent);
        });

        // 注入当前最新的样式配置
        injectStyleToDoc(doc, currentOptions);
      });
      // @ts-ignore
      view._epubThemeListenerAdded = true;
    }
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
    applyTheme,
    getThemeStyles,
    getThemeColors,
  };
}

/**
 * EPUB 资源加载 Hook
 * 处理 EPUB 内部资源（图片、CSS、字体）的路径解析和加载
 */

import { logError } from '../../../index';
import { EpubBook } from './useEpubLoader';

/** 资源加载上下文 */
export interface EpubResourceContext {
  book: EpubBook | null;
  blobUrls: Set<string>;
}

/** 资源加载 Hook 返回接口 */
export interface EpubResourceHook {
  /** 解析并加载资源，返回 Blob URL */
  resolveAndLoadResource: (url: string, section: any) => Promise<string | null>;
  /** 加载并处理样式（包括外部 CSS 和内联样式） */
  loadAndProcessStyles: (doc: Document, section: any) => Promise<string>;
  /** 处理 CSS 中的 URL 路径 */
  processCssUrls: (css: string, basePath: string) => Promise<string>;
  /** 修复资源路径（图片、字体等） */
  fixResourcePaths: (content: HTMLElement, section: any) => Promise<void>;
  /** 清理生成的 Blob URL */
  clearBlobUrls: () => void;
}

/**
 * EPUB 资源加载 Hook
 * 提供资源路径解析、CSS/图片加载等功能
 */
export function useEpubResource(context: EpubResourceContext): EpubResourceHook {
  const { book, blobUrls } = context;

  /**
   * 解析并加载资源
   */
  const resolveAndLoadResource = async (url: string, section: any): Promise<string | null> => {
    if (!url || !book) return null;

    // 跳过绝对路径和 data URL
    if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:') || url.startsWith('blob:')) {
      return url;
    }

    try {
      // 解析路径
      let path = url;
      if (section && typeof section.resolveHref === 'function') {
        // section.resolveHref 返回的是 EPUB 内部的绝对路径字符串
        path = section.resolveHref(url);
      } else if (section && typeof section.resolve === 'function') {
        // 兼容旧版或不同的接口
        const resolved = section.resolve(url);
        if (typeof resolved === 'string') {
          path = resolved;
        }
      }

      if (!path) return null;

      // 加载资源为 Blob
      if (book.loadBlob) {
        const blob = await book.loadBlob(path);
        if (blob) {
          const blobUrl = URL.createObjectURL(blob);
          blobUrls.add(blobUrl);
          return blobUrl;
        }
      }
    } catch (e) {
      logError(`[EpubRenderer] 加载资源失败: ${url}`, e).catch(() => {});
    }

    return null;
  };

  /**
   * 处理 CSS 中的 URL 路径
   */
  const processCssUrls = async (css: string, basePath: string): Promise<string> => {
    const urlRegex = /url\(['"]?([^'"()]+)['"]?\)/g;
    let match;
    let newCss = css;
    const replacements: { old: string; new: string }[] = [];

    // 计算基准目录
    const baseDir = basePath.includes('/') ? basePath.substring(0, basePath.lastIndexOf('/') + 1) : '';

    while ((match = urlRegex.exec(css)) !== null) {
      const url = match[1];
      if (url.startsWith('data:') || url.startsWith('http')) continue;

      try {
        // 解析绝对路径
        const dummyBase = 'http://dummy/';
        const absoluteUrlObj = new URL(url, dummyBase + baseDir);
        const absolutePath = absoluteUrlObj.pathname.substring(1); // 去掉开头的 /

        // 加载资源
        const blobUrl = await resolveAndLoadResource(absolutePath, null);
        if (blobUrl) {
          replacements.push({ old: url, new: blobUrl });
        }
      } catch (e) {
        logError('[EpubRenderer] 解析 CSS URL 失败', { url, error: String(e) }).catch(() => {});
      }
    }

    // 替换 URL
    if (replacements.length > 0) {
      replacements.forEach(({ old, new: newUrl }) => {
        newCss = newCss.split(old).join(newUrl);
      });
    }

    return newCss;
  };

  /**
   * 加载并处理样式（包括外部 CSS 和内联样式）
   */
  const loadAndProcessStyles = async (doc: Document, section: any): Promise<string> => {
    let cssText = '';
    const sectionHref = section?.id || '';

    // 处理外部 CSS 文件 <link rel="stylesheet">
    const links = Array.from(doc.querySelectorAll('link[rel="stylesheet"]'));
    for (const link of links) {
      const href = link.getAttribute('href');
      if (!href) continue;

      try {
        // 解析 CSS 文件的绝对路径
        let cssPath = href;
        if (section && typeof section.resolveHref === 'function') {
          cssPath = section.resolveHref(href);
        }

        if (book && book.loadText && cssPath) {
          const cssContent = await book.loadText(cssPath);
          if (cssContent) {
            // 处理 CSS 文件中的相对路径（相对于 CSS 文件本身）
            const processedCss = await processCssUrls(cssContent, cssPath);
            cssText += `/* ${href} */\n${processedCss}\n`;
          }
        }
      } catch (e) {
        logError(`[EpubRenderer] 加载外部 CSS 失败: ${href}`, e).catch(() => {});
      }
    }

    // 处理内联样式 <style>
    const styles = Array.from(doc.querySelectorAll('style'));
    for (const style of styles) {
      const content = style.textContent || '';
      if (content) {
        // 内联样式的相对路径是相对于当前章节文件的
        const processedCss = await processCssUrls(content, sectionHref);
        cssText += `/* Inline Style */\n${processedCss}\n`;
      }
    }

    return cssText;
  };

  /**
   * 修复资源路径（图片、字体等）
   */
  const fixResourcePaths = async (content: HTMLElement, section: any): Promise<void> => {
    // 处理图片路径
    const images = content.querySelectorAll('img[src]');
    const imgPromises = Array.from(images).map(async (img) => {
      const src = img.getAttribute('src');
      if (!src) return;

      const resolvedUrl = await resolveAndLoadResource(src, section);
      if (resolvedUrl && resolvedUrl !== src) {
        img.setAttribute('src', resolvedUrl);
      }
    });

    // 处理 CSS 背景图片
    const elementsWithStyle = content.querySelectorAll('[style*="background"]');
    const stylePromises = Array.from(elementsWithStyle).map(async (el) => {
      const style = el.getAttribute('style');
      if (!style) return;

      // 匹配 url(...) 中的路径
      const urlRegex = /url\(['"]?([^'"()]+)['"]?\)/g;
      let match;
      let newStyle = style;
      const replacements: { old: string; new: string }[] = [];

      while ((match = urlRegex.exec(style)) !== null) {
        const url = match[1];
        // 避免重复处理
        if (url.startsWith('blob:') || url.startsWith('data:') || url.startsWith('http')) continue;

        const resolvedUrl = await resolveAndLoadResource(url, section);
        if (resolvedUrl && resolvedUrl !== url) {
          replacements.push({ old: url, new: resolvedUrl });
        }
      }

      if (replacements.length > 0) {
        replacements.forEach(({ old, new: newUrl }) => {
          newStyle = newStyle.split(old).join(newUrl);
        });
        el.setAttribute('style', newStyle);
      }
    });

    // 处理 SVG <image> 标签
    const svgImages = content.querySelectorAll('image');
    const svgPromises = Array.from(svgImages).map(async (img) => {
      // 尝试获取 href 或 xlink:href
      const href = img.getAttribute('href') || img.getAttribute('xlink:href');
      if (!href) return;

      const resolvedUrl = await resolveAndLoadResource(href, section);
      if (resolvedUrl && resolvedUrl !== href) {
        // 同时设置 href 和 xlink:href 以确保兼容性
        img.setAttribute('href', resolvedUrl);
        if (img.hasAttribute('xlink:href')) {
          img.setAttribute('xlink:href', resolvedUrl);
        }
      }
    });

    await Promise.all([...imgPromises, ...stylePromises, ...svgPromises]);
  };

  /**
   * 清理生成的 Blob URL
   */
  const clearBlobUrls = (): void => {
    blobUrls.forEach((url) => URL.revokeObjectURL(url));
    blobUrls.clear();
  };

  return {
    resolveAndLoadResource,
    loadAndProcessStyles,
    processCssUrls,
    fixResourcePaths,
    clearBlobUrls,
  };
}

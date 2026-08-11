/**
 * EPUB HTML 处理工具函数
 */

/**
 * 从完整 XHTML 文档中提取 <body> 标签内的内容
 * EPUB 章节的 HTML 是完整的 XHTML 文档（包含 <html>、<head>、<body>），
 * 直接注入 Shadow DOM 的 <div> 中会导致浏览器剥离这些结构标签，内容可能丢失或不可见。
 * 此函数提取 <body> 内部的 HTML 片段，确保能被正确渲染。
 */
export function extractBodyContent(html: string): string {
  // 匹配 <body ...>...</body>，提取内部内容
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (bodyMatch && bodyMatch[1]) {
    return bodyMatch[1].trim();
  }

  // 如果没有 <body> 标签，可能已经是 HTML 片段，直接返回
  return html;
}

/**
 * 归一化书籍自身 CSS，使其在 Shadow DOM 中被正确注入且 `rem` 能随阅读器字号缩放。
 *
 * 背景：Shadow DOM 内的 `rem` 单位仍以「文档根元素 `<html>`」的 font-size 为准，
 * 而不是 Shadow DOM 宿主（`:host`）。因此书籍样式里的 `rem` 无法跟随阅读器字号调节。
 * 此处通过三步改写解决：
 *
 * 1. `html` / `:root` 选择器 → `:host`：让书籍认为的“根元素”落到 Shadow DOM 宿主上；
 * 2. 从根级规则中剥离 `font-size`：避免书籍自身的 `html{font-size:...}` 覆盖阅读器字号；
 * 3. `rem` → `em`：让 `rem` 语义改为相对 `:host`，从而跟随 `:host` 上设置的阅读器字号。
 *
 * @param css 书籍样式的 CSS 文本
 */
export function normalizeBookCssForShadow(css: string): string {
  if (!css) return css;

  // 1. 选择器改写：html / :root -> :host（仅匹配选择器位置，避免命中属性值/内容）
  let normalized = css
    .replace(/(^|[\s,{>+~])html(?=[\s,{.:#>+~])/gi, '$1:host')
    .replace(/(^|[\s,{>+~]):root(?=[\s,{.:#>+~])/gi, '$1:host');

  // 2. 剥离根级规则（:host / html / body / *）里的 font-size 声明，保留其它属性，
  //    避免书籍自身的 html{font-size:...} 覆盖阅读器设置到 :host 上的字号。
  normalized = normalized.replace(
    /([^{}@]+)\{([^{}]*)\}/g,
    (whole: string, selector: string, body: string) => {
      const selectors = selector.split(',').map((s: string) => s.trim());
      const isRootBlock = selectors.length > 0 &&
        selectors.every((s: string) =>
          /^:host/.test(s) || /^html/.test(s) || /^body/.test(s) || s === '*'
        );
      if (!isRootBlock) return whole;
      const cleaned = body.replace(/\bfont-size\s*:\s*[^;{}]+;?/gi, '');
      return `${selector}{${cleaned}}`;
    }
  );

  // 3. rem -> em（数字 + rem，如 1.6rem / 3rem）
  normalized = normalized.replace(/(\d+(?:\.\d+)?)rem\b/gi, '$1em');

  return normalized;
}

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

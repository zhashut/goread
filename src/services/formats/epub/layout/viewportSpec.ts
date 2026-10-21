/**
 * EPUB 固定版式视口解析
 *
 * 固定版式（pre-paginated）章节会在 head 中通过 viewport meta 声明逻辑页面尺寸，
 * 例如 `<meta name="viewport" content="width=1366, height=768"/>`。
 * 只有宽高都声明为数字时才视为固定版式；缺省、`device-width`、百分比等情况
 * 一律返回 null，调用方据此保持原有流式渲染。
 */

/** 固定版式声明的逻辑页面尺寸 */
export interface FixedLayoutViewport {
  width: number;
  height: number;
}

/** 允许的最大逻辑尺寸，用于拦截异常声明 */
const MAX_DIMENSION = 20000;

/** 允许的最小逻辑尺寸 */
const MIN_DIMENSION = 1;

/**
 * 从章节 HTML 的 head 中解析固定版式视口。
 * @param html 章节原始 HTML（可含资源占位符）
 */
export function parseFixedLayoutViewport(html: string): FixedLayoutViewport | null {
  if (!html) return null;

  // 只扫描 head，避免正文中的同名字符串造成误判；
  // 缺少 </head> 时以 <body> 为界，两者都不存在则放弃解析
  const headEnd = html.search(/<\/head\s*>/i);
  const bodyStart = html.search(/<body\b/i);
  const scopeEnd = headEnd >= 0 ? headEnd : bodyStart;
  if (scopeEnd < 0) return null;
  const scope = html.slice(0, scopeEnd);

  const metaPattern = /<meta\b[^>]*>/gi;
  let metaTag: RegExpExecArray | null;
  while ((metaTag = metaPattern.exec(scope)) !== null) {
    const attributes = parseAttributes(metaTag[0]);
    if (attributes.get('name')?.trim().toLowerCase() !== 'viewport') continue;

    const content = attributes.get('content');
    if (!content) return null;

    // viewport 的 content 形如 "width=1366, height=768"
    const declarations = parseContentDeclarations(content);
    const width = parseDimension(declarations.get('width'));
    const height = parseDimension(declarations.get('height'));
    if (width === null || height === null) return null;
    return { width, height };
  }

  return null;
}

/** 解析标签上的属性（属性值支持双引号、单引号与无引号） */
function parseAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const pattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(tag)) !== null) {
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    attributes.set(match[1].toLowerCase(), value.trim());
  }
  return attributes;
}

/** 解析 viewport content 中的键值对 */
function parseContentDeclarations(content: string): Map<string, string> {
  const declarations = new Map<string, string>();
  for (const part of content.split(/[,;]/)) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex <= 0) continue;
    const key = part.slice(0, separatorIndex).trim().toLowerCase();
    const value = part.slice(separatorIndex + 1).trim();
    if (key) declarations.set(key, value);
  }
  return declarations;
}

/** 解析数值尺寸，排除 device-width、百分比等非数字声明 */
function parseDimension(raw: string | undefined): number | null {
  if (!raw || !/^\d+(?:\.\d+)?$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < MIN_DIMENSION || value > MAX_DIMENSION) return null;
  return value;
}

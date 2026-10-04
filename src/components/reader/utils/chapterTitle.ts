/**
 * 目录激活签名解析
 * 签名格式为 `title|page|level`（title 本身可能包含 `|`），
 * 由 useToc / 各渲染器统一维护。
 */

/**
 * 从激活签名中解析章节标题
 * 无法解析时返回 null，调用方决定回退文案
 */
export const parseChapterTitle = (
  activeNodeSignature: string | undefined
): string | null => {
  if (!activeNodeSignature) return null;

  const parts = activeNodeSignature.split("|");
  // 至少需要 title|page|level 三段
  if (parts.length < 3) return null;

  const title = parts.slice(0, parts.length - 2).join("|").trim();
  return title || null;
};

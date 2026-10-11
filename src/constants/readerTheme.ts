import type { ReaderTheme } from "../services/formats/types";

/**
 * 阅读页主题的「页面底色」
 * 供各格式渲染器与状态栏色条共同使用，避免多处硬编码
 */
export const READER_PAGE_BACKGROUND: Record<ReaderTheme, string> = {
  light: "#ffffff",
  dark: "#1a1a1a",
  sepia: "#f4ecd8",
};

/**
 * 取阅读页主题的页面底色
 * @param theme - 阅读主题标识；渲染器可能传入任意字符串，非法值回退到 light
 */
export const getReaderPageBackground = (theme: string | null | undefined): string =>
  READER_PAGE_BACKGROUND[theme as ReaderTheme] ?? READER_PAGE_BACKGROUND.light;

/**
 * 页面底色是否为深色
 * 用于决定状态栏图标该用浅色还是深色
 */
export const isDarkPageBackground = (theme: ReaderTheme): boolean => theme === "dark";

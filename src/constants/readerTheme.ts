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
 * 阅读页的「外框色」：正文页面之外（画布四周台面、页间空隙）的底色
 * 与页面底色的区别：状态栏/挖孔等顶部与侧边让位带用页面底色（视觉上像页面延伸到屏幕边缘），
 * 页面之外的空余区域用外框色，保持页面与台面的层次
 */
export const READER_FRAME_BACKGROUND: Record<ReaderTheme, string> = {
  light: "#2c2c2c",
  dark: "#000000",
  sepia: "#2c2c2c",
};

/**
 * 取阅读页主题的页面底色
 * @param theme - 阅读主题标识；渲染器可能传入任意字符串，非法值回退到 light
 */
export const getReaderPageBackground = (theme: string | null | undefined): string =>
  READER_PAGE_BACKGROUND[theme as ReaderTheme] ?? READER_PAGE_BACKGROUND.light;

/**
 * 取阅读页主题的外框色
 * @param theme - 阅读主题标识；非法值回退到 light
 */
export const getReaderFrameBackground = (theme: string | null | undefined): string =>
  READER_FRAME_BACKGROUND[theme as ReaderTheme] ?? READER_FRAME_BACKGROUND.light;

/**
 * 页面底色是否为深色
 * 用于决定状态栏图标该用浅色还是深色
 */
export const isDarkPageBackground = (theme: ReaderTheme): boolean => theme === "dark";

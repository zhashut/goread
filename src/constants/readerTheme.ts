import type { ReaderTheme } from "../services/formats/types";

/**
 * 阅读页主题的「页面底色」
 * 阅读页的唯一底色来源：正文页、画布四周、页间空隙以及状态栏/挖孔让位带都用它
 * （全屏同底色，靠纸张投影区分页边界；各格式渲染器也共用它，避免多处硬编码）
 */
export const READER_PAGE_BACKGROUND: Record<ReaderTheme, string> = {
  light: "#ffffff",
  dark: "#1a1a1a",
  sepia: "#f4ecd8",
  green: "#c7edcc",
  gray: "#e3e3e3",
};

/**
 * 阅读页纸张的投影：底色统一后，这是区分「纸」与「底」的唯一手段
 * - 浅色/护眼主题：柔和投影（底色已是浅色，投影不能过重）
 * - 深色主题：纸与底同为深色，投影不可见，改用一圈淡描边
 */
export const READER_PAPER_SHADOW: Record<ReaderTheme, string> = {
  light: "0 4px 20px rgba(0,0,0,0.18)",
  dark: "0 0 0 1px rgba(255,255,255,0.12)",
  sepia: "0 4px 20px rgba(0,0,0,0.18)",
  green: "0 4px 20px rgba(0,0,0,0.18)",
  gray: "0 4px 20px rgba(0,0,0,0.18)",
};

/**
 * 阅读菜单（顶部/底部工具栏）的前景色：菜单底色与页面同色，文字/图标随主题明暗
 */
export const READER_MENU_TEXT: Record<ReaderTheme, string> = {
  light: "#333333",
  dark: "#d6d6d6",
  sepia: "#3d3427",
  green: "#33463a",
  gray: "#424242",
};

/**
 * 阅读菜单图标芯片（圆角方形底）的底色：三种主题下都用深色底 + 白色图标
 */
export const READER_MENU_ICON_CHIP: Record<ReaderTheme, string> = {
  light: "#3a3a3a",
  dark: "#3d3d3d",
  sepia: "#3a3a3a",
  green: "#3a3a3a",
  gray: "#3a3a3a",
};

/**
 * 阅读菜单进度滑条的轨道色：比页面底色略浅/略深一档，形成可见轨道
 */
export const READER_MENU_SLIDER_TRACK: Record<ReaderTheme, string> = {
  light: "#e9e9e9",
  dark: "#3d3d3d",
  sepia: "#ffffff",
  green: "#ffffff",
  gray: "#ffffff",
};

/**
 * 取阅读页主题的页面底色
 * @param theme - 阅读主题标识；渲染器可能传入任意字符串，非法值回退到 light
 */
export const getReaderPageBackground = (theme: string | null | undefined): string =>
  READER_PAGE_BACKGROUND[theme as ReaderTheme] ?? READER_PAGE_BACKGROUND.light;

/**
 * 取阅读页主题的菜单前景色（文字/线性图标）
 * @param theme - 阅读主题标识；非法值回退到 light
 */
export const getReaderMenuText = (theme: string | null | undefined): string =>
  READER_MENU_TEXT[theme as ReaderTheme] ?? READER_MENU_TEXT.light;

/**
 * 取阅读页主题的菜单图标芯片底色
 * @param theme - 阅读主题标识；非法值回退到 light
 */
export const getReaderMenuIconChip = (theme: string | null | undefined): string =>
  READER_MENU_ICON_CHIP[theme as ReaderTheme] ?? READER_MENU_ICON_CHIP.light;

/**
 * 取阅读页主题的菜单进度滑条轨道色
 * @param theme - 阅读主题标识；非法值回退到 light
 */
export const getReaderMenuSliderTrack = (theme: string | null | undefined): string =>
  READER_MENU_SLIDER_TRACK[theme as ReaderTheme] ?? READER_MENU_SLIDER_TRACK.light;

/**
 * 取阅读页主题的纸张投影
 * @param theme - 阅读主题标识；非法值回退到 light
 */
export const getReaderPaperShadow = (theme: string | null | undefined): string =>
  READER_PAPER_SHADOW[theme as ReaderTheme] ?? READER_PAPER_SHADOW.light;

/**
 * 判断底色是否为深色（用于决定状态栏图标该用浅色还是深色）
 * 传入的是实际底色而非主题名：让位带上方可能是浮层、下方可能是不同格式的页面，
 * 只有按实际颜色判断才能保证图标始终可见
 * @param color - #rgb / #rrggbb 形式的颜色；非法值按浅色处理
 */
export const isDarkColor = (color: string): boolean => {
  const hex = color.trim().replace(/^#/, "");
  const normalized = hex.length === 3
    ? hex.split("").map((c) => c + c).join("")
    : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return false;

  const r = parseInt(normalized.slice(0, 2), 16);
  const g = parseInt(normalized.slice(2, 4), 16);
  const b = parseInt(normalized.slice(4, 6), 16);
  // 感知亮度（BT.601），阈值 0.5
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
};

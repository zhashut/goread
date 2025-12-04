export const RENDER_QUALITY_OPTIONS = [
  { label: "极速(Thumbnail)", value: "thumbnail" },
  { label: "标准(Standard)", value: "standard" },
  { label: "高清(High)", value: "high" },
  { label: "超清(Best)", value: "best" },
];

export const DEFAULT_RENDER_QUALITY = "standard";

export const QUALITY_SCALE_MAP: Record<string, number> = {
  thumbnail: 0.5,
  standard: 1.0,
  high: 1.5,
  best: 2.0,
};

// 最近显示数量选项
export const RECENT_DISPLAY_COUNT_OPTIONS = [5, 7, 9, 12, 15];
export const RECENT_DISPLAY_COUNT_UNLIMITED = 0;

// 滚动速度配置
export const SCROLL_SPEED_MIN = 60;
export const SCROLL_SPEED_MAX = 300;
export const SCROLL_SPEED_STEP = 10;

// 页面间隙配置
export const PAGE_GAP_MIN = 0;
export const PAGE_GAP_MAX = 48;
export const PAGE_GAP_STEP = 2;

// 设置保存防抖时间 (ms)
export const SETTINGS_SAVE_DEBOUNCE_MS = 100;

// 默认设置
export const DEFAULT_SETTINGS = {
  volumeKeyTurnPage: false,
  clickTurnPage: true,
  showStatusBar: false,
  pageTransition: true,
  recentDisplayCount: 9,
  scrollSpeed: 120,
  pageGap: 4,
  readingMode: 'vertical' as const,
  renderQuality: DEFAULT_RENDER_QUALITY,
};

// 阅读器自动翻页/滚动配置
export const AUTO_PAGE_INTERVAL_MS = 2000; // 横向自动翻页间隔
export const DEFAULT_SCROLL_SPEED_PX_PER_SEC = 120; // 纵向每秒滚动像素

// 缓存配置
export const PAGE_CACHE_SIZE = 100; // 页面缓存数量
export const PAGE_CACHE_MEMORY_LIMIT_MB = 500; // 页面缓存内存限制 (MB)

// UI 交互配置
export const RESIZE_DEBOUNCE_MS = 300; // 窗口大小改变防抖时间
export const TOAST_DURATION_SHORT_MS = 1200; // 短提示显示时间
export const TOAST_DURATION_LONG_MS = 2000; // 长提示显示时间
export const TOAST_DURATION_ERROR_MS = 3000; // 错误提示显示时间
export const LAZY_LOAD_ROOT_MARGIN = "800px 0px 800px 0px"; // 懒加载预加载距离

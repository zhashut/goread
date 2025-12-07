// 交互手势相关常量配置

// 屏幕边缘滑动忽略阈值（px），防止与系统侧滑返回冲突
export const SWIPE_EDGE_THRESHOLD = 55;

// 触发切换的最小滑动距离（px）
export const SWIPE_MIN_DISTANCE = 50;

// 滑动斜率阈值 (水平距离 / 垂直距离)，大于此值才判定为水平滑动
export const SWIPE_MIN_SLOPE = 1.5;

// 误触防止时间窗口（ms），如关闭浮层后的冷却时间
export const TOUCH_COOLDOWN_MS = 300;

// 拖拽相关阈值（桌面）
export const DRAG_MOUSE_DISTANCE_PX = 8;

// 拖拽相关阈值（移动端长按）
export const DRAG_TOUCH_DELAY_MS = 350;
export const DRAG_TOUCH_TOLERANCE_PX = 8;

// 拖拽释放保护时间（避免触摸结束瞬时误判）
export const DRAG_STATUS_RELEASE_DELAY_MS = 120;
// 选择模式长按延迟（移动端优先）；桌面可共用该值
export const SELECTION_LONGPRESS_DELAY_MS = 550;

// 屏幕边缘滑动忽略阈值（px），防止与系统侧滑返回冲突
export const SWIPE_EDGE_THRESHOLD = 55;
// 触发切换的最小滑动距离（px）
export const SWIPE_MIN_DISTANCE = 50;
// 滑动斜率阈值（水平距离 / 垂直距离），大于此值才判定为水平滑动
export const SWIPE_MIN_SLOPE = 1.5;
// 触控误触防止时间窗口（ms），用于操作后的冷却时间
export const TOUCH_COOLDOWN_MS = 300;
// 鼠标拖拽触发最小距离（px）
export const DRAG_MOUSE_DISTANCE_PX = 8;
// 触屏拖拽长按触发延迟（ms）
export const DRAG_TOUCH_DELAY_MS = 350;
// 触屏拖拽允许的起始抖动范围（px）
export const DRAG_TOUCH_TOLERANCE_PX = 8;
// 拖拽释放状态保持时间（ms），避免释放瞬间误判
export const DRAG_STATUS_RELEASE_DELAY_MS = 120;
// 选择模式长按触发延迟（ms）
export const SELECTION_LONGPRESS_DELAY_MS = 550;
// 阅读空闲判定阈值（ms），超过后停止累加阅读时长
export const READING_INACTIVITY_THRESHOLD_MS = 10 * 60 * 1000;

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

// ===== 翻页手势（T30 统一手势层）=====
// 方向判定死区（px）：位移小于该值不判定方向（区分点击与拖拽）
export const PAGE_TURN_DECIDE_THRESHOLD_PX = 4;
// 翻页手势的屏幕边缘忽略阈值（px）：仅排除贴边窄条，让位系统侧滑返回手势；
// 相比通用 SWIPE_EDGE_THRESHOLD(55) 大幅缩小，避免吞掉左/右下角（拇指常用落点）起步的翻页滑动
export const PAGE_TURN_EDGE_IGNORE_PX = 12;
// 方向判定斜率系数：水平位移 > 纵向位移 × 该系数才判定为横向翻页手势
export const PAGE_TURN_SLOPE_FACTOR = 1.2;
// settle 翻页的位移比例阈值：拖拽位移超过视口宽 × 该比例即判定翻页
export const PAGE_TURN_DISTANCE_RATIO = 0.25;
// settle 翻页的甩动速度阈值（px/ms）
export const PAGE_TURN_FLING_VELOCITY = 0.3;
// 速度采样窗口（ms）：取松手前该时间窗内的采样点计算瞬时速度
export const PAGE_TURN_VELOCITY_WINDOW_MS = 100;
// 拖拽手势结束后的点击抑制窗口（ms）：防止拖拽松手误触发分区点击
export const PAGE_TURN_CLICK_SUPPRESS_MS = 400;

// ===== 平移翻页动画（T31 slide 效果）=====
// 点击/键盘翻页的补间总时长（ms），单页模型拆为滑出+滑入两段
export const PAGE_TURN_SLIDE_CLICK_DURATION_MS = 240;
// settle 翻页补间时长（ms）：多栏模型从松手位移补间到目标栏位
export const PAGE_TURN_SLIDE_SETTLE_DURATION_MS = 200;
// 回弹补间时长（ms）：settle 未通过时从当前位移回到原位
export const PAGE_TURN_SLIDE_REBOUND_DURATION_MS = 200;
// 单页模型（PDF/TXT）点击翻页的滑出段时长（ms）
export const PAGE_TURN_SLIDE_OUT_DURATION_MS = 110;
// 单页模型（PDF/TXT）点击翻页的滑入段时长（ms）
export const PAGE_TURN_SLIDE_IN_DURATION_MS = 130;

// ===== 覆盖翻页动画（T32 cover 效果）=====
// 点击/键盘翻页的克隆层补间总时长（ms），两段式降级路径按滑出/滑入比例拆分
export const PAGE_TURN_COVER_CLICK_DURATION_MS = 260;
// settle 翻页克隆层补间时长（ms）：拖拽松手后克隆层滑入/滑出收尾
export const PAGE_TURN_COVER_SETTLE_DURATION_MS = 200;
// 回弹补间时长（ms）：settle 未通过时克隆层退回原位
export const PAGE_TURN_COVER_REBOUND_DURATION_MS = 200;
// 阅读空闲判定阈值（ms），超过后停止累加阅读时长
export const READING_INACTIVITY_THRESHOLD_MS = 10 * 60 * 1000;

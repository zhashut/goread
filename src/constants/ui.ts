// 统一的卡片尺寸与比例配置
export const CARD_WIDTH_COMPACT = 140; // 与分组卡片一致
export const CARD_MIN_WIDTH = 85; // 响应式布局的最小卡片宽度，确保小屏能放3个
export const COVER_ASPECT_RATIO_COMPACT = "3 / 4"; // 与分组封面统一
export const BOOK_TITLE_FONT_SIZE = 12; // 书籍卡片标题字体大小（px）
export const BOOK_TITLE_FONT_WEIGHT = 600; // 书籍卡片标题加粗权重
export const GROUP_NAME_FONT_WEIGHT = BOOK_TITLE_FONT_WEIGHT; // 分组名加粗权重与书籍标题一致
// 书籍/分组的次级文案字号（如阅读进度、“共 x 本”）
export const BOOK_META_FONT_SIZE = 12; // 与书籍阅读进度一致
export const GROUP_NAME_FONT_SIZE = BOOK_TITLE_FONT_SIZE; // 分组名与书籍标题字号对齐
export const GROUP_META_FONT_SIZE = BOOK_META_FONT_SIZE; // 分组“共 x 本”与书籍进度字号对齐
// 文案块的上下间距
export const CARD_INFO_MARGIN_TOP = 8; // 封面下方信息块统一上间距
export const BOOK_PROGRESS_MARGIN_TOP = 1; // 书籍阅读进度的上间距
export const GROUP_NAME_MARGIN_TOP = 0; // 分组名与书籍标题保持一致（标题本身无上间距）
export const GROUP_META_MARGIN_TOP = BOOK_PROGRESS_MARGIN_TOP; // “共 x 本”与阅读进度保持一致
// 统一的网格间距（在现有基础上统一加 3px）
export const GRID_GAP_BOOK_CARDS = 19; // 最近/搜索页书籍卡片
export const GRID_GAP_GROUP_DETAIL = 19; // 分组详情书籍卡片
export const GRID_GAP_GROUP_ROW = GRID_GAP_BOOK_CARDS; // 全部栏目分组卡片行间距对齐最近书籍卡片
export const GRID_GAP_GROUP_COLUMN = GRID_GAP_BOOK_CARDS; // 分组列间距与书籍完全一致，确保三列布局

// 选择单选图标统一配置
export const SELECTION_ICON_SIZE = 24; // 选择单选圆标尺寸（px）
export const SELECTION_ICON_OFFSET_TOP = 0.5; // 相对容器顶部的偏移（px）
export const SELECTION_ICON_OFFSET_RIGHT = 0.5; // 相对容器右侧的偏移（px）

// 分组封面容器（默认样式）内边距，用于对齐选择图标到内容边缘
export const GROUP_COVER_PADDING = 4; // 与 GroupCoverGrid 默认 variant 的 padding 对齐（已从 6px 减小到 4px）
export const GROUP_COVER_PADDING_COMPACT = 4; // 紧凑 variant 的 padding

export const TOP_DRAWER_RADIUS = 15;

// 顶部栏配置
export const TOP_BAR_TAB_FONT_SIZE = 22; // 顶部选项卡（最近/全部）字体大小
export const TOP_BAR_ICON_SIZE = 26; // 顶部图标（搜索/更多）大小
export const TOP_BAR_TAB_PADDING_BOTTOM = 6; // 选项卡底部内边距（控制栏目高度）
export const TOP_BAR_MARGIN_BOTTOM = 16; // 顶部栏下方间距
export const TOP_BAR_ICON_GAP = 12; // 图标之间的间距
export const BOTTOM_DRAWER_RADIUS = 16;

// Markdown 默认封面配置
export const MARKDOWN_COVER_PLACEHOLDER = "__MARKDOWN__";
export const MARKDOWN_COVER_SCALE = 1.6;

// HTML 默认封面配置
export const HTML_COVER_PLACEHOLDER = "__HTML__";

// 页面顶部栏配置（关于/设置/统计/导入等二级页面）
export const PAGE_HEADER_HEIGHT = 50;          // 顶部栏内容区高度（不含安全区）
export const PAGE_HEADER_BACK_ICON_SIZE = 24;  // 返回图标尺寸
export const PAGE_HEADER_TITLE_FONT_SIZE = 18; // 标题字号
export const PAGE_HEADER_TITLE_FONT_WEIGHT = 500; // 标题字重
export const PAGE_HEADER_TITLE_MARGIN_LEFT = 20;  // 标题与返回图标间距
export const PAGE_HEADER_PADDING_HORIZONTAL = 16; // 水平内边距

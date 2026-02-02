use serde::{Deserialize, Serialize};
use sqlx::FromRow;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Book {
    pub id: Option<i64>,
    pub title: String,
    pub file_path: String,
    pub cover_image: Option<String>, // Base64 encoded image
    pub current_page: i64,
    pub total_pages: u32,
    pub last_read_time: Option<i64>, // Unix timestamp
    pub group_id: Option<i64>,
    pub position_in_group: Option<i64>,
    pub created_at: Option<i64>,
    pub status: Option<i64>,       // 阅读状态：0=阅读中，1=已读完
    pub finished_at: Option<i64>,  // 完成时间戳
    pub recent_order: Option<i64>, // 最近阅读排序值，值越大越靠前
    pub theme: Option<String>,
    pub reading_mode: Option<String>, // 阅读模式：horizontal=横向分页，vertical=纵向滚动
    pub precise_progress: Option<f64>,
    pub hide_divider: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Group {
    pub id: Option<i64>,
    pub name: String,
    pub book_count: u32,
    pub created_at: Option<i64>,
    pub sort_order: Option<i64>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BookMetadata {
    pub title: String,
    pub author: Option<String>,
    pub subject: Option<String>,
    pub creation_date: Option<String>,
    pub creator: Option<String>,
    pub producer: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Bookmark {
    pub id: Option<i64>,
    pub book_id: i64,
    pub page_number: u32,
    pub title: String,
    pub created_at: Option<i64>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TocItem {
    pub title: String,
    pub page_number: u32,
    pub children: Vec<TocItem>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReaderSettings {
    pub theme: String,          // "light" or "dark"
    pub render_quality: String, // "low", "medium", "high"
    pub keep_screen_on: bool,
    pub auto_save_progress: bool,
}

// ==================== 阅读统计相关模型 ====================

/// 阅读会话记录
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct ReadingSession {
    pub id: Option<i64>,
    pub book_id: i64,
    pub start_time: i64,   // 开始时间戳（秒）
    pub duration: i64,     // 持续时长（秒）
    pub read_date: String, // 日期 'YYYY-MM-DD'
    pub pages_read_count: Option<i64>,
    pub created_at: Option<i64>,
}

/// 每日统计数据
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct DailyStats {
    pub date: String,
    pub total_seconds: i64,
}

/// 书籍阅读统计
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct BookReadingStats {
    pub book_id: i64,
    pub title: String,
    pub cover_image: Option<String>,
    pub total_duration: i64,
    pub progress: String,  // "xx%"
    pub last_read: String, // 格式化的时间描述
}

/// 统计概览数据
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatsSummary {
    pub total_time_seconds: i64,
    pub streak_days: i64,
    pub finished_books: i64,
}

/// 周桶区间（用于月视图的自然周划分）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RangeBucket {
    pub start_date: String,
    pub end_date: String,
}

/// 时间范围统计数据（用于柱状图）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RangeStats {
    pub labels: Vec<String>,         // 标签（如 周一, 周二...）
    pub values: Vec<i64>,            // 对应的秒数
    pub start_date: String,          // 范围开始日期
    pub end_date: String,            // 范围结束日期
    pub total_seconds: i64,          // 总秒数
    pub previous_total_seconds: i64, // 上一周期总秒数（用于计算环比）
    pub buckets: Option<Vec<RangeBucket>>, // 周桶信息（月视图用）
}

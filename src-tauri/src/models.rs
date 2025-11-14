use serde::{Deserialize, Serialize};
use sqlx::FromRow;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Book {
    pub id: Option<i64>,
    pub title: String,
    pub file_path: String,
    pub cover_image: Option<String>, // Base64 encoded image
    pub current_page: u32,
    pub total_pages: u32,
    pub last_read_time: Option<i64>, // Unix timestamp
    pub group_id: Option<i64>,
    pub position_in_group: Option<i64>,
    pub created_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Group {
    pub id: Option<i64>,
    pub name: String,
    pub book_count: u32,
    pub created_at: Option<i64>,
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
    pub theme: String, // "light" or "dark"
    pub render_quality: String, // "low", "medium", "high"
    pub keep_screen_on: bool,
    pub auto_save_progress: bool,
}
use crate::cover;
use crate::models::Book;
use sqlx::SqlitePool;
use std::sync::Arc;
use tauri::{AppHandle, State};
use tokio::sync::Mutex;

#[derive(Debug)]
pub enum Error {
    Database(tauri_plugin_sql::Error),
    Message(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Database(e) => write!(f, "Database error: {}", e),
            Error::Message(e) => write!(f, "{}", e),
        }
    }
}

impl std::error::Error for Error {}

impl From<tauri_plugin_sql::Error> for Error {
    fn from(error: tauri_plugin_sql::Error) -> Self {
        Error::Database(error)
    }
}

impl From<String> for Error {
    fn from(error: String) -> Self {
        Error::Message(error)
    }
}

impl From<sqlx::Error> for Error {
    fn from(error: sqlx::Error) -> Self {
        Error::Database(tauri_plugin_sql::Error::Sql(error))
    }
}

impl serde::Serialize for Error {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::ser::Serializer,
    {
        serializer.serialize_str(&format!("{}", self))
    }
}

pub type DbState<'a> = State<'a, Arc<Mutex<SqlitePool>>>;

#[tauri::command]
pub async fn init_database(db: DbState<'_>) -> Result<(), Error> {
    let pool = db.lock().await;

    // Create tables
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS groups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            book_count INTEGER DEFAULT 0,
            created_at INTEGER DEFAULT (strftime('%s', 'now'))
        )",
    )
    .execute(&*pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS books (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            file_path TEXT NOT NULL UNIQUE,
            cover_image TEXT,
            current_page INTEGER DEFAULT 1,
            total_pages INTEGER DEFAULT 1,
            last_read_time INTEGER,
            group_id INTEGER,
            position_in_group INTEGER,
            precise_progress REAL,
            theme TEXT,
            created_at INTEGER DEFAULT (strftime('%s', 'now')),
            FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE SET NULL
        )",
    )
    .execute(&*pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS bookmarks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            book_id INTEGER NOT NULL,
            page_number INTEGER NOT NULL,
            title TEXT NOT NULL,
            created_at INTEGER DEFAULT (strftime('%s', 'now')),
            FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
        )",
    )
    .execute(&*pool)
    .await?;

    // 阅读统计表
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS reading_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            book_id INTEGER NOT NULL,
            start_time INTEGER NOT NULL,
            duration INTEGER NOT NULL,
            read_date TEXT NOT NULL,
            pages_read_count INTEGER DEFAULT 0,
            created_at INTEGER DEFAULT (strftime('%s', 'now')),
            FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
        )",
    )
    .execute(&*pool)
    .await?;

    // Migrations
    let _ = sqlx::query("ALTER TABLE books ADD COLUMN position_in_group INTEGER")
        .execute(&*pool)
        .await;

    // 阅读统计相关字段迁移
    let _ = sqlx::query("ALTER TABLE books ADD COLUMN status INTEGER DEFAULT 0")
        .execute(&*pool)
        .await;
    let _ = sqlx::query("ALTER TABLE books ADD COLUMN finished_at INTEGER")
        .execute(&*pool)
        .await;

    // 最近阅读排序字段迁移
    let _ = sqlx::query("ALTER TABLE books ADD COLUMN recent_order INTEGER")
        .execute(&*pool)
        .await;

    let _ = sqlx::query("ALTER TABLE books ADD COLUMN theme TEXT")
        .execute(&*pool)
        .await;

    let _ = sqlx::query("ALTER TABLE books ADD COLUMN precise_progress REAL")
        .execute(&*pool)
        .await;

    // 阅读模式字段迁移（默认纵向模式）
    let _ = sqlx::query("ALTER TABLE books ADD COLUMN reading_mode TEXT DEFAULT 'vertical'")
        .execute(&*pool)
        .await;

    // 隐藏页分隔线字段迁移
    let _ = sqlx::query("ALTER TABLE books ADD COLUMN hide_divider INTEGER DEFAULT 0")
        .execute(&*pool)
        .await;

    let _ = sqlx::query(
        "UPDATE books SET precise_progress = current_page WHERE precise_progress IS NULL",
    )
    .execute(&*pool)
    .await;

    let _ = sqlx::query("UPDATE books SET current_page = CAST(current_page AS INTEGER)")
        .execute(&*pool)
        .await;

    // 首次升级时迁移：按 last_read_time 初始化 recent_order
    let needs_migration: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM books WHERE recent_order IS NOT NULL")
            .fetch_one(&*pool)
            .await?;

    if needs_migration == 0 {
        // 按 last_read_time 倒序，给每本有阅读记录的书分配 recent_order
        sqlx::query(
            "UPDATE books SET recent_order = (
                SELECT COUNT(*) FROM books b2 
                WHERE b2.last_read_time IS NOT NULL 
                AND (b2.last_read_time < books.last_read_time 
                     OR (b2.last_read_time = books.last_read_time AND b2.id < books.id))
            ) + 1
            WHERE last_read_time IS NOT NULL",
        )
        .execute(&*pool)
        .await?;
    }

    // groups 表 sort_order 字段迁移
    let _ = sqlx::query("ALTER TABLE groups ADD COLUMN sort_order INTEGER")
        .execute(&*pool)
        .await;

    // 为老数据初始化 sort_order（按 created_at 倒序）
    let needs_group_order: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM groups WHERE sort_order IS NOT NULL")
            .fetch_one(&*pool)
            .await?;

    if needs_group_order == 0 {
        sqlx::query(
            "UPDATE groups SET sort_order = (
                SELECT COUNT(*) FROM groups g2 
                WHERE g2.book_count > 0 
                AND (g2.created_at > groups.created_at 
                     OR (g2.created_at = groups.created_at AND g2.id > groups.id))
            ) + 1
            WHERE book_count > 0",
        )
        .execute(&*pool)
        .await?;
    }

    // Indexes
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_books_last_read_time ON books(last_read_time)")
        .execute(&*pool)
        .await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_books_group_id ON books(group_id)")
        .execute(&*pool)
        .await?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_books_group_pos ON books(group_id, position_in_group)",
    )
    .execute(&*pool)
    .await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_books_recent_order ON books(recent_order)")
        .execute(&*pool)
        .await?;

    // 分组排序索引
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_groups_sort_order ON groups(sort_order)")
        .execute(&*pool)
        .await?;

    // 阅读统计索引
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_sessions_read_date ON reading_sessions(read_date)")
        .execute(&*pool)
        .await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_sessions_book_id ON reading_sessions(book_id)")
        .execute(&*pool)
        .await?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_sessions_start_time ON reading_sessions(start_time)",
    )
    .execute(&*pool)
    .await?;
    // Create default group
    sqlx::query("INSERT OR IGNORE INTO groups (id, name, book_count) VALUES (1, '默认分组', 0)")
        .execute(&*pool)
        .await?;

    Ok(())
}

#[tauri::command]
pub async fn add_book(
    app_handle: AppHandle,
    path: String,
    title: String,
    cover_image: Option<String>,
    total_pages: u32,
    db: DbState<'_>,
) -> Result<Book, Error> {
    let pool = db.lock().await;

    // 处理封面：如果是 Base64 则保存为文件
    let processed_cover = match cover_image.as_deref() {
        Some(data) if !data.is_empty() => {
            match cover::process_cover_for_storage(&app_handle, &path, Some(data)).await {
                Ok(path) => path,
                Err(e) => {
                    // 记录错误但不影响导入
                    eprintln!("[add_book] Failed to save cover: {}", e);
                    None
                }
            }
        }
        _ => None,
    };

    let result = sqlx::query(
        "INSERT OR IGNORE INTO books (title, file_path, cover_image, total_pages) VALUES (?, ?, ?, ?)"
    )
    .bind(&title)
    .bind(&path)
    .bind(&processed_cover)
    .bind(total_pages as i64)
    .execute(&*pool).await?;

    let book = if result.rows_affected() == 0 {
        sqlx::query_as::<_, Book>("SELECT * FROM books WHERE file_path = ?")
            .bind(&path)
            .fetch_one(&*pool)
            .await?
    } else {
        let book_id = result.last_insert_rowid();
        sqlx::query_as::<_, Book>("SELECT * FROM books WHERE id = ?")
            .bind(book_id)
            .fetch_one(&*pool)
            .await?
    };

    Ok(book)
}

#[tauri::command]
pub async fn get_all_books(db: DbState<'_>) -> Result<Vec<Book>, Error> {
    let pool = db.lock().await;

    let books = sqlx::query_as::<_, Book>(
        "SELECT * FROM books ORDER BY last_read_time DESC NULLS LAST, created_at DESC",
    )
    .fetch_all(&*pool)
    .await?;

    Ok(books)
}

#[tauri::command]
pub async fn get_recent_books(limit: u32, db: DbState<'_>) -> Result<Vec<Book>, Error> {
    let pool = db.lock().await;

    // 仅根据 recent_order 维护最近阅读列表，last_read_time 用于排序兜底
    // 这样在清除最近记录时可以保留 last_read_time，不影响已读状态展示
    let books = sqlx::query_as::<_, Book>(
        "SELECT * FROM books WHERE last_read_time IS NOT NULL 
         ORDER BY recent_order IS NULL, recent_order DESC, last_read_time DESC LIMIT ?",
    )
    .bind(limit as i64)
    .fetch_all(&*pool)
    .await?;

    Ok(books)
}

#[tauri::command]
pub async fn update_book_progress(
    id: i64,
    current_page: f64,
    db: DbState<'_>,
) -> Result<(), Error> {
    let pool = db.lock().await;

    let page_int = current_page.floor() as i64;

    // 获取当前最大 recent_order
    let max_order: Option<i64> =
        sqlx::query_scalar("SELECT MAX(recent_order) FROM books WHERE last_read_time IS NOT NULL")
            .fetch_one(&*pool)
            .await?;
    let next_order = max_order.unwrap_or(0) + 1;

    // 同时更新进度、阅读时间和排序
    sqlx::query(
        "UPDATE books SET current_page = ?, precise_progress = ?, last_read_time = strftime('%s', 'now'), recent_order = ? WHERE id = ?",
    )
    .bind(page_int)
    .bind(current_page)
    .bind(next_order)
    .bind(id)
    .execute(&*pool)
    .await?;

    Ok(())
}

#[tauri::command]
pub async fn update_book_total_pages(
    id: i64,
    total_pages: u32,
    db: DbState<'_>,
) -> Result<(), Error> {
    let pool = db.lock().await;

    sqlx::query("UPDATE books SET total_pages = ? WHERE id = ?")
        .bind(total_pages as i64)
        .bind(id)
        .execute(&*pool)
        .await?;

    Ok(())
}

#[tauri::command]
pub async fn update_book_theme(id: i64, theme: Option<String>, db: DbState<'_>) -> Result<(), Error> {
    let pool = db.lock().await;

    if let Some(t) = theme.as_deref() {
        if t != "light" && t != "dark" {
            return Err(Error::Message("Invalid theme".to_string()));
        }
    }

    sqlx::query("UPDATE books SET theme = ? WHERE id = ?")
        .bind(theme.as_deref())
        .bind(id)
        .execute(&*pool)
        .await?;

    Ok(())
}

#[tauri::command]
pub async fn reset_all_book_themes(db: DbState<'_>) -> Result<(), Error> {
    let pool = db.lock().await;
    sqlx::query("UPDATE books SET theme = NULL")
        .execute(&*pool)
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn update_book_reading_mode(
    id: i64,
    reading_mode: Option<String>,
    db: DbState<'_>,
) -> Result<(), Error> {
    let pool = db.lock().await;

    if let Some(m) = reading_mode.as_deref() {
        if m != "horizontal" && m != "vertical" {
            return Err(Error::Message("Invalid reading mode".to_string()));
        }
    }

    sqlx::query("UPDATE books SET reading_mode = ? WHERE id = ?")
        .bind(reading_mode.as_deref())
        .bind(id)
        .execute(&*pool)
        .await?;

    Ok(())
}

#[tauri::command]
pub async fn update_book_hide_divider(
    id: i64,
    hide: bool,
    db: DbState<'_>,
) -> Result<(), Error> {
    let pool = db.lock().await;

    sqlx::query("UPDATE books SET hide_divider = ? WHERE id = ?")
        .bind(hide)
        .bind(id)
        .execute(&*pool)
        .await?;

    Ok(())
}

#[tauri::command]
pub async fn mark_book_opened(
    app_handle: AppHandle,
    id: i64,
    db: DbState<'_>,
) -> Result<bool, Error> {
    let pool = db.lock().await;

    // 获取当前最大 recent_order
    let max_order: Option<i64> =
        sqlx::query_scalar("SELECT MAX(recent_order) FROM books WHERE last_read_time IS NOT NULL")
            .fetch_one(&*pool)
            .await?;
    let next_order = max_order.unwrap_or(0) + 1;

    // 同时更新阅读时间和排序，使该书移到最前
    sqlx::query(
        "UPDATE books SET last_read_time = strftime('%s', 'now'), recent_order = ? WHERE id = ?",
    )
    .bind(next_order)
    .bind(id)
    .execute(&*pool)
    .await?;

    // 封面兜底检查：判断封面文件是否存在，返回是否需要重建
    let book: Option<Book> = sqlx::query_as::<_, Book>("SELECT * FROM books WHERE id = ?")
        .bind(id)
        .fetch_optional(&*pool)
        .await?;

    if let Some(book) = book {
        if let Some(ref cover_image) = book.cover_image {
            if !cover_image.is_empty() && cover::is_file_path(cover_image) {
                let exists = cover::cover_file_exists(&app_handle, cover_image).await;
                if !exists && cover::can_rebuild_cover(&book.file_path) {
                    return Ok(true);
                }
            }
        }
    }

    Ok(false)
}

#[tauri::command]
pub async fn delete_book(
    app_handle: AppHandle,
    id: i64,
    delete_local: bool,
    db: DbState<'_>,
) -> Result<(), Error> {
    let pool = db.lock().await;

    // 先获取书籍信息（用于删除本地文件和封面）
    let book: Option<Book> = sqlx::query_as::<_, Book>("SELECT * FROM books WHERE id = ?")
        .bind(id)
        .fetch_optional(&*pool)
        .await?;

    if let Some(ref book) = book {
        // 删除封面文件
        if let Some(ref cover_image) = book.cover_image {
            if cover::is_file_path(cover_image) {
                match cover::delete_cover_file(&app_handle, cover_image).await {
                    Ok(_) => {
                        println!("[delete_book] Successfully deleted cover file: {}", cover_image);
                    }
                    Err(e) => {
                        eprintln!("[delete_book] Failed to delete cover file {}: {}", cover_image, e);
                    }
                }
            }
        }

        // 删除本地书籍文件
        if delete_local {
            match tokio::fs::remove_file(&book.file_path).await {
                Ok(_) => {
                    println!("[delete_book] Successfully deleted local file: {}", book.file_path);
                }
                Err(e) => {
                    eprintln!("[delete_book] Failed to delete local file {}: {}", book.file_path, e);
                }
            }
        }
    }

    let old_group: Option<i64> = sqlx::query_scalar("SELECT group_id FROM books WHERE id = ?")
        .bind(id)
        .fetch_one(&*pool)
        .await?;

    sqlx::query("DELETE FROM books WHERE id = ?")
        .bind(id)
        .execute(&*pool)
        .await?;

    if let Some(gid) = old_group {
        sqlx::query(
            "UPDATE groups SET book_count = (SELECT COUNT(*) FROM books WHERE group_id = ?) WHERE id = ?"
        )
        .bind(gid)
        .bind(gid)
        .execute(&*pool).await?;
        sqlx::query("DELETE FROM groups WHERE id = ? AND book_count = 0")
            .bind(gid)
            .execute(&*pool)
            .await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn clear_recent_read_record(id: i64, db: DbState<'_>) -> Result<(), Error> {
    let pool = db.lock().await;
    // 仅清除 recent_order，将书籍从「最近」列表中移除
    // last_read_time 保留用于判断是否有阅读记录，避免影响已读状态展示
    sqlx::query("UPDATE books SET recent_order = NULL WHERE id = ?")
        .bind(id)
        .execute(&*pool)
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn update_books_last_read_time(
    updates: Vec<(i64, i64)>,
    db: DbState<'_>,
) -> Result<(), Error> {
    let pool = db.lock().await;
    let mut tx = pool.begin().await?;

    for (id, time) in updates {
        sqlx::query("UPDATE books SET last_read_time = ? WHERE id = ?")
            .bind(time)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }

    tx.commit().await?;
    Ok(())
}

/// 重排最近阅读书籍顺序
#[tauri::command]
pub async fn reorder_recent_books(ordered_ids: Vec<i64>, db: DbState<'_>) -> Result<(), Error> {
    let pool = db.lock().await;

    // 获取当前全局最大 recent_order 作为基准
    // 这确保拖拽后的可见书籍的 order 值都高于不可见的书籍
    let max_order: Option<i64> =
        sqlx::query_scalar("SELECT MAX(recent_order) FROM books WHERE last_read_time IS NOT NULL")
            .fetch_one(&*pool)
            .await?;

    let base = max_order.unwrap_or(0);
    let total = ordered_ids.len() as i64;

    let mut tx = (&*pool).begin().await?;

    for (idx, bid) in ordered_ids.iter().enumerate() {
        // 第一本书获得最高值 (base + total)，最后一本获得 (base + 1)
        // 这样可见书籍的顺序总是在不可见书籍之前
        let order_val = base + total - (idx as i64);
        sqlx::query("UPDATE books SET recent_order = ? WHERE id = ?")
            .bind(order_val)
            .bind(bid)
            .execute(&mut *tx)
            .await?;
    }

    tx.commit().await?;
    Ok(())
}

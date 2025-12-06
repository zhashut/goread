use crate::models::Book;
use sqlx::SqlitePool;
use std::sync::Arc;
use tauri::State;
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

    // Migrations
    let _ = sqlx::query("ALTER TABLE books ADD COLUMN position_in_group INTEGER")
        .execute(&*pool)
        .await;

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

    // Create default group
    sqlx::query("INSERT OR IGNORE INTO groups (id, name, book_count) VALUES (1, '默认分组', 0)")
        .execute(&*pool)
        .await?;

    Ok(())
}

#[tauri::command]
pub async fn add_book(
    path: String,
    title: String,
    cover_image: Option<String>,
    total_pages: u32,
    db: DbState<'_>,
) -> Result<Book, Error> {
    let pool = db.lock().await;

    let result = sqlx::query(
        "INSERT OR IGNORE INTO books (title, file_path, cover_image, total_pages) VALUES (?, ?, ?, ?)"
    )
    .bind(&title)
    .bind(&path)
    .bind(&cover_image)
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

    let books = sqlx::query_as::<_, Book>(
        "SELECT * FROM books WHERE last_read_time IS NOT NULL ORDER BY last_read_time DESC LIMIT ?"
    )
    .bind(limit as i64)
    .fetch_all(&*pool)
    .await?;

    Ok(books)
}

#[tauri::command]
pub async fn update_book_progress(
    id: i64,
    current_page: u32,
    db: DbState<'_>,
) -> Result<(), Error> {
    let pool = db.lock().await;

    sqlx::query(
        "UPDATE books SET current_page = ?, last_read_time = strftime('%s', 'now') WHERE id = ?",
    )
    .bind(current_page as i64)
    .bind(id)
    .execute(&*pool)
    .await?;

    Ok(())
}

#[tauri::command]
pub async fn mark_book_opened(id: i64, db: DbState<'_>) -> Result<(), Error> {
    let pool = db.lock().await;
    sqlx::query("UPDATE books SET last_read_time = strftime('%s', 'now') WHERE id = ?")
        .bind(id)
        .execute(&*pool)
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn delete_book(id: i64, db: DbState<'_>) -> Result<(), Error> {
    let pool = db.lock().await;
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
    sqlx::query("UPDATE books SET last_read_time = NULL WHERE id = ?")
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

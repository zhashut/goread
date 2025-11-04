use crate::models::{Book, Group, Bookmark};
use tauri::State;
use sqlx::SqlitePool;
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Debug)]
pub enum Error {
    Database(tauri_plugin_sql::Error),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Database(e) => write!(f, "Database error: {}", e),
        }
    }
}

impl std::error::Error for Error {}

impl From<tauri_plugin_sql::Error> for Error {
    fn from(error: tauri_plugin_sql::Error) -> Self {
        Error::Database(error)
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

type DbState<'a> = State<'a, Arc<Mutex<SqlitePool>>>;

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
        )"
    ).execute(&*pool).await?;

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
            created_at INTEGER DEFAULT (strftime('%s', 'now')),
            FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE SET NULL
        )"
    ).execute(&*pool).await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS bookmarks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            book_id INTEGER NOT NULL,
            page_number INTEGER NOT NULL,
            title TEXT NOT NULL,
            created_at INTEGER DEFAULT (strftime('%s', 'now')),
            FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
        )"
    ).execute(&*pool).await?;

    // Create default group
    sqlx::query(
        "INSERT OR IGNORE INTO groups (id, name, book_count) VALUES (1, '默认分组', 0)"
    ).execute(&*pool).await?;

    Ok(())
}

#[tauri::command]
pub async fn add_book(
    path: String,
    title: String,
    cover_image: Option<String>,
    total_pages: u32,
    db: DbState<'_>
) -> Result<Book, Error> {
    let pool = db.lock().await;
    
    let result = sqlx::query(
        "INSERT INTO books (title, file_path, cover_image, total_pages) VALUES (?, ?, ?, ?)"
    )
    .bind(&title)
    .bind(&path)
    .bind(&cover_image)
    .bind(total_pages as i64)
    .execute(&*pool).await?;

    let book_id = result.last_insert_rowid();
    
    let book = sqlx::query_as::<_, Book>(
        "SELECT * FROM books WHERE id = ?"
    )
    .bind(book_id)
    .fetch_one(&*pool).await?;

    Ok(book)
}

#[tauri::command]
pub async fn get_all_books(db: DbState<'_>) -> Result<Vec<Book>, Error> {
    let pool = db.lock().await;
    
    let books = sqlx::query_as::<_, Book>(
        "SELECT * FROM books ORDER BY last_read_time DESC NULLS LAST, created_at DESC"
    )
    .fetch_all(&*pool).await?;
    
    Ok(books)
}

#[tauri::command]
pub async fn get_recent_books(limit: u32, db: DbState<'_>) -> Result<Vec<Book>, Error> {
    let pool = db.lock().await;
    
    let books = sqlx::query_as::<_, Book>(
        "SELECT * FROM books WHERE last_read_time IS NOT NULL ORDER BY last_read_time DESC LIMIT ?"
    )
    .bind(limit as i64)
    .fetch_all(&*pool).await?;
    
    Ok(books)
}

#[tauri::command]
pub async fn update_book_progress(
    id: i64,
    current_page: u32,
    db: DbState<'_>
) -> Result<(), Error> {
    let pool = db.lock().await;
    
    sqlx::query(
        "UPDATE books SET current_page = ?, last_read_time = strftime('%s', 'now') WHERE id = ?"
    )
    .bind(current_page as i64)
    .bind(id)
    .execute(&*pool).await?;
    
    Ok(())
}

#[tauri::command]
pub async fn delete_book(id: i64, db: DbState<'_>) -> Result<(), Error> {
    let pool = db.lock().await;
    
    sqlx::query("DELETE FROM books WHERE id = ?")
        .bind(id)
        .execute(&*pool).await?;
    Ok(())
}

#[tauri::command]
pub async fn add_group(name: String, db: DbState<'_>) -> Result<Group, Error> {
    let pool = db.lock().await;
    
    let result = sqlx::query(
        "INSERT INTO groups (name) VALUES (?)"
    )
    .bind(&name)
    .execute(&*pool).await?;

    let group_id = result.last_insert_rowid();
    
    let group = sqlx::query_as::<_, Group>(
        "SELECT * FROM groups WHERE id = ?"
    )
    .bind(group_id)
    .fetch_one(&*pool).await?;

    Ok(group)
}

#[tauri::command]
pub async fn get_all_groups(db: DbState<'_>) -> Result<Vec<Group>, Error> {
    let pool = db.lock().await;
    
    let groups = sqlx::query_as::<_, Group>(
        "SELECT * FROM groups ORDER BY name"
    )
    .fetch_all(&*pool).await?;
    
    Ok(groups)
}

#[tauri::command]
pub async fn get_books_by_group(group_id: i64, db: DbState<'_>) -> Result<Vec<Book>, Error> {
    let pool = db.lock().await;
    
    let books = sqlx::query_as::<_, Book>(
        "SELECT * FROM books WHERE group_id = ? ORDER BY title"
    )
    .bind(group_id)
    .fetch_all(&*pool).await?;
    
    Ok(books)
}

#[tauri::command]
pub async fn move_book_to_group(
    book_id: i64,
    group_id: Option<i64>,
    db: DbState<'_>
) -> Result<(), Error> {
    let pool = db.lock().await;
    
    sqlx::query(
        "UPDATE books SET group_id = ? WHERE id = ?"
    )
    .bind(group_id)
    .bind(book_id)
    .execute(&*pool).await?;
    
    Ok(())
}

#[tauri::command]
pub async fn add_bookmark(
    book_id: i64,
    page_number: u32,
    title: String,
    db: DbState<'_>
) -> Result<Bookmark, Error> {
    let pool = db.lock().await;
    
    let result = sqlx::query(
        "INSERT INTO bookmarks (book_id, page_number, title) VALUES (?, ?, ?)"
    )
    .bind(book_id)
    .bind(page_number as i64)
    .bind(&title)
    .execute(&*pool).await?;

    let bookmark_id = result.last_insert_rowid();
    
    let bookmark = sqlx::query_as::<_, Bookmark>(
        "SELECT * FROM bookmarks WHERE id = ?"
    )
    .bind(bookmark_id)
    .fetch_one(&*pool).await?;

    Ok(bookmark)
}

#[tauri::command]
pub async fn get_bookmarks(book_id: i64, db: DbState<'_>) -> Result<Vec<Bookmark>, Error> {
    let pool = db.lock().await;
    
    let bookmarks = sqlx::query_as::<_, Bookmark>(
        "SELECT * FROM bookmarks WHERE book_id = ? ORDER BY page_number"
    )
    .bind(book_id)
    .fetch_all(&*pool).await?;
    
    Ok(bookmarks)
}

#[tauri::command]
pub async fn delete_bookmark(id: i64, db: DbState<'_>) -> Result<(), Error> {
    let pool = db.lock().await;
    
    sqlx::query("DELETE FROM bookmarks WHERE id = ?")
        .bind(id)
        .execute(&*pool).await?;
    Ok(())
}
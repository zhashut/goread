use crate::models::{Book, Bookmark, Group};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{Emitter, Manager, State};
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

    // Migrations: add missing column if database already existed
    // SQLite does not support IF NOT EXISTS for ADD COLUMN; ignore error if column exists
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

    // 尝试插入，如果已存在则查询已有记录
    let result = sqlx::query(
        "INSERT OR IGNORE INTO books (title, file_path, cover_image, total_pages) VALUES (?, ?, ?, ?)"
    )
    .bind(&title)
    .bind(&path)
    .bind(&cover_image)
    .bind(total_pages as i64)
    .execute(&*pool).await?;

    let book = if result.rows_affected() == 0 {
        // 已存在，直接按路径查询
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
        "SELECT * FROM books WHERE last_read_time IS NOT NULL ORDER BY last_read_time DESC LIMIT ?",
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

// 标记书籍已被打开（不依赖进度变化）
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
    // fetch current group id before deleting
    let old_group: Option<i64> = sqlx::query_scalar("SELECT group_id FROM books WHERE id = ?")
        .bind(id)
        .fetch_one(&*pool)
        .await?;

    sqlx::query("DELETE FROM books WHERE id = ?")
        .bind(id)
        .execute(&*pool)
        .await?;

    // update old group book_count and delete it if empty
    if let Some(gid) = old_group {
        // recompute count for robustness
        sqlx::query(
            "UPDATE groups SET book_count = (SELECT COUNT(*) FROM books WHERE group_id = ?) WHERE id = ?"
        )
        .bind(gid)
        .bind(gid)
        .execute(&*pool).await?;
        // delete group if it has no books
        sqlx::query("DELETE FROM groups WHERE id = ? AND book_count = 0")
            .bind(gid)
            .execute(&*pool)
            .await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn add_group(name: String, db: DbState<'_>) -> Result<Group, Error> {
    let pool = db.lock().await;

    let result = sqlx::query("INSERT INTO groups (name) VALUES (?)")
        .bind(&name)
        .execute(&*pool)
        .await?;

    let group_id = result.last_insert_rowid();

    let group = sqlx::query_as::<_, Group>("SELECT * FROM groups WHERE id = ?")
        .bind(group_id)
        .fetch_one(&*pool)
        .await?;

    Ok(group)
}

#[tauri::command]
pub async fn get_all_groups(db: DbState<'_>) -> Result<Vec<Group>, Error> {
    let pool = db.lock().await;

    let groups = sqlx::query_as::<_, Group>(
        // 过滤空分组：仅返回至少包含一本书的分组
        "SELECT * FROM groups WHERE book_count > 0 ORDER BY name",
    )
    .fetch_all(&*pool)
    .await?;

    Ok(groups)
}

// 删除分组以及分组内的所有书籍；可选同时删除本地源文件（Android/iOS/桌面）
#[tauri::command]
pub async fn delete_group(group_id: i64, delete_local: bool, db: DbState<'_>) -> Result<(), Error> {
    let pool = db.lock().await;

    // 如果需要删除本地文件，先查询路径并尝试删除
    if delete_local {
        let paths: Vec<(String,)> =
            sqlx::query_as("SELECT file_path FROM books WHERE group_id = ?")
                .bind(group_id)
                .fetch_all(&*pool)
                .await?;

        for (p,) in paths {
            // 忽略删除失败以保证整体流程不被中断（可能文件不存在或权限不足）
            let _ = tokio::fs::remove_file(&p).await;
        }
    }

    // 使用事务保证数据库一致性
    let mut tx = (&*pool).begin().await?;
    // 删除该分组内的书籍（书签表有 ON DELETE CASCADE）
    sqlx::query("DELETE FROM books WHERE group_id = ?")
        .bind(group_id)
        .execute(&mut *tx)
        .await?;
    // 删除分组本身
    sqlx::query("DELETE FROM groups WHERE id = ?")
        .bind(group_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

#[tauri::command]
pub async fn get_books_by_group(group_id: i64, db: DbState<'_>) -> Result<Vec<Book>, Error> {
    let pool = db.lock().await;

    let books = sqlx::query_as::<_, Book>(
        // 排序：有自定义顺序的优先按 position_in_group，其余按导入时间倒序
        "SELECT * FROM books WHERE group_id = ? ORDER BY position_in_group IS NULL, position_in_group ASC, created_at DESC"
    )
    .bind(group_id)
    .fetch_all(&*pool).await?;

    Ok(books)
}

#[tauri::command]
pub async fn move_book_to_group(
    book_id: i64,
    group_id: Option<i64>,
    db: DbState<'_>,
) -> Result<(), Error> {
    let pool = db.lock().await;
    // find previous group assignment
    let prev_group: Option<i64> = sqlx::query_scalar("SELECT group_id FROM books WHERE id = ?")
        .bind(book_id)
        .fetch_one(&*pool)
        .await?;

    if let Some(gid) = group_id {
        // place at end within the group
        let max_pos: Option<i64> =
            sqlx::query_scalar("SELECT MAX(position_in_group) FROM books WHERE group_id = ?")
                .bind(gid)
                .fetch_one(&*pool)
                .await?;
        let next_pos = max_pos.unwrap_or(0) + 1;
        sqlx::query("UPDATE books SET group_id = ?, position_in_group = ? WHERE id = ?")
            .bind(gid)
            .bind(next_pos)
            .bind(book_id)
            .execute(&*pool)
            .await?;
    } else {
        // removing from group clears position
        sqlx::query("UPDATE books SET group_id = NULL, position_in_group = NULL WHERE id = ?")
            .bind(book_id)
            .execute(&*pool)
            .await?;
    }
    // update counts for affected groups
    if let Some(pg) = prev_group {
        sqlx::query(
            "UPDATE groups SET book_count = (SELECT COUNT(*) FROM books WHERE group_id = ?) WHERE id = ?"
        )
        .bind(pg)
        .bind(pg)
        .execute(&*pool).await?;
        sqlx::query("DELETE FROM groups WHERE id = ? AND book_count = 0")
            .bind(pg)
            .execute(&*pool)
            .await?;
    }
    if let Some(ng) = group_id {
        sqlx::query(
            "UPDATE groups SET book_count = (SELECT COUNT(*) FROM books WHERE group_id = ?) WHERE id = ?"
        )
        .bind(ng)
        .bind(ng)
        .execute(&*pool).await?;
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
pub async fn reorder_group_books(
    group_id: i64,
    ordered_ids: Vec<i64>,
    db: DbState<'_>,
) -> Result<(), Error> {
    let pool = db.lock().await;
    // Use transaction to ensure atomic updates
    let mut tx = (&*pool).begin().await?;
    for (idx, bid) in ordered_ids.iter().enumerate() {
        // Only update books within the group
        sqlx::query("UPDATE books SET position_in_group = ? WHERE id = ? AND group_id = ?")
            .bind((idx as i64) + 1)
            .bind(bid)
            .bind(group_id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

#[tauri::command]
pub async fn add_bookmark(
    book_id: i64,
    page_number: u32,
    title: String,
    db: DbState<'_>,
) -> Result<Bookmark, Error> {
    let pool = db.lock().await;

    let result =
        sqlx::query("INSERT INTO bookmarks (book_id, page_number, title) VALUES (?, ?, ?)")
            .bind(book_id)
            .bind(page_number as i64)
            .bind(&title)
            .execute(&*pool)
            .await?;

    let bookmark_id = result.last_insert_rowid();

    let bookmark = sqlx::query_as::<_, Bookmark>("SELECT * FROM bookmarks WHERE id = ?")
        .bind(bookmark_id)
        .fetch_one(&*pool)
        .await?;

    Ok(bookmark)
}

#[tauri::command]
pub async fn get_bookmarks(book_id: i64, db: DbState<'_>) -> Result<Vec<Bookmark>, Error> {
    let pool = db.lock().await;

    let bookmarks = sqlx::query_as::<_, Bookmark>(
        "SELECT * FROM bookmarks WHERE book_id = ? ORDER BY page_number",
    )
    .bind(book_id)
    .fetch_all(&*pool)
    .await?;

    Ok(bookmarks)
}

#[tauri::command]
pub async fn delete_bookmark(id: i64, db: DbState<'_>) -> Result<(), Error> {
    let pool = db.lock().await;

    sqlx::query("DELETE FROM bookmarks WHERE id = ?")
        .bind(id)
        .execute(&*pool)
        .await?;
    Ok(())
}

// 文件系统相关命令

#[derive(Debug, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    #[serde(rename = "type")]
    pub entry_type: String, // "file" or "dir"
    pub size: Option<u64>,
    pub mtime: Option<i64>,
    pub children_count: Option<u32>,
}

// 递归扫描 PDF 文件（使用迭代方式避免递归 async 函数的问题）
async fn scan_pdf_files_recursive(
    dir: &Path,
    results: &mut Vec<FileEntry>,
    scanned_count: &mut u32,
    app_handle: Option<&tauri::AppHandle>,
    cancel_flag: &Arc<AtomicBool>,
) -> std::io::Result<()> {
    use std::collections::VecDeque;

    let mut dirs_to_scan = VecDeque::new();
    dirs_to_scan.push_back(dir.to_path_buf());
    let mut last_emit_time = std::time::Instant::now();

    while let Some(current_dir) = dirs_to_scan.pop_front() {
        if cancel_flag.load(Ordering::Relaxed) {
            break;
        }
        if !current_dir.is_dir() {
            continue;
        }

        let mut entries = match tokio::fs::read_dir(&current_dir).await {
            Ok(entries) => entries,
            Err(_) => continue, // 忽略权限错误
        };

        while let Some(entry) = entries.next_entry().await? {
            if cancel_flag.load(Ordering::Relaxed) {
                break;
            }
            let path = entry.path();

            // 更新扫描计数
            *scanned_count += 1;

            // 每100ms发送一次进度更新
            if let Some(app) = app_handle {
                let should_emit = last_emit_time.elapsed().as_millis() > 100;
                if should_emit {
                    let pdf_count = results.len() as u32;
                    let payload = serde_json::json!({
                        "scanned": *scanned_count,
                        "found": pdf_count
                    });
                    let _ = app.emit("goread:scan:progress", payload);
                    last_emit_time = std::time::Instant::now();
                }
            }

            let metadata = match entry.metadata().await {
                Ok(m) => m,
                Err(_) => continue,
            };

            if metadata.is_dir() {
                // 将子目录添加到待扫描队列
                dirs_to_scan.push_back(path);
            } else if metadata.is_file() {
                // 检查是否是 PDF 文件
                if let Some(ext) = path.extension() {
                    if ext.to_string_lossy().to_lowercase() == "pdf" {
                        let name = path
                            .file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or("")
                            .to_string();
                        let path_str = path.to_string_lossy().to_string();
                        let size = metadata.len();
                        let mtime = metadata
                            .modified()
                            .ok()
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_secs() as i64 * 1000);

                        results.push(FileEntry {
                            name,
                            path: path_str,
                            entry_type: "file".to_string(),
                            size: Some(size),
                            mtime,
                            children_count: None,
                        });

                        // 找到PDF时立即发送更新
                        if let Some(app) = app_handle {
                            let pdf_count = results.len() as u32;
                            let _ = app.emit(
                                "goread:scan:progress",
                                serde_json::json!({
                                    "scanned": *scanned_count as u32,
                                    "found": pdf_count
                                }),
                            );
                        }
                    }
                }
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn scan_pdf_files(
    root_path: Option<String>,
    window: tauri::Window,
    cancel_flag: State<'_, Arc<AtomicBool>>,
) -> Result<Vec<FileEntry>, String> {
    let root = if let Some(path) = root_path {
        PathBuf::from(path)
    } else {
        // 根据平台选择根路径
        #[cfg(target_os = "android")]
        let root = PathBuf::from("/storage/emulated/0");

        #[cfg(target_os = "ios")]
        let root = PathBuf::from("/private/var/mobile");

        #[cfg(target_os = "windows")]
        let root = PathBuf::from("C:\\");

        #[cfg(not(any(target_os = "android", target_os = "ios", target_os = "windows")))]
        let root = PathBuf::from("/");

        root
    };

    let app_handle = window.app_handle();
    cancel_flag.store(false, Ordering::SeqCst);
    let mut results = Vec::new();
    let mut scanned_count = 0u32;

    scan_pdf_files_recursive(
        &root,
        &mut results,
        &mut scanned_count,
        Some(&app_handle),
        &cancel_flag,
    )
    .await
    .map_err(|e| format!("扫描失败: {}", e))?;

    // 发送最终结果
    let _ = app_handle.emit(
        "goread:scan:progress",
        serde_json::json!({
            "scanned": scanned_count as u32,
            "found": results.len() as u32
        }),
    );

    Ok(results)
}

#[tauri::command]
pub async fn cancel_scan(cancel_flag: State<'_, Arc<AtomicBool>>) -> Result<(), String> {
    cancel_flag.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub async fn list_directory(path: String) -> Result<Vec<FileEntry>, String> {
    let dir_path = PathBuf::from(&path);

    if !dir_path.is_dir() {
        return Err(format!("路径不是目录: {}", path));
    }

    let mut entries = tokio::fs::read_dir(&dir_path)
        .await
        .map_err(|e| format!("读取目录失败: {}", e))?;

    let mut results = Vec::new();

    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|e| format!("读取目录项失败: {}", e))?
    {
        let path = entry.path();
        let metadata = entry
            .metadata()
            .await
            .map_err(|e| format!("获取文件信息失败: {}", e))?;

        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        let path_str = path.to_string_lossy().to_string();
        let entry_type = if metadata.is_dir() { "dir" } else { "file" }.to_string();

        let size = if metadata.is_file() {
            Some(metadata.len())
        } else {
            None
        };

        let mtime = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64 * 1000);

        let children_count = if metadata.is_dir() {
            // 计算子项数量（仅目录和 PDF 文件）
            match count_directory_children(&path).await {
                Ok(count) => Some(count),
                Err(_) => None,
            }
        } else {
            None
        };

        // 只返回目录和 PDF 文件
        if entry_type == "dir" || (entry_type == "file" && is_pdf_file(&path)) {
            results.push(FileEntry {
                name,
                path: path_str,
                entry_type,
                size,
                mtime,
                children_count,
            });
        }
    }

    // 排序：目录在前，然后按名称排序
    results.sort_by(
        |a, b| match (a.entry_type.as_str(), b.entry_type.as_str()) {
            ("dir", "file") => std::cmp::Ordering::Less,
            ("file", "dir") => std::cmp::Ordering::Greater,
            _ => a.name.cmp(&b.name),
        },
    );

    Ok(results)
}

async fn count_directory_children(dir: &Path) -> std::io::Result<u32> {
    let mut count = 0u32;
    let mut entries = tokio::fs::read_dir(dir).await?;

    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        let metadata = entry.metadata().await?;

        if metadata.is_dir() {
            count += 1;
        } else if metadata.is_file() && is_pdf_file(&path) {
            count += 1;
        }
    }

    Ok(count)
}

fn is_pdf_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_lowercase() == "pdf")
        .unwrap_or(false)
}

#[tauri::command]
pub async fn get_root_directories() -> Result<Vec<FileEntry>, String> {
    #[cfg(target_os = "android")]
    let roots = vec![
        PathBuf::from("/storage/emulated/0"),
        PathBuf::from("/sdcard"),
    ];

    #[cfg(target_os = "ios")]
    let roots = vec![PathBuf::from("/private/var/mobile/Documents")];

    #[cfg(target_os = "windows")]
    let roots = {
        let mut roots = Vec::new();
        // Windows 驱动器
        for drive in b'A'..=b'Z' {
            let drive_path = format!("{}:\\", drive as char);
            let path = PathBuf::from(&drive_path);
            if path.exists() {
                roots.push(path);
            }
        }
        roots
    };

    #[cfg(not(any(target_os = "android", target_os = "ios", target_os = "windows")))]
    let roots = vec![PathBuf::from("/")];

    let mut results = Vec::new();

    for root in roots {
        if root.exists() && root.is_dir() {
            let name = root
                .file_name()
                .and_then(|n| n.to_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| root.to_string_lossy().to_string());
            let path_str = root.to_string_lossy().to_string();

            let children_count = count_directory_children(&root).await.ok();

            results.push(FileEntry {
                name,
                path: path_str,
                entry_type: "dir".to_string(),
                size: None,
                mtime: None,
                children_count,
            });
        }
    }

    Ok(results)
}

// 权限检查（移动端需要）
#[tauri::command]
pub async fn check_storage_permission() -> Result<bool, String> {
    // 在移动端，这里应该调用平台特定的权限检查 API
    // 目前返回 true，实际实现需要根据平台调用相应 API
    #[cfg(target_os = "android")]
    {
        // TODO: 实现 Android 权限检查
        Ok(true)
    }

    #[cfg(target_os = "ios")]
    {
        // TODO: 实现 iOS 权限检查
        Ok(true)
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        // Windows/其他平台不需要权限检查
        Ok(true)
    }
}

#[tauri::command]
pub async fn request_storage_permission() -> Result<bool, String> {
    // 在移动端，这里应该调用平台特定的权限请求 API
    #[cfg(target_os = "android")]
    {
        // TODO: 实现 Android 权限请求
        Ok(true)
    }

    #[cfg(target_os = "ios")]
    {
        // TODO: 实现 iOS 权限请求
        Ok(true)
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        // Windows/其他平台不需要权限请求
        Ok(true)
    }
}

// 读取文件内容（用于导入时读取PDF文件）
#[tauri::command]
pub async fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    let file_path = PathBuf::from(&path);

    if !file_path.exists() {
        return Err(format!("文件不存在: {}", path));
    }

    if !file_path.is_file() {
        return Err(format!("路径不是文件: {}", path));
    }

    tokio::fs::read(&file_path)
        .await
        .map_err(|e| format!("读取文件失败: {}", e))
}

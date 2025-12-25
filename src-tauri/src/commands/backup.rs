use crate::commands::book::DbState;
use crate::models::{Book, Bookmark, Group, ReadingSession};
use chrono::{Local, Utc};
use serde_json::{json, Value};
use sqlx::SqlitePool;
use std::path::Path;
use tauri::{AppHandle, Manager};

async fn load_tables(
    pool: &SqlitePool,
) -> Result<(Vec<Book>, Vec<Group>, Vec<Bookmark>, Vec<ReadingSession>), String> {
    let books: Vec<Book> = sqlx::query_as::<_, Book>("SELECT * FROM books ORDER BY id")
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;
    let groups: Vec<Group> = sqlx::query_as::<_, Group>("SELECT * FROM groups ORDER BY id")
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;
    let bookmarks: Vec<Bookmark> =
        sqlx::query_as::<_, Bookmark>("SELECT * FROM bookmarks ORDER BY id")
            .fetch_all(pool)
            .await
            .map_err(|e| e.to_string())?;
    let sessions: Vec<ReadingSession> =
        sqlx::query_as::<_, ReadingSession>("SELECT * FROM reading_sessions ORDER BY id")
            .fetch_all(pool)
            .await
            .map_err(|e| e.to_string())?;

    Ok((books, groups, bookmarks, sessions))
}

fn build_backup_json(
    books: Vec<Book>,
    groups: Vec<Group>,
    bookmarks: Vec<Bookmark>,
    sessions: Vec<ReadingSession>,
    reader_settings: Option<Value>,
) -> Value {
    let platform = std::env::consts::OS.to_string();
    let now = Utc::now().to_rfc3339();
    let os = std::env::consts::OS.to_string();

    json!({
        "version": 1,
        "app": {
            "name": "GoRead",
            "platform": platform,
            "createdAt": now,
        },
        "device": {
            "os": os,
            "osVersion": Value::Null,
            "model": Value::Null,
        },
        "data": {
            "settings": {
                "reader_settings_v1": reader_settings.unwrap_or(Value::Null),
            },
            "db": {
                "tables": {
                    "books": books,
                    "groups": groups,
                    "bookmarks": bookmarks,
                    "reading_sessions": sessions,
                }
            }
        }
    })
}

async fn write_backup_file(path: &str, content: &Value) -> Result<(), String> {
    let p = Path::new(path);

    if let Some(parent) = p.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("创建备份目录失败: {}", e))?;
    }

    let json_str = serde_json::to_string_pretty(content).map_err(|e| e.to_string())?;
    tokio::fs::write(p, json_str)
        .await
        .map_err(|e| format!("写入备份文件失败: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn export_app_data(reader_settings: Value, db: DbState<'_>) -> Result<String, String> {
    let pool_guard = db.lock().await;
    let pool = &*pool_guard;

    let (books, groups, bookmarks, sessions) = load_tables(pool).await?;
    let backup = build_backup_json(books, groups, bookmarks, sessions, Some(reader_settings));
    serde_json::to_string_pretty(&backup).map_err(|e| e.to_string())
}

async fn auto_backup_before_import(
    app_handle: &AppHandle,
    pool: &SqlitePool,
) -> Result<Option<String>, String> {
    let base_dir = app_handle
        .path()
        .document_dir()
        .map_err(|e| e.to_string())?
        .join("GoReadBackups");

    tokio::fs::create_dir_all(&base_dir)
        .await
        .map_err(|e| format!("创建自动备份目录失败: {}", e))?;

    let timestamp = Local::now().format("%Y%m%d-%H%M%S").to_string();
    let file_name = format!(
        "goread-autobackup-before-import-{}.goread-backup",
        timestamp
    );
    let backup_path = base_dir.join(file_name);

    let (books, groups, bookmarks, sessions) = load_tables(pool).await?;
    let backup = build_backup_json(books, groups, bookmarks, sessions, None);

    let path_str = backup_path
        .to_str()
        .ok_or_else(|| "自动备份路径无效".to_string())?
        .to_string();
    write_backup_file(&path_str, &backup).await?;

    Ok(Some(path_str))
}

#[tauri::command]
pub async fn import_app_data(
    app_handle: AppHandle,
    backup_content: String,
    db: DbState<'_>,
) -> Result<Value, String> {
    let pool_guard = db.lock().await;
    let pool = &*pool_guard;

    auto_backup_before_import(&app_handle, pool).await.ok();

    let root: Value =
        serde_json::from_str(&backup_content).map_err(|e| format!("解析备份文件失败: {}", e))?;

    let version = root
        .get("version")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| "备份文件缺少版本号".to_string())?;
    if version != 1 {
        return Err(format!("不支持的备份版本: {}", version));
    }

    let app_name = root
        .get("app")
        .and_then(|a| a.get("name"))
        .and_then(|n| n.as_str())
        .unwrap_or_default()
        .to_string();
    if app_name != "GoRead" {
        return Err("备份文件不是 GoRead 生成的备份".to_string());
    }

    let data = root
        .get("data")
        .ok_or_else(|| "备份文件缺少 data 字段".to_string())?;
    let db_tables = data
        .get("db")
        .and_then(|d| d.get("tables"))
        .ok_or_else(|| "备份文件缺少数据表信息".to_string())?;

    let books_val = db_tables
        .get("books")
        .cloned()
        .unwrap_or_else(|| Value::Array(vec![]));
    let groups_val = db_tables
        .get("groups")
        .cloned()
        .unwrap_or_else(|| Value::Array(vec![]));
    let bookmarks_val = db_tables
        .get("bookmarks")
        .cloned()
        .unwrap_or_else(|| Value::Array(vec![]));
    let sessions_val = db_tables
        .get("reading_sessions")
        .cloned()
        .unwrap_or_else(|| Value::Array(vec![]));

    let books: Vec<Book> =
        serde_json::from_value(books_val).map_err(|e| format!("解析 books 表失败: {}", e))?;
    let groups: Vec<Group> =
        serde_json::from_value(groups_val).map_err(|e| format!("解析 groups 表失败: {}", e))?;
    let bookmarks: Vec<Bookmark> = serde_json::from_value(bookmarks_val)
        .map_err(|e| format!("解析 bookmarks 表失败: {}", e))?;
    let sessions: Vec<ReadingSession> = serde_json::from_value(sessions_val)
        .map_err(|e| format!("解析 reading_sessions 表失败: {}", e))?;

    let mut tx = pool
        .begin()
        .await
        .map_err(|e| format!("开始事务失败: {}", e))?;

    sqlx::query("DELETE FROM bookmarks")
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("清空 bookmarks 表失败: {}", e))?;
    sqlx::query("DELETE FROM reading_sessions")
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("清空 reading_sessions 表失败: {}", e))?;
    sqlx::query("DELETE FROM books")
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("清空 books 表失败: {}", e))?;
    sqlx::query("DELETE FROM groups")
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("清空 groups 表失败: {}", e))?;

    for group in groups {
        if let Some(id) = group.id {
            sqlx::query(
                "INSERT INTO groups (id, name, book_count, created_at) VALUES (?, ?, ?, ?)",
            )
            .bind(id)
            .bind(group.name)
            .bind(group.book_count as i64)
            .bind(group.created_at)
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("恢复 groups 表失败: {}", e))?;
        } else {
            sqlx::query("INSERT INTO groups (name, book_count, created_at) VALUES (?, ?, ?)")
                .bind(group.name)
                .bind(group.book_count as i64)
                .bind(group.created_at)
                .execute(&mut *tx)
                .await
                .map_err(|e| format!("恢复 groups 表失败: {}", e))?;
        }
    }

    for book in books {
        if let Some(id) = book.id {
            sqlx::query(
                "INSERT INTO books (id, title, file_path, cover_image, current_page, total_pages, last_read_time, group_id, position_in_group, created_at, status, finished_at, recent_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(id)
            .bind(book.title)
            .bind(book.file_path)
            .bind(book.cover_image)
            .bind(book.current_page as i64)
            .bind(book.total_pages as i64)
            .bind(book.last_read_time)
            .bind(book.group_id)
            .bind(book.position_in_group)
            .bind(book.created_at)
            .bind(book.status.unwrap_or(0))
            .bind(book.finished_at)
            .bind(book.recent_order)
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("恢复 books 表失败: {}", e))?;
        } else {
            sqlx::query(
                "INSERT INTO books (title, file_path, cover_image, current_page, total_pages, last_read_time, group_id, position_in_group, created_at, status, finished_at, recent_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(book.title)
            .bind(book.file_path)
            .bind(book.cover_image)
            .bind(book.current_page as i64)
            .bind(book.total_pages as i64)
            .bind(book.last_read_time)
            .bind(book.group_id)
            .bind(book.position_in_group)
            .bind(book.created_at)
            .bind(book.status.unwrap_or(0))
            .bind(book.finished_at)
            .bind(book.recent_order)
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("恢复 books 表失败: {}", e))?;
        }
    }

    for bookmark in bookmarks {
        if let Some(id) = bookmark.id {
            sqlx::query(
                "INSERT INTO bookmarks (id, book_id, page_number, title, created_at) VALUES (?, ?, ?, ?, ?)",
            )
            .bind(id)
            .bind(bookmark.book_id)
            .bind(bookmark.page_number as i64)
            .bind(bookmark.title)
            .bind(bookmark.created_at)
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("恢复 bookmarks 表失败: {}", e))?;
        } else {
            sqlx::query(
                "INSERT INTO bookmarks (book_id, page_number, title, created_at) VALUES (?, ?, ?, ?)",
            )
            .bind(bookmark.book_id)
            .bind(bookmark.page_number as i64)
            .bind(bookmark.title)
            .bind(bookmark.created_at)
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("恢复 bookmarks 表失败: {}", e))?;
        }
    }

    for session in sessions {
        if let Some(id) = session.id {
            sqlx::query(
                "INSERT INTO reading_sessions (id, book_id, start_time, duration, read_date, pages_read_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(id)
            .bind(session.book_id)
            .bind(session.start_time)
            .bind(session.duration)
            .bind(session.read_date)
            .bind(session.pages_read_count)
            .bind(session.created_at)
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("恢复 reading_sessions 表失败: {}", e))?;
        } else {
            sqlx::query(
                "INSERT INTO reading_sessions (book_id, start_time, duration, read_date, pages_read_count, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            )
            .bind(session.book_id)
            .bind(session.start_time)
            .bind(session.duration)
            .bind(session.read_date)
            .bind(session.pages_read_count)
            .bind(session.created_at)
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("恢复 reading_sessions 表失败: {}", e))?;
        }
    }

    tx.commit()
        .await
        .map_err(|e| format!("提交事务失败: {}", e))?;

    let settings_value = data
        .get("settings")
        .and_then(|s| s.get("reader_settings_v1"))
        .cloned()
        .unwrap_or(Value::Null);

    Ok(settings_value)
}

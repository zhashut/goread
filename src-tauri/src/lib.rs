mod commands;
mod models;

use commands::*;
use sqlx::SqlitePool;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode};
use std::str::FromStr;
use std::sync::Arc;
use tokio::sync::Mutex;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // 设置数据库连接
            tauri::async_runtime::block_on(async {
                let app_data_dir = app.path().app_data_dir().unwrap();
                std::fs::create_dir_all(&app_data_dir).unwrap();
                let db_path = app_data_dir.join("goread.db");
                // sqlx 对 SQLite 推荐使用 sqlite:// 前缀，并使用正斜杠路径格式
                let db_path_str = db_path.to_string_lossy().replace('\\', "/");
                let database_url = format!("sqlite://{}?mode=rwc", db_path_str);
                let opts = SqliteConnectOptions::from_str(&database_url)
                    .unwrap()
                    .journal_mode(SqliteJournalMode::Wal)
                    .create_if_missing(true);
                let pool = SqlitePool::connect_with(opts).await.unwrap();
                
                // 存储数据库连接池
                app.manage(Arc::new(Mutex::new(pool)));
            });
            
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            init_database,
            add_book,
            get_all_books,
            get_recent_books,
            update_book_progress,
            delete_book,
            add_group,
            get_all_groups,
            get_books_by_group,
            move_book_to_group,
            reorder_group_books,
            add_bookmark,
            get_bookmarks,
            delete_bookmark
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

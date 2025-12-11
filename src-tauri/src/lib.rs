mod commands;
mod formats;
mod markdown_commands;
mod models;
mod pdf;
mod pdf_commands;
mod html_commands;

// 导入所有命令
use commands::{
    // book commands
    init_database, add_book, get_all_books, get_recent_books,
    update_book_progress, update_book_total_pages, mark_book_opened, clear_recent_read_record, delete_book, update_books_last_read_time,
    // group commands
    add_group, get_all_groups, delete_group, get_books_by_group, update_group,
    move_book_to_group, reorder_group_books,
    // bookmark commands
    add_bookmark, get_bookmarks, delete_bookmark,
    // filesystem commands
    scan_pdf_files, scan_book_files, cancel_scan, list_directory, list_directory_supported, get_root_directories,
    check_storage_permission, request_storage_permission, read_file_bytes,
    save_image_to_gallery,
    // import commands
    batch_read_files, batch_import_books, batch_get_pdf_info, frontend_log,
};
use markdown_commands::*;
use pdf_commands::*;
use html_commands::*;
use sqlx::SqlitePool;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode};
use std::str::FromStr;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use tokio::sync::Mutex;
use tauri::Manager;

#[tauri::command]
fn exit_app() {
    std::process::exit(0);
}

// Status bar control commands (placeholder for iOS)
// Note: On Android, status bar control is handled via JavascriptInterface in MainActivity.kt
// These commands are kept as fallback for iOS which may need native implementation
#[tauri::command]
async fn show_status_bar() -> Result<(), String> {
    // Android uses StatusBarBridge JavascriptInterface, iOS would need native implementation
    Ok(())
}

#[tauri::command]
async fn hide_status_bar() -> Result<(), String> {
    // Android uses StatusBarBridge JavascriptInterface, iOS would need native implementation
    Ok(())
}

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
                
                app.manage(Arc::new(Mutex::new(pool)));
                app.manage(Arc::new(AtomicBool::new(false)));
                
                // 初始化PDF管理器
                app.manage(init_pdf_manager());
                
                if let Ok(res_dir) = app.path().resource_dir() {
                    #[cfg(target_os = "windows")] let sub = "pdfium/windows";
                    #[cfg(target_os = "linux")] let sub = "pdfium/linux";
                    #[cfg(target_os = "macos")] let sub = "pdfium/macos";
                    #[cfg(target_os = "android")] let sub = "pdfium/android";
                    #[cfg(target_os = "ios")] let sub = "pdfium/ios";
                    let full = res_dir.join(sub);
                    let p = full.to_string_lossy().replace('\\', "/");
                    unsafe {
                        std::env::set_var("PDFIUM_LIB_DIR", p);
                    }
                }
            });
            
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            init_database,
            add_book,
            get_all_books,
            get_recent_books,
            update_book_progress,
            update_book_total_pages,
            mark_book_opened,
            clear_recent_read_record,
            delete_book,
            update_books_last_read_time,
            add_group,
            get_all_groups,
            update_group,
            delete_group,
            get_books_by_group,
            move_book_to_group,
            reorder_group_books,
            update_group,
            add_bookmark,
            get_bookmarks,
            delete_bookmark,
            scan_pdf_files,
            scan_book_files,
            cancel_scan,
            list_directory,
            list_directory_supported,
            get_root_directories,
            check_storage_permission,
            request_storage_permission,
            read_file_bytes,
            save_image_to_gallery,
            // 批量导入优化命令
            batch_read_files,
            batch_import_books,
            batch_get_pdf_info,
            frontend_log,
            // PDF相关命令
            pdf_load_document,
            pdf_render_page,
            pdf_render_page_to_file,
            pdf_render_page_tile,
            pdf_render_page_base64,
            pdf_get_page_text,
            pdf_search_text,
            pdf_get_document_info,
            pdf_get_outline,
            pdf_preload_pages,
            pdf_clear_cache,
            pdf_close_document,
            pdf_get_cache_stats,
            pdf_warmup_cache,
            pdf_get_performance_metrics,
            pdf_get_performance_report,
            // 并行渲染命令
            pdf_render_pages_parallel,
            pdf_render_page_range_parallel,
            pdf_render_pages_with_threads,
            exit_app,
            // Markdown commands
            markdown_load_document,
            markdown_get_content,
            markdown_get_toc,
            markdown_search_text,
            // HTML commands
            html_load_document,
            // Status bar control commands
            show_status_bar,
            hide_status_bar
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

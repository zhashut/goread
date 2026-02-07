mod commands;
pub(crate) mod cover;
mod epub_commands;
mod formats;
mod html_commands;
mod markdown_commands;
mod models;
mod pdf;
mod pdf_commands;
mod txt_commands;
mod mobi_commands;

// 导入所有命令
use commands::{
    add_book,
    // bookmark commands
    add_bookmark,
    // cover commands
    clear_book_cover,
    get_books_needing_cover_rebuild,
    get_epub_books_without_cover,
    get_mobi_books_without_cover,
    get_cover_root_path,
    get_cover_url,
    migrate_book_cover,
    rebuild_pdf_cover,
    rebuild_epub_cover,
    rebuild_mobi_cover,
    // group commands
    add_group,
    batch_get_pdf_info,
    batch_import_books,
    // import commands
    batch_read_files,
    cancel_scan,
    check_storage_permission,
    clear_recent_read_record,
    delete_book,
    delete_bookmark,
    delete_group,
    // backup commands
    export_app_data,
    frontend_log,
    get_all_books,
    get_all_groups,
    get_bookmarks,
    get_books_by_date_range,
    get_books_by_group,
    get_daily_stats,
    get_day_stats_by_hour,
    get_reading_stats_by_range,
    get_recent_books,
    get_root_directories,
    get_stats_summary,
    has_reading_sessions,
    import_app_data,
    // book commands
    init_database,
    list_directory,
    list_directory_supported,
    mark_book_finished,
    mark_book_opened,
    move_book_to_group,
    read_file_bytes,
    reorder_group_books,
    reorder_groups,
    reorder_recent_books,
    reset_all_book_themes,
    request_storage_permission,
    save_image_to_gallery,
    // stats commands
    save_reading_session,
    scan_book_files,
    // filesystem commands
    scan_pdf_files,
    unmark_book_finished,
    update_book_progress,
    update_book_reading_mode,
    update_book_theme,
    update_book_total_pages,
    update_book_hide_divider,
    update_books_last_read_time,
    update_group,
    read_file_base64,
    read_file_chunked,
    get_file_stats
};
use epub_commands::*;
use html_commands::*;
use markdown_commands::*;
use pdf_commands::*;
use txt_commands::*;
use mobi_commands::*;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode};
use sqlx::SqlitePool;
use std::str::FromStr;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tauri::Manager;
use tokio::sync::Mutex;

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

                // 初始化EPUB缓存管理器
                app.manage(epub_commands::EpubCacheState::new(Mutex::new(
                    formats::epub::EpubCacheManager::new(),
                )));
                // 初始化MOBI缓存管理器
                app.manage(mobi_commands::MobiCacheState::new(Mutex::new(
                    formats::mobi::cache::MobiCacheManager::new(),
                )));

                if let Ok(res_dir) = app.path().resource_dir() {
                    #[cfg(target_os = "windows")]
                    let sub = "pdfium/windows";
                    #[cfg(target_os = "linux")]
                    let sub = "pdfium/linux";
                    #[cfg(target_os = "macos")]
                    let sub = "pdfium/macos";
                    #[cfg(target_os = "android")]
                    let sub = "pdfium/android";
                    #[cfg(target_os = "ios")]
                    let sub = "pdfium/ios";
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
            update_book_reading_mode,
            update_book_theme,
            update_book_total_pages,
            update_book_hide_divider,
            mark_book_opened,
            clear_recent_read_record,
            delete_book,
            update_books_last_read_time,
            reorder_recent_books,
            reset_all_book_themes,
            add_group,
            get_all_groups,
            update_group,
            delete_group,
            get_books_by_group,
            move_book_to_group,
            reorder_group_books,
            reorder_groups,
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
            read_file_base64,
            read_file_chunked,
            get_file_stats,
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
            pdf_set_cache_expiry,
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
            // TXT commands
            txt_load_document,
            // Status bar control commands
            show_status_bar,
            hide_status_bar,
            // Stats commands
            save_reading_session,
            get_stats_summary,
            get_daily_stats,
            get_reading_stats_by_range,
            get_day_stats_by_hour,
            get_books_by_date_range,
            mark_book_finished,
            unmark_book_finished,
            has_reading_sessions,
            // Backup commands
            export_app_data,
            import_app_data,
            // EPUB cache commands
            epub_save_section,
            epub_load_section,
            epub_save_resource,
            epub_load_resource,
            epub_set_cache_expiry,
            epub_clear_book_cache,
            epub_cleanup_expired,
            epub_get_cache_stats,
            epub_save_metadata,
            epub_load_metadata,
            // Cover commands
            get_cover_url,
            migrate_book_cover,
            get_cover_root_path,
            get_books_needing_cover_rebuild,
            get_epub_books_without_cover,
            get_mobi_books_without_cover,
            rebuild_pdf_cover,
            rebuild_epub_cover,
            rebuild_mobi_cover,
            clear_book_cover,
            // MOBI cache commands
            mobi_save_section,
            mobi_load_section,
            mobi_save_resource,
            mobi_load_resource,
            mobi_set_cache_expiry,
            mobi_clear_book_cache,
            mobi_cleanup_expired,
            mobi_get_cache_stats,
            mobi_save_metadata,
            mobi_load_metadata,
            epub_inspect,
            epub_prepare_book
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

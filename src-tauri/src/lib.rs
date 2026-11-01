mod commands;
pub(crate) mod cover;
mod epub_commands;
mod formats;
mod html_commands;
mod markdown_commands;
mod models;
mod pdf_commands;
mod tts;
mod tts_commands;
mod txt_commands;
mod mobi_commands;
mod wifi_transfer;

// 导入所有命令
use wifi_transfer::{wifi_list_uploads, wifi_stage_to_library, wifi_transfer_start, wifi_transfer_status, wifi_transfer_stop};
use commands::webdav::{nas_cache_clear, nas_cache_stats, nas_open_remote, webdav_download, webdav_list};
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
    find_group_by_name,
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
    rename_book,
    reorder_group_books,
    reorder_groups,
    reorder_recent_books,
    reset_all_book_themes,
    request_storage_permission,
    // stats commands
    save_reading_session,
    scan_book_files,
    // filesystem commands
    scan_pdf_files,
    unmark_book_finished,
    update_book_progress,
    update_book_reading_mode,
    update_book_page_turn_effect,
    update_book_theme,
    update_book_total_pages,
    update_book_font_size,
    update_book_hide_divider,
    update_book_toc_sort,
    update_books_last_read_time,
    update_group,
    read_file_base64,
    read_file_chunked,
    get_file_stats,
    fs_quick_fingerprint
};
use epub_commands::*;
use html_commands::*;
use markdown_commands::*;
use pdf_commands::*;
use txt_commands::{txt_load_document, txt_load_metadata, txt_load_chapter, txt_clear_metadata_cache, txt_get_cache_stats};
use tts_commands::tts_get_segments;
use mobi_commands::*;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode};
use sqlx::SqlitePool;
use std::str::FromStr;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_native_tts::NativeTtsExt;
use tauri_plugin_ios_bridge::IosBridgeExt;
use tokio::sync::Mutex;
use tts::session_manager::ManagedTtsSessionState;

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

#[tauri::command]
async fn native_tts_init<R: Runtime>(
    app: AppHandle<R>,
    payload: tauri_plugin_native_tts::InitArgs,
) -> Result<tauri_plugin_native_tts::InitResponse, String> {
    app.native_tts().init(payload).map_err(|e| e.to_string())
}

#[tauri::command]
async fn native_tts_set_rate<R: Runtime>(
    app: AppHandle<R>,
    payload: tauri_plugin_native_tts::SetRateArgs,
) -> Result<(), String> {
    app.native_tts().set_rate(payload).map_err(|e| e.to_string())
}

#[tauri::command]
async fn native_tts_set_voice<R: Runtime>(
    app: AppHandle<R>,
    payload: tauri_plugin_native_tts::SetVoiceArgs,
) -> Result<(), String> {
    app.native_tts().set_voice(payload).map_err(|e| e.to_string())
}

#[tauri::command]
async fn native_tts_set_media_session_active<R: Runtime>(
    app: AppHandle<R>,
    payload: tauri_plugin_native_tts::SetMediaSessionActiveRequest,
) -> Result<(), String> {
    app.native_tts()
        .set_media_session_active(payload)
        .map_err(|e| e.to_string())
}

/// 同步朗读播放状态到 Android 前台服务媒体通知（由前端 TTSSession 回写）
#[tauri::command]
async fn native_tts_set_playback_state<R: Runtime>(
    app: AppHandle<R>,
    payload: tauri_plugin_native_tts::SetPlaybackStateRequest,
) -> Result<(), String> {
    app.native_tts()
        .set_playback_state(payload)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn native_tts_shutdown<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    app.native_tts().shutdown().map_err(|e| e.to_string())
}

#[tauri::command]
async fn native_tts_session_start<R: Runtime>(
    app: AppHandle<R>,
    payload: tauri_plugin_native_tts::TTSSessionStartRequest,
) -> Result<(), String> {
    app.native_tts()
        .tts_session_start(payload)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn native_tts_session_push<R: Runtime>(
    app: AppHandle<R>,
    payload: tauri_plugin_native_tts::TTSSessionPushRequest,
) -> Result<(), String> {
    app.native_tts()
        .tts_session_push(payload)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn native_tts_session_stop<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    app.native_tts()
        .tts_session_stop()
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn native_tts_session_pause<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    app.native_tts()
        .tts_session_pause()
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn native_tts_session_resume<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    app.native_tts()
        .tts_session_resume()
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn native_tts_session_set_rate<R: Runtime>(
    app: AppHandle<R>,
    payload: tauri_plugin_native_tts::SetRateArgs,
) -> Result<(), String> {
    app.native_tts()
        .tts_session_set_rate(payload)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn native_tts_session_set_voice<R: Runtime>(
    app: AppHandle<R>,
    payload: tauri_plugin_native_tts::SetVoiceArgs,
) -> Result<(), String> {
    app.native_tts()
        .tts_session_set_voice(payload)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn native_tts_session_set_end_of_book<R: Runtime>(
    app: AppHandle<R>,
    payload: tauri_plugin_native_tts::TTSSessionSetEndOfBookRequest,
) -> Result<(), String> {
    app.native_tts()
        .tts_session_set_end_of_book(payload)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn tts_managed_session_start<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, Arc<ManagedTtsSessionState>>,
    payload: tts::types::TtsManagedSessionStartRequest,
) -> Result<(), String> {
    state.inner().start(app, payload).await
}

#[tauri::command]
async fn tts_managed_session_stop<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, Arc<ManagedTtsSessionState>>,
) -> Result<(), String> {
    state.inner().stop(app).await
}

#[tauri::command]
async fn tts_managed_session_pause<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, Arc<ManagedTtsSessionState>>,
) -> Result<(), String> {
    state.inner().pause(app).await
}

#[tauri::command]
async fn tts_managed_session_resume<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, Arc<ManagedTtsSessionState>>,
) -> Result<(), String> {
    state.inner().resume(app).await
}

#[tauri::command]
async fn tts_managed_session_set_rate<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, Arc<ManagedTtsSessionState>>,
    payload: tts::types::TtsManagedSessionSetRateRequest,
) -> Result<(), String> {
    state.inner().set_rate(app, payload).await
}

#[tauri::command]
async fn tts_managed_session_set_voice<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, Arc<ManagedTtsSessionState>>,
    payload: tts::types::TtsManagedSessionSetVoiceRequest,
) -> Result<(), String> {
    state.inner().set_voice(app, payload).await
}

#[tauri::command]
async fn tts_managed_session_status(
    state: tauri::State<'_, Arc<ManagedTtsSessionState>>,
) -> Result<tts::types::TtsManagedSessionStatus, String> {
    Ok(state.inner().status().await)
}

/// iOS 平台全局 panic 钩子：把 panic 消息、触发位置、线程名与完整调用栈
/// 写入沙盒 Documents/panic.log（追加模式）并经 NSLog 输出到系统日志。
/// 背景：iOS 无 stderr，且 tauri setup 内 panic 后 unwind 会穿过 extern "C"
/// 的 ObjC 委托边界触发 nounwind abort，.ips 崩溃日志中原始 panic 帧被销毁，
/// 只有依赖本钩子才能拿到首次 panic 的消息与位置。
/// 钩子内部禁止再 panic，所有 IO 失败均静默忽略。
#[cfg(target_os = "ios")]
fn install_ios_panic_hook() {
    use std::io::Write;

    extern "C" {
        /// NSLog（Foundation）：向系统日志输出一条记录，第一参数为 NSString。
        fn NSLog(message: *const std::ffi::c_void, ...);
        /// CFStringCreateWithCString（CoreFoundation）：由 C 字符串构造 CFString。
        fn CFStringCreateWithCString(
            alloc: *const std::ffi::c_void,
            c_str: *const std::ffi::c_char,
            encoding: u32,
        ) -> *mut std::ffi::c_void;
    }
    const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;

    // 安装时写入启动分隔行，便于在 panic.log 中区分多次启动。
    let boot_ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Ok(home) = std::env::var("HOME") {
        let dir = format!("{home}/Documents");
        if std::fs::create_dir_all(&dir).is_ok() {
            if let Ok(mut f) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(format!("{dir}/panic.log"))
            {
                let _ = writeln!(f, "=== panic hook installed, boot={boot_ts} ===");
            }
        }
    }

    std::panic::set_hook(Box::new(move |info| {
        let thread_name = std::thread::current()
            .name()
            .unwrap_or("<unnamed>")
            .to_string();
        let message = if let Some(s) = info.payload().downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "<non-string panic payload>".to_string()
        };
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown>".to_string());
        let backtrace = std::backtrace::Backtrace::force_capture().to_string();
        let text = format!(
            "[PANIC] thread={thread_name} at {location}\nmessage: {message}\nbacktrace:\n{backtrace}\n"
        );

        // 1) 写沙盒文件：iOS 沙盒内 HOME 环境变量指向 app 容器根目录。
        if let Ok(home) = std::env::var("HOME") {
            let dir = format!("{home}/Documents");
            if std::fs::create_dir_all(&dir).is_ok() {
                if let Ok(mut f) = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(format!("{dir}/panic.log"))
                {
                    let _ = f.write_all(text.as_bytes());
                }
            }
        }

        // 2) NSLog 输出（% 需转义，避免被当作格式化占位符）。
        let escaped = text.replace('%', "%%");
        if let Ok(c) = std::ffi::CString::new(escaped) {
            unsafe {
                let ns = CFStringCreateWithCString(
                    std::ptr::null(),
                    c.as_ptr(),
                    K_CF_STRING_ENCODING_UTF8,
                );
                if !ns.is_null() {
                    NSLog(ns);
                }
            }
        }
    }));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // iOS：先装 panic 钩子再进入 tauri Builder，保证 setup/启动链 panic 可取证。
    #[cfg(target_os = "ios")]
    install_ios_panic_hook();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_native_tts::init())
        .plugin(tauri_plugin_ios_bridge::init())
        .setup(|app| {
            app.manage(Arc::new(ManagedTtsSessionState::new()));
            // 初始化 WiFi 传书状态（服务默认未启动）
            app.manage(wifi_transfer::WifiTransferState::new());
            // 设置数据库连接
            tauri::async_runtime::block_on(async {
                let app_data_dir = app
                    .path()
                    .app_data_dir()
                    .expect("setup: app_data_dir() failed");
                std::fs::create_dir_all(&app_data_dir)
                    .expect("setup: create_dir_all(app_data_dir) failed");
                let db_path = app_data_dir.join("goread.db");
                // sqlx 对 SQLite 推荐使用 sqlite:// 前缀，并使用正斜杠路径格式
                let db_path_str = db_path.to_string_lossy().replace('\\', "/");
                let database_url = format!("sqlite://{}?mode=rwc", db_path_str);
                let opts = SqliteConnectOptions::from_str(&database_url)
                    .expect("setup: SqliteConnectOptions::from_str failed")
                    .journal_mode(SqliteJournalMode::Wal)
                    .create_if_missing(true);
                let pool = SqlitePool::connect_with(opts)
                    .await
                    .expect("setup: SqlitePool::connect_with failed");

                app.manage(Arc::new(Mutex::new(pool)));
                app.manage(Arc::new(AtomicBool::new(false)));

                // 初始化PDF管理器
                app.manage(init_pdf_manager());

                #[cfg(target_os = "android")]
                {
                    if let Ok(app_cache_dir) = app.path().app_cache_dir() {
                        let cache_base = app_cache_dir.join("goread_cache");

                        let epub_cache_root = cache_base.join("epub");
                        let mobi_cache_root = cache_base.join("mobi");

                        let _ = std::fs::create_dir_all(&epub_cache_root);
                        let _ = std::fs::create_dir_all(&mobi_cache_root);
                        unsafe {
                            std::env::set_var("GOREAD_EPUB_CACHE_ROOT", epub_cache_root);
                            std::env::set_var("GOREAD_MOBI_CACHE_ROOT", mobi_cache_root);
                        }
                    }
                }

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
                    let sub = "pdf/pdfium/windows";
                    #[cfg(target_os = "linux")]
                    let sub = "pdf/pdfium/linux";
                    #[cfg(target_os = "macos")]
                    let sub = "pdf/pdfium/macos";
                    #[cfg(target_os = "android")]
                    let sub = "pdf/pdfium/android";
                    #[cfg(target_os = "ios")]
                    let sub = "pdf/pdfium/ios";
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
            update_book_page_turn_effect,
            update_book_theme,
            update_book_total_pages,
            update_book_font_size,
            update_book_hide_divider,
            update_book_toc_sort,
            mark_book_opened,
            clear_recent_read_record,
            delete_book,
            update_books_last_read_time,
            reorder_recent_books,
            reset_all_book_themes,
            rename_book,
            add_group,
            get_all_groups,
            find_group_by_name,
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
            // 批量导入优化命令
            batch_read_files,
            batch_import_books,
            batch_get_pdf_info,
            // WiFi 传书命令
            wifi_transfer_start,
            wifi_transfer_stop,
            wifi_transfer_status,
            wifi_stage_to_library,
            wifi_list_uploads,
            // NAS WebDAV 命令
            webdav_list,
            webdav_download,
            nas_open_remote,
            nas_cache_stats,
            nas_cache_clear,
            frontend_log,
            read_file_base64,
            read_file_chunked,
            get_file_stats,
            fs_quick_fingerprint,
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
            pdf_set_cache_max_size,
            pdf_warmup_cache,
            pdf_get_performance_metrics,
            pdf_get_performance_report,
            // 并行渲染命令
            pdf_render_pages_parallel,
            pdf_render_page_range_parallel,
            pdf_render_pages_with_threads,
            exit_app,
            // Markdown commands
            tts_managed_session_start,
            tts_managed_session_stop,
            tts_managed_session_pause,
            tts_managed_session_resume,
            tts_managed_session_set_rate,
            tts_managed_session_set_voice,
            tts_managed_session_status,
            markdown_load_document,
            markdown_get_content,
            markdown_get_toc,
            markdown_search_text,
            // HTML commands
            html_load_document,
            // TXT commands
            txt_load_document,
            txt_load_metadata,
            txt_load_chapter,
            txt_clear_metadata_cache,
            txt_get_cache_stats,
            // Status bar control commands
            show_status_bar,
            hide_status_bar,
            // Native TTS commands (avoid plugin invoke ACL)
            native_tts_init,
            native_tts_set_rate,
            native_tts_set_voice,
            native_tts_set_media_session_active,
            native_tts_set_playback_state,
            native_tts_shutdown,
            native_tts_session_start,
            native_tts_session_push,
            native_tts_session_stop,
            native_tts_session_pause,
            native_tts_session_resume,
            native_tts_session_set_rate,
            native_tts_session_set_voice,
            native_tts_session_set_end_of_book,
            // TTS 统一取片接口
            tts_get_segments,
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
            epub_set_cache_max_size,
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
            mobi_set_cache_max_size,
            mobi_clear_book_cache,
            mobi_cleanup_expired,
            mobi_get_cache_stats,
            mobi_save_metadata,
            mobi_load_metadata,
            mobi_prepare_book,
            epub_inspect,
            epub_prepare_book,
            epub_resolve_hidden_sections
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}


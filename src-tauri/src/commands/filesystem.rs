use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{Emitter, Manager, State};
use crate::formats;

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

/// Android 内部存储的真实路径
#[cfg(target_os = "android")]
const ANDROID_INTERNAL_STORAGE: &str = "/storage/emulated/0";

/// Android 内部存储的别名路径，均为 ANDROID_INTERNAL_STORAGE 的符号链接
#[cfg(target_os = "android")]
const ANDROID_INTERNAL_STORAGE_ALIASES: [&str; 2] = ["/sdcard", "/storage/self/primary"];

/// 将 Android 别名路径归一化为真实路径字符串（用于路径去重）
fn normalize_android_path(path: &Path) -> String {
    let s = path.to_string_lossy().to_string();
    #[cfg(target_os = "android")]
    {
        for alias in ANDROID_INTERNAL_STORAGE_ALIASES {
            // 别名根目录本身（例如 /sdcard）
            if s == alias {
                return ANDROID_INTERNAL_STORAGE.to_string();
            }
            // 别名下的子路径（例如 /sdcard/Download/a.pdf）
            let prefix = format!("{}/", alias);
            if let Some(rest) = s.strip_prefix(prefix.as_str()) {
                return format!("{}/{}", ANDROID_INTERNAL_STORAGE, rest);
            }
        }
    }
    s
}

/// 构建 Android 平台的存储根目录列表（内部存储 + 外置 SD 卡）
///
/// 注意：/sdcard 与 /storage/self/primary 都是 /storage/emulated/0 的符号链接，
/// 这里必须按真实路径去重，否则同一批文件会被完整扫描两次（扫描计数翻倍、耗时翻倍）。
#[cfg(target_os = "android")]
async fn android_storage_roots() -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    // 内部存储：根目录可读时只扫根目录，否则退化为常见公共目录
    let internal_root = PathBuf::from(ANDROID_INTERNAL_STORAGE);
    if internal_root.exists() && tokio::fs::read_dir(&internal_root).await.is_ok() {
        candidates.push(internal_root.clone());
    } else {
        candidates.push(internal_root.join("Download"));
        candidates.push(internal_root.join("Documents"));
        candidates.push(internal_root.join("Books"));
    }

    // 别名路径（/sdcard 等）作为兜底候选，由下面的去重逻辑消除重复
    candidates.push(PathBuf::from(ANDROID_INTERNAL_STORAGE_ALIASES[0]));

    // 外置 SD 卡：卷名形如 XXXX-XXXX
    let storage_base = PathBuf::from("/storage");
    if storage_base.exists() {
        if let Ok(mut entries) = tokio::fs::read_dir(&storage_base).await {
            while let Ok(Some(ent)) = entries.next_entry().await {
                let p = ent.path();
                if p.is_dir() {
                    if let Some(name) = p.file_name().and_then(|s| s.to_str()) {
                        if name.contains('-') {
                            candidates.push(p);
                        }
                    }
                }
            }
        }
    }

    // 去重：同时记录「归一化后的原路径」与「解析符号链接后的归一化路径」，
    // 任一命中即视为同一目录（如 /sdcard 与 /storage/emulated/0），
    // 已被收录根目录覆盖到的子目录也不再单独扫描，避免重复遍历
    let mut roots: Vec<PathBuf> = Vec::new();
    let mut covered_keys: Vec<String> = Vec::new();
    for candidate in candidates {
        if !candidate.exists() {
            continue;
        }
        let alias_key = normalize_android_path(&candidate);
        // canonicalize 失败时退化为原路径，保证仍能参与去重
        let real = tokio::fs::canonicalize(&candidate)
            .await
            .unwrap_or_else(|_| candidate.clone());
        let real_key = normalize_android_path(&real);
        let already_covered = covered_keys.iter().any(|key| {
            alias_key == *key
                || real_key == *key
                || alias_key.starts_with(&format!("{}/", key))
                || real_key.starts_with(&format!("{}/", key))
        });
        if already_covered {
            continue;
        }
        covered_keys.push(alias_key);
        covered_keys.push(real_key);
        roots.push(candidate);
    }

    // 打印最终扫描范围，便于真机（logcat）核对是否还有别名重复项
    println!("[android_storage_roots] 扫描根目录: {:?}", roots);

    roots
}

// 递归扫描 PDF 文件（使用迭代方式避免递归 async 函数的问题）
async fn scan_pdf_files_recursive(
    dir: &Path,
    results: &mut Vec<FileEntry>,
    scanned_count: &mut u32,
    app_handle: Option<&tauri::AppHandle>,
    cancel_flag: &Arc<AtomicBool>,
    seen_paths: &mut std::collections::HashSet<String>,
) -> std::io::Result<()> {
    use std::collections::VecDeque;

    let mut dirs_to_scan = VecDeque::new();
    dirs_to_scan.push_back(dir.to_path_buf());
    let mut last_emit_time = std::time::Instant::now();

    println!("Starting scan from: {}", dir.display());

    while let Some(current_dir) = dirs_to_scan.pop_front() {
        if cancel_flag.load(Ordering::Relaxed) {
            println!("Scan cancelled");
            break;
        }
        if !current_dir.is_dir() {
            continue;
        }

        let mut entries = match tokio::fs::read_dir(&current_dir).await {
            Ok(entries) => entries,
            Err(e) => {
                eprintln!("Failed to read directory {}: {}", current_dir.display(), e);
                continue; // 忽略权限错误
            }
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
                        let path_str = normalize_android_path(&path);
                        let size = metadata.len();
                        let mtime = metadata
                            .modified()
                            .ok()
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_secs() as i64 * 1000);

                        if seen_paths.insert(path_str.clone()) {
                            results.push(FileEntry {
                                name,
                                path: path_str,
                                entry_type: "file".to_string(),
                                size: Some(size),
                                mtime,
                                children_count: None,
                            });
                        }

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
    let app_handle = window.app_handle();
    let mut roots = Vec::new();

    if let Some(path) = root_path {
        roots.push(PathBuf::from(path));
    } else {
        // 根据平台选择根路径（Android 内部存储别名已去重，避免重复扫描）
        #[cfg(target_os = "android")]
        {
            roots = android_storage_roots().await;
        }

        #[cfg(target_os = "ios")]
        {
            if let Ok(doc_dir) = app_handle.path().document_dir() {
                roots.push(doc_dir);
            } else {
                roots.push(PathBuf::from("/private/var/mobile/Documents"));
            }
        }

        #[cfg(target_os = "windows")]
        {
            roots.push(PathBuf::from("C:\\"));
        }

        #[cfg(not(any(target_os = "android", target_os = "ios", target_os = "windows")))]
        {
            roots.push(PathBuf::from("/"));
        }
    };

    let app_handle = window.app_handle();
    cancel_flag.store(false, Ordering::SeqCst);
    let mut results = Vec::new();
    let mut scanned_count = 0u32;
    let mut seen_paths = std::collections::HashSet::new();

    for root in roots {
        if !root.exists() {
            continue;
        }
        // 忽略单个目录的错误，继续扫描其他目录
        let _ = scan_pdf_files_recursive(
            &root,
            &mut results,
            &mut scanned_count,
            Some(&app_handle),
            &cancel_flag,
            &mut seen_paths,
        )
        .await;
    }

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
    println!("list_directory called with path: {}", path);
    let dir_path = PathBuf::from(&path);

    if !dir_path.exists() {
        let err_msg = format!("路径不存在: {}", path);
        eprintln!("{}", err_msg);
        return Err(err_msg);
    }

    if !dir_path.is_dir() {
        let err_msg = format!("路径不是目录: {}", path);
        eprintln!("{}", err_msg);
        return Err(err_msg);
    }

    let mut entries = tokio::fs::read_dir(&dir_path)
        .await
        .map_err(|e| {
            let err_msg = format!("读取目录失败: {} (错误: {})", path, e);
            eprintln!("{}", err_msg);
            err_msg
        })?;

    let mut results = Vec::new();
    let mut total_entries = 0;
    let mut pdf_count = 0;

    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|e| format!("读取目录项失败: {}", e))?
    {
        total_entries += 1;
        let path = entry.path();
        let metadata = match entry.metadata().await {
            Ok(m) => m,
            Err(e) => {
                eprintln!("获取文件信息失败 ({}): {}", path.display(), e);
                continue;
            }
        };

        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        // Android 别名路径统一归一化，避免同一物理文件出现两种路径（重复导入 / 已导入标记失效）
        let path_str = normalize_android_path(&path);
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
            match count_directory_children(&path).await {
                Ok(count) => Some(count),
                Err(_) => None,
            }
        } else {
            None
        };

        // 只返回目录和 PDF 文件
        if entry_type == "dir" || (entry_type == "file" && is_pdf_file(&path)) {
            if entry_type == "file" {
                pdf_count += 1;
                println!("Found PDF: {}", name);
            }
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

    println!("list_directory: 总共 {} 个条目, {} 个 PDF 文件, 返回 {} 个结果", 
             total_entries, pdf_count, results.len());

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

fn is_supported_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| formats::is_scan_supported_extension(ext))
        .unwrap_or(false)
}

async fn count_directory_children_supported(dir: &Path) -> std::io::Result<u32> {
    let mut count = 0u32;
    let mut entries = tokio::fs::read_dir(dir).await?;

    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        let metadata = entry.metadata().await?;

        if metadata.is_dir() {
            count += 1;
        } else if metadata.is_file() && is_supported_file(&path) {
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
pub async fn get_root_directories(app_handle: tauri::AppHandle) -> Result<Vec<FileEntry>, String> {
    // Android：内部存储与别名（/sdcard 等）已按真实路径去重，避免重复展示与重复扫描
    #[cfg(target_os = "android")]
    let roots = android_storage_roots().await;

    #[cfg(target_os = "ios")]
    let roots = vec![app_handle.path().document_dir().unwrap_or_else(|_| PathBuf::from("/private/var/mobile/Documents"))];

    #[cfg(target_os = "windows")]
    let roots = {
        let mut roots = Vec::new();
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
            let path_str = normalize_android_path(&root);

            let children_count = count_directory_children_supported(&root).await.ok();

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

#[tauri::command]
pub async fn list_directory_supported(path: String) -> Result<Vec<FileEntry>, String> {
    println!("list_directory_supported called with path: {}", path);
    let dir_path = PathBuf::from(&path);

    if !dir_path.exists() {
        let err_msg = format!("路径不存在: {}", path);
        eprintln!("{}", err_msg);
        return Err(err_msg);
    }

    if !dir_path.is_dir() {
        let err_msg = format!("路径不是目录: {}", path);
        eprintln!("{}", err_msg);
        return Err(err_msg);
    }

    let mut entries = tokio::fs::read_dir(&dir_path)
        .await
        .map_err(|e| {
            let err_msg = format!("读取目录失败: {} (错误: {})", path, e);
            eprintln!("{}", err_msg);
            err_msg
        })?;

    let mut results = Vec::new();
    let mut total_entries = 0;
    let mut supported_count = 0;

    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|e| format!("读取目录项失败: {}", e))?
    {
        total_entries += 1;
        let path = entry.path();
        let metadata = match entry.metadata().await {
            Ok(m) => m,
            Err(e) => {
                eprintln!("获取文件信息失败 ({}): {}", path.display(), e);
                continue;
            }
        };

        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        // Android 别名路径统一归一化，避免同一物理文件出现两种路径（重复导入 / 已导入标记失效）
        let path_str = normalize_android_path(&path);
        let entry_type = if metadata.is_dir() { "dir" } else { "file" }.to_string();

        let size = if metadata.is_file() { Some(metadata.len()) } else { None };

        let mtime = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64 * 1000);

        let children_count = if metadata.is_dir() {
            match count_directory_children_supported(&path).await {
                Ok(count) => Some(count),
                Err(_) => None,
            }
        } else {
            None
        };

        if entry_type == "dir" || (entry_type == "file" && is_supported_file(&path)) {
            if entry_type == "file" {
                supported_count += 1;
                println!("Found supported file: {}", name);
            }
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

    println!(
        "list_directory_supported: 总共 {} 个条目, {} 个支持的文件, 返回 {} 个结果",
        total_entries, supported_count, results.len()
    );

    results.sort_by(
        |a, b| match (a.entry_type.as_str(), b.entry_type.as_str()) {
            ("dir", "file") => std::cmp::Ordering::Less,
            ("file", "dir") => std::cmp::Ordering::Greater,
            _ => a.name.cmp(&b.name),
        },
    );

    Ok(results)
}

/// 检查文件是否符合指定的格式筛选条件
fn is_file_in_formats(path: &Path, formats: &Option<Vec<formats::BookFormat>>) -> bool {
    let ext = path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_lowercase());
    
    let ext = match ext {
        Some(e) => e,
        None => return false,
    };

    let file_format = formats::BookFormat::from_extension(&ext);
    
    match (file_format, formats) {
        // 有格式且在筛选列表中
        (Some(fmt), Some(filter_formats)) => filter_formats.contains(&fmt),
        // 有格式但无筛选列表，使用默认的扫描支持格式
        (Some(fmt), None) => formats::is_scan_supported_format(&fmt),
        // 无法识别的格式
        _ => false,
    }
}

async fn scan_supported_files_recursive(
    dir: &Path,
    results: &mut Vec<FileEntry>,
    scanned_count: &mut u32,
    app_handle: Option<&tauri::AppHandle>,
    cancel_flag: &Arc<AtomicBool>,
    seen_paths: &mut std::collections::HashSet<String>,
    formats: &Option<Vec<formats::BookFormat>>,
) -> std::io::Result<()> {
    use std::collections::VecDeque;

    let mut dirs_to_scan = VecDeque::new();
    dirs_to_scan.push_back(dir.to_path_buf());
    let mut last_emit_time = std::time::Instant::now();

    while let Some(current_dir) = dirs_to_scan.pop_front() {
        if cancel_flag.load(Ordering::Relaxed) { break; }
        if !current_dir.is_dir() { continue; }

        let mut entries = match tokio::fs::read_dir(&current_dir).await {
            Ok(entries) => entries,
            Err(_) => continue,
        };

        while let Some(entry) = entries.next_entry().await? {
            if cancel_flag.load(Ordering::Relaxed) { break; }
            let path = entry.path();

            *scanned_count += 1;

            if let Some(app) = app_handle {
                let should_emit = last_emit_time.elapsed().as_millis() > 100;
                if should_emit {
                    let count = results.len() as u32;
                    let payload = serde_json::json!({
                        "scanned": *scanned_count,
                        "found": count
                    });
                    let _ = app.emit("goread:scan:progress", payload);
                    last_emit_time = std::time::Instant::now();
                }
            }

            let metadata = match entry.metadata().await { Ok(m) => m, Err(_) => continue };

            if metadata.is_dir() {
                dirs_to_scan.push_back(path);
            } else if metadata.is_file() {
                if is_file_in_formats(&path, formats) {
                    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
                    let path_str = normalize_android_path(&path);
                    let size = metadata.len();
                    let mtime = metadata.modified().ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs() as i64 * 1000);

                    if seen_paths.insert(path_str.clone()) {
                        results.push(FileEntry {
                            name,
                            path: path_str,
                            entry_type: "file".to_string(),
                            size: Some(size),
                            mtime,
                            children_count: None,
                        });
                    }

                    if let Some(app) = app_handle {
                        let count = results.len() as u32;
                        let _ = app.emit(
                            "goread:scan:progress",
                            serde_json::json!({
                                "scanned": *scanned_count as u32,
                                "found": count
                            }),
                        );
                    }
                }
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn scan_book_files(
    root_path: Option<String>,
    formats: Option<Vec<String>>,
    window: tauri::Window,
    cancel_flag: State<'_, Arc<AtomicBool>>,
) -> Result<Vec<FileEntry>, String> {
    let app_handle = window.app_handle();
    let mut roots = Vec::new();

    if let Some(path) = root_path { roots.push(PathBuf::from(path)); } else {
        #[cfg(target_os = "android")]
        {
            // 内部存储与别名（/sdcard 等）已按真实路径去重，避免重复扫描同一批文件
            roots = android_storage_roots().await;
        }
        #[cfg(target_os = "ios")]
        { roots.push(app_handle.path().document_dir().unwrap_or_else(|_| PathBuf::from("/private/var/mobile/Documents"))); }
        #[cfg(target_os = "windows")]
        { roots.push(PathBuf::from("C:\\")); }
        #[cfg(not(any(target_os = "android", target_os = "ios", target_os = "windows")))]
        { roots.push(PathBuf::from("/")); }
    };

    let app_handle = window.app_handle();
    cancel_flag.store(false, Ordering::SeqCst);
    let mut results = Vec::new();
    let mut scanned_count = 0u32;
    let mut seen_paths = std::collections::HashSet::new();

    // 将字符串格式转换为 BookFormat
    let format_filters: Option<Vec<formats::BookFormat>> = formats.map(|f| {
        f.iter()
            .filter_map(|s| match s.to_lowercase().as_str() {
                "pdf" => Some(formats::BookFormat::Pdf),
                "epub" => Some(formats::BookFormat::Epub),
                "markdown" => Some(formats::BookFormat::Markdown),
                "html" => Some(formats::BookFormat::Html),
                "txt" => Some(formats::BookFormat::Txt),
                "mobi" => Some(formats::BookFormat::Mobi),
                _ => None,
            })
            .collect()
    });

    for root in roots {
        if !root.exists() { continue; }
        let _ = scan_supported_files_recursive(&root, &mut results, &mut scanned_count, Some(&app_handle), &cancel_flag, &mut seen_paths, &format_filters).await;
    }

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
pub async fn check_storage_permission() -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        let mut test_paths: Vec<String> = vec![
            "/storage/emulated/0".to_string(),
            "/storage/emulated/0/Download".to_string(),
            "/storage/emulated/0/Documents".to_string(),
            "/sdcard".to_string(),
        ];
        let storage_base = std::path::Path::new("/storage");
        if storage_base.exists() {
            if let Ok(mut entries) = tokio::fs::read_dir(storage_base).await {
                while let Ok(Some(ent)) = entries.next_entry().await {
                    let p = ent.path();
                    if p.is_dir() {
                        if let Some(name) = p.file_name().and_then(|s| s.to_str()) {
                            if name.contains('-') {
                                test_paths.push(p.to_string_lossy().to_string());
                            }
                        }
                    }
                }
            }
        }
        for path_str in test_paths {
            let path = std::path::Path::new(&path_str);
            if path.exists() {
                match tokio::fs::read_dir(path).await {
                    Ok(_) => return Ok(true),
                    Err(e) => {
                        eprintln!("Failed to read {}: {}", path_str, e);
                        continue;
                    }
                }
            }
        }
        Ok(false)
    }

    #[cfg(target_os = "ios")]
    {
        Ok(true)
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        Ok(true)
    }
}

#[tauri::command]
pub async fn request_storage_permission() -> Result<bool, String> {
    // 在 Android 上，权限请求由 MainActivity 在启动时处理。
    // 这里我们再次检查权限状态。
    check_storage_permission().await
}

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

/// 获取文件状态信息
#[tauri::command]
pub async fn get_file_stats(path: String) -> Result<FileStats, String> {
    let file_path = PathBuf::from(&path);
    
    if !file_path.exists() {
        return Err(format!("文件不存在: {}", path));
    }
    
    let metadata = tokio::fs::metadata(&file_path)
        .await
        .map_err(|e| format!("获取文件信息失败: {}", e))?;
    
    Ok(FileStats {
        size: metadata.len(),
        is_file: metadata.is_file(),
        is_dir: metadata.is_dir(),
    })
}

#[derive(serde::Serialize)]
pub struct FileStats {
    pub size: u64,
    pub is_file: bool,
    pub is_dir: bool,
}

/// 轻量文件指纹返回结果
/// size：文件字节数
/// mtime_ms：最后修改时间（毫秒，UNIX 时间戳）
/// head_hash：文件首部最多 64KB 字节的 64 位 FNV-1a 哈希（十六进制）
#[derive(serde::Serialize)]
pub struct FileFingerprint {
    pub size: u64,
    pub mtime_ms: i64,
    pub head_hash: String,
}

/// 计算文件首部字节的 FNV-1a 64 位哈希
fn fnv1a_64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in bytes {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

/// 获取文件的轻量指纹
/// 只读取文件首部（最多 64KB）配合 size + mtime，足以在绝大多数场景下识别内容变化
/// 性能：50MB 文件耗时通常在 5ms 以内，远快于全文件 SHA-256
#[tauri::command]
pub async fn fs_quick_fingerprint(path: String) -> Result<FileFingerprint, String> {
    use tokio::io::AsyncReadExt;

    const HEAD_BYTES_LIMIT: usize = 64 * 1024;

    let file_path = PathBuf::from(&path);
    if !file_path.exists() {
        return Err(format!("文件不存在: {}", path));
    }

    let metadata = tokio::fs::metadata(&file_path)
        .await
        .map_err(|e| format!("获取文件信息失败: {}", e))?;

    let size = metadata.len();
    let mtime_ms = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    let read_len = std::cmp::min(size as usize, HEAD_BYTES_LIMIT);
    let mut head = vec![0u8; read_len];
    if read_len > 0 {
        let mut file = tokio::fs::File::open(&file_path)
            .await
            .map_err(|e| format!("打开文件失败: {}", e))?;
        file.read_exact(&mut head)
            .await
            .map_err(|e| format!("读取文件首部失败: {}", e))?;
    }

    let head_hash = format!("{:016x}", fnv1a_64(&head));

    Ok(FileFingerprint {
        size,
        mtime_ms,
        head_hash,
    })
}

/// 以 Base64 编码读取文件（优化内存占用）
/// 用于 EPUB 等大文件读取场景，避免 number[] 在 JS 中占用过多内存
#[tauri::command]
pub async fn read_file_base64(path: String) -> Result<String, String> {
    use base64::{Engine as _, engine::general_purpose};
    
    let file_path = PathBuf::from(&path);

    if !file_path.exists() {
        return Err(format!("文件不存在: {}", path));
    }

    if !file_path.is_file() {
        return Err(format!("路径不是文件: {}", path));
    }

    let bytes = tokio::fs::read(&file_path)
        .await
        .map_err(|e| format!("读取文件失败: {}", e))?;
    
    Ok(general_purpose::STANDARD.encode(&bytes))
}

/// 分块流式读取文件
/// 通过 Channel 分块发送 Base64 编码的数据，避免一次性加载整个文件
#[tauri::command]
pub async fn read_file_chunked(
    path: String,
    chunk_size: Option<usize>,
    on_chunk: tauri::ipc::Channel<String>,
) -> Result<u64, String> {
    use base64::{Engine as _, engine::general_purpose};
    use tokio::io::AsyncReadExt;
    
    let file_path = PathBuf::from(&path);
    
    if !file_path.exists() {
        return Err(format!("文件不存在: {}", path));
    }
    
    if !file_path.is_file() {
        return Err(format!("路径不是文件: {}", path));
    }
    
    let mut file = tokio::fs::File::open(&file_path)
        .await
        .map_err(|e| format!("打开文件失败: {}", e))?;
    
    // 默认 1MB 块大小
    let chunk_size = chunk_size.unwrap_or(1024 * 1024);
    let mut buffer = vec![0u8; chunk_size];
    let mut total_bytes: u64 = 0;
    
    loop {
        let bytes_read = file.read(&mut buffer)
            .await
            .map_err(|e| format!("读取文件失败: {}", e))?;
        
        if bytes_read == 0 {
            break;
        }
        
        total_bytes += bytes_read as u64;
        let base64_chunk = general_purpose::STANDARD.encode(&buffer[..bytes_read]);
        
        on_chunk.send(base64_chunk)
            .map_err(|e| format!("发送数据块失败: {}", e))?;
    }
    
    Ok(total_bytes)
}
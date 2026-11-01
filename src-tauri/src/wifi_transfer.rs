//! WiFi 传书：局域网 HTTP 上传服务
//!
//! 在本机启动 axum HTTP 服务（优先端口 8899，被占用时回退随机端口），
//! 同一局域网内的设备用浏览器打开 `http://<本机IP>:<端口>`，
//! 通过网页将书籍文件上传到应用数据目录 `wifi_uploads/`，
//! 并通过 `goread:wifi:received` 事件逐个通知前端复用现有导入分组流程。
//!
//! 网页端 UI 对齐「有度」电脑端上传页（http://192.168.2.14/ 同款
//! Bootstrap 3 风格）：page-header 标题、上传/创建分组/Refresh 按钮工具条、
//! 上传进度面板（File Uploads in Progress）、「导入到分组」下拉 + 条纹表格
//! 文件列表（图标/名称/大小/下载/删除）、创建分组弹窗、错误提示条。
//! 分组数据与本地书架同源：网页端建组直读书架 SQLite groups 表（事务保障），
//! 上传可选携带 group_id，事件透传后由 App 端静默导入对应分组。
//! 所需 CSS（bootstrap/theme/fileupload/index）与 Glyphicons 字体均内嵌本地提供。
//!
//! 安全说明：服务无鉴权，仅应在可信局域网内使用；服务随 WiFi 传书界面生命周期启停。
//! 所有文件管理接口均限制在上传目录内（含 `..` 的路径直接拒绝）。

use crate::models::Group;
use axum::{
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, Multipart, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use futures::stream;
use local_ip_address::list_afinet_netifas;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::net::{IpAddr, TcpListener};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{oneshot, Mutex};

/// 支持上传的书籍文件扩展名白名单（与前端 src/constants/fileTypes.ts 保持一致）
const SUPPORTED_EXTENSIONS: &[&str] = &[
    ".pdf", ".epub", ".md", ".markdown", ".html", ".htm", ".txt", ".mobi",
];

/// 单次上传请求体积上限（2GB，防止无限占用）
const MAX_BODY_BYTES: usize = 2 * 1024 * 1024 * 1024;

/// 优先尝试绑定的固定端口（被占用时回退随机端口）
const PREFERRED_PORT: u16 = 8899;

/// Windows 保留设备名（作为文件主名时不允许直接使用）
const WINDOWS_RESERVED_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6",
    "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6",
    "LPT7", "LPT8", "LPT9",
];

/// 收到的单个文件信息（事件 payload 与 HTTP 响应共用）
#[derive(Debug, Clone, Serialize)]
pub struct ReceivedFile {
    /// 原始文件名（已清洗）
    pub name: String,
    /// 保存后的绝对路径
    pub path: String,
    /// 文件大小（字节）
    pub size: u64,
    /// 目标分组 ID（网页端选择「导入到分组」时携带；None 表示不分组）
    pub group_id: Option<i64>,
}

/// 上传接口的 JSON 响应
#[derive(Debug, Serialize)]
struct UploadResponse {
    ok: bool,
    /// 已保存的文件列表
    saved: Vec<ReceivedFile>,
    /// 因扩展名不在白名单而跳过的文件名列表
    skipped: Vec<String>,
}

/// WiFi 传书服务信息（IPC 返回结构）
#[derive(Debug, Clone, Serialize)]
pub struct WifiServerInfo {
    /// 服务是否运行中
    pub running: bool,
    /// 监听端口（未运行时为 0）
    pub port: u16,
    /// 可访问的地址列表（http://<局域网IP>:<端口>）
    pub urls: Vec<String>,
}

/// 运行中的服务句柄
struct ServerHandle {
    port: u16,
    /// 优雅停机信号发送端
    shutdown: oneshot::Sender<()>,
}

/// WiFi 传书全局状态（由 lib.rs manage 托管）
pub struct WifiTransferState {
    server: Mutex<Option<ServerHandle>>,
}

impl WifiTransferState {
    /// 创建初始状态（服务未启动）
    ///
    /// 返回值：全新的 WifiTransferState 实例
    pub fn new() -> Self {
        Self {
            server: Mutex::new(None),
        }
    }
}

/// HTTP 服务上下文（Router State）
#[derive(Clone)]
struct ServerContext {
    app: AppHandle,
    upload_dir: PathBuf,
}

/// 启动 WiFi 传书服务（幂等：已在运行则直接返回当前信息）
///
/// 参数：app 应用句柄（用于数据目录定位）；state 全局状态
/// 返回值：当前服务信息（运行状态、端口、地址列表）；失败返回错误说明
#[tauri::command]
pub async fn wifi_transfer_start(
    app: AppHandle,
    state: tauri::State<'_, WifiTransferState>,
) -> Result<WifiServerInfo, String> {
    let mut guard = state.server.lock().await;
    // 幂等：已在运行直接返回
    if let Some(handle) = guard.as_ref() {
        return Ok(build_server_info(true, handle.port));
    }

    // 上传保存目录：应用数据目录/wifi_uploads
    let upload_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {}", e))?
        .join("wifi_uploads");
    tokio::fs::create_dir_all(&upload_dir)
        .await
        .map_err(|e| format!("创建上传目录失败: {}", e))?;

    // 绑定端口：优先 8899，被占用则回退系统分配的随机端口
    let std_listener = match TcpListener::bind(("0.0.0.0", PREFERRED_PORT)) {
        Ok(l) => l,
        Err(_) => TcpListener::bind(("0.0.0.0", 0))
            .map_err(|e| format!("绑定端口失败: {}", e))?,
    };
    std_listener
        .set_nonblocking(true)
        .map_err(|e| format!("设置监听非阻塞失败: {}", e))?;
    let listener = tokio::net::TcpListener::from_std(std_listener)
        .map_err(|e| format!("初始化异步监听失败: {}", e))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("获取监听端口失败: {}", e))?
        .port();

    // 构建路由：/ 上传页、/upload 上传接口、/fonts 内嵌字体、/download 下载、
    // /api/groups 分组列表、/api/groups/create 创建分组、/api/list 文件列表、/api/delete 删除
    let ctx = ServerContext {
        app: app.clone(),
        upload_dir,
    };
    let router = Router::new()
        .route("/", get(upload_page))
        .route("/upload", post(upload_handler))
        .route("/fonts/glyphicons-halflings-regular.woff", get(glyphicon_font))
        .route("/download", get(api_download))
        .route("/api/groups", get(api_list_groups))
        .route("/api/groups/create", post(api_create_group))
        .route("/api/list", get(api_list))
        .route("/api/delete", post(api_delete))
        .with_state(ctx)
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES));

    // 启动服务并持有优雅停机信号
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    tauri::async_runtime::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .await;
    });

    guard.replace(ServerHandle {
        port,
        shutdown: shutdown_tx,
    });
    Ok(build_server_info(true, port))
}

/// 停止 WiFi 传书服务
///
/// 参数：state 全局状态
/// 返回值：停止后的服务信息（running=false）
#[tauri::command]
pub async fn wifi_transfer_stop(
    state: tauri::State<'_, WifiTransferState>,
) -> Result<WifiServerInfo, String> {
    let mut guard = state.server.lock().await;
    if let Some(handle) = guard.take() {
        // 通知服务优雅退出
        let _ = handle.shutdown.send(());
    }
    Ok(WifiServerInfo {
        running: false,
        port: 0,
        urls: Vec::new(),
    })
}

/// 查询 WiFi 传书服务状态
///
/// 参数：state 全局状态
/// 返回值：当前服务信息
#[tauri::command]
pub async fn wifi_transfer_status(
    state: tauri::State<'_, WifiTransferState>,
) -> Result<WifiServerInfo, String> {
    let guard = state.server.lock().await;
    match guard.as_ref() {
        Some(handle) => Ok(build_server_info(true, handle.port)),
        None => Ok(WifiServerInfo {
            running: false,
            port: 0,
            urls: Vec::new(),
        }),
    }
}

/// WiFi 接收文件入库暂存结果
#[derive(Debug, Clone, Serialize)]
pub struct StagedFile {
    /// 原路径（wifi_uploads 内；非 wifi 文件时与 to 相同）
    pub from: String,
    /// 暂存后的新路径（app_data/library/ 内；未移动时与 from 相同）
    pub to: String,
}

/// 判断子路径是否位于父目录内部（Windows 大小写不敏感的组件级前缀比较）
///
/// 参数：child 子路径；parent 父目录
/// 返回值：child 严格位于 parent 内部时为 true
fn is_strictly_under(child: &Path, parent: &Path) -> bool {
    let cc = child.components().count();
    let pc = parent.components().count();
    if cc <= pc {
        return false;
    }
    child
        .components()
        .zip(parent.components())
        .all(|(c, p)| {
            c.as_os_str().to_string_lossy().to_lowercase()
                == p.as_os_str().to_string_lossy().to_lowercase()
        })
}

/// 将单个文件移动到书库目录 library/（文件名清洗 + 重名自动追加序号）
///
/// 参数：lib_dir 书库目录；src 源文件路径
/// 返回值：移动后的新路径；移动失败返回 io 错误
async fn move_into_library(lib_dir: &Path, src: &Path) -> std::io::Result<PathBuf> {
    let raw_name = src
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let safe_name = sanitize_filename(&raw_name);
    let target = unique_target(lib_dir, &safe_name).await;
    // 同一数据目录卷内重命名（原子移动）
    tokio::fs::rename(src, &target).await?;
    Ok(target)
}

/// 列出上传目录中滞留的待导入文件
///
/// App 重启后前端内存中的"待导入"列表会丢失，而上传目录中可能仍有
/// 未能自动入库的滞留文件（上传时应用未在导入页/移动失败降级等场景）。
/// 该命令在导入页挂载时调用，把这些文件重新暴露给手动导入流程。
///
/// 参数：app 应用句柄（定位应用数据目录）
/// 返回值：wifi_uploads 内全部常规文件（仅一层，不递归子目录）
#[tauri::command]
pub async fn wifi_list_uploads(app: AppHandle) -> Result<Vec<ReceivedFile>, String> {
    let upload_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {}", e))?
        .join("wifi_uploads");

    let mut out = Vec::new();
    let mut rd = match tokio::fs::read_dir(&upload_dir).await {
        Ok(rd) => rd,
        // 目录不存在视为无滞留文件
        Err(_) => return Ok(out),
    };
    while let Ok(entry) = rd.next_entry().await {
        let Some(entry) = entry else { break };
        let path = entry.path();
        // 仅列出常规文件（历史版本网页端创建的子目录不在此列）
        if !path.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let size = entry.metadata().await.map(|m| m.len()).unwrap_or(0);
        out.push(ReceivedFile {
            name,
            path: path.to_string_lossy().to_string(),
            size,
            group_id: None,
        });
    }
    Ok(out)
}

/// WiFi 接收文件入库暂存：把 wifi_uploads 内的文件移动到应用书库目录 library/
///
/// 用于导入确认时暂存仍留在上传目录中的历史接收文件（新上传已由服务端自动移入）。
/// 仅移动位于 wifi_uploads 内的常规文件，其余路径原样返回（不触碰用户其他文件）。
///
/// 参数：app 应用句柄（定位应用数据目录）；paths 待导入的文件路径列表
/// 返回值：原路径到新路径的映射列表；目录创建失败返回错误，单文件移动失败返回错误
#[tauri::command]
pub async fn wifi_stage_to_library(
    app: AppHandle,
    paths: Vec<String>,
) -> Result<Vec<StagedFile>, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {}", e))?;
    let wifi_dir = data_dir.join("wifi_uploads");
    let lib_dir = data_dir.join("library");
    tokio::fs::create_dir_all(&lib_dir)
        .await
        .map_err(|e| format!("创建书库目录失败: {}", e))?;

    let mut out = Vec::new();
    for p in paths {
        let src = PathBuf::from(&p);
        // 仅处理 wifi_uploads 内的常规文件；其余（扫描/浏览/NAS 来源）原样返回
        if !is_strictly_under(&src, &wifi_dir) || !src.is_file() {
            out.push(StagedFile { from: p.clone(), to: p });
            continue;
        }
        let target = move_into_library(&lib_dir, &src)
            .await
            .map_err(|e| format!("移动文件失败: {}", e))?;
        out.push(StagedFile {
            from: p,
            to: target.to_string_lossy().to_string(),
        });
    }
    Ok(out)
}

/// 构建服务信息：枚举本机局域网 IPv4 并拼出可访问地址列表
///
/// 参数：running 是否运行中；port 监听端口
/// 返回值：WifiServerInfo（未运行时 urls 为空；无法枚举时回退 127.0.0.1）
fn build_server_info(running: bool, port: u16) -> WifiServerInfo {
    let mut urls = Vec::new();
    if running {
        if let Ok(devs) = list_afinet_netifas() {
            let mut ips: Vec<std::net::Ipv4Addr> = devs
                .into_iter()
                .filter_map(|(_, ip)| match ip {
                    IpAddr::V4(v4) if !v4.is_loopback() => Some(v4),
                    _ => None,
                })
                .collect();
            // 排序：192.168.x.x 优先（家庭局域网最常见），其次 10.x、172.16~31、其他
            ips.sort_by_key(|ip| match ip.octets()[0] {
                192 => 0,
                10 => 1,
                172 => 2,
                _ => 3,
            });
            ips.dedup();
            urls.extend(ips.into_iter().map(|ip| format!("http://{}:{}", ip, port)));
        }
        if urls.is_empty() {
            urls.push(format!("http://127.0.0.1:{}", port));
        }
    }
    WifiServerInfo {
        running,
        port,
        urls,
    }
}

/// ===== 内嵌网页资源（1:1 对齐「有度」电脑端上传页 http://192.168.2.14/）===== ///
///
/// CSS 与字体均取自参考站原件随包内嵌（保留其原始版权头），
/// 页面骨架 page.html 与脚本 page.js 为按参考站结构/交互的本地移植实现。

/// 内嵌样式：Bootstrap 3 全量样式（按钮/面板/表格/弹窗/面包屑等）
const CSS_BOOTSTRAP: &str = include_str!("assets/wifi_web/bootstrap.css");
/// 内嵌样式：Bootstrap 3 主题（按钮渐变等增强）
const CSS_THEME: &str = include_str!("assets/wifi_web/bootstrap-theme.css");
/// 内嵌样式：jquery-fileupload 按钮内嵌 file input 的定位隐藏样式
const CSS_FILEUPLOAD: &str = include_str!("assets/wifi_web/jquery.fileupload.css");
/// 内嵌样式：参考站自定义覆盖样式（列宽/页脚/弹窗输入框/初始隐藏上传面板等）
const CSS_INDEX: &str = include_str!("assets/wifi_web/index.css");
/// 内嵌脚本：网页端交互逻辑（原生 JS 移植参考站 index.js 行为）
const PAGE_JS: &str = include_str!("assets/wifi_web/page.js");
/// 内嵌页面骨架（含 CSS/JS 占位符，启动后首次访问时组合）
const PAGE_TEMPLATE: &str = include_str!("assets/wifi_web/page.html");
/// 内嵌字体：Glyphicons 半量图标字体（参考站同款 woff）
const FONT_GLYPHICONS: &[u8] = include_bytes!("assets/wifi_web/glyphicons-halflings-regular.woff");

/// 组合后的上传页 HTML 缓存（仅组合一次）
static PAGE_HTML: OnceLock<String> = OnceLock::new();

/// 组合上传页 HTML：将内嵌 CSS/JS 注入页面骨架的占位符
///
/// 返回值：完整 HTML 字符串
fn compose_upload_page() -> String {
    PAGE_TEMPLATE
        .replace("/*__CSS_BOOTSTRAP__*/", CSS_BOOTSTRAP)
        .replace("/*__CSS_THEME__*/", CSS_THEME)
        .replace("/*__CSS_FILEUPLOAD__*/", CSS_FILEUPLOAD)
        .replace("/*__CSS_INDEX__*/", CSS_INDEX)
        .replace("//__PAGE_JS__", PAGE_JS)
}

/// 上传页（移动端友好的单页 HTML）
///
/// 返回值：内嵌 HTML 页面（首次访问时组合并缓存）
async fn upload_page() -> Html<&'static str> {
    Html(PAGE_HTML.get_or_init(compose_upload_page))
}

/// 返回内嵌的 Glyphicons 图标字体（供上传页图标渲染）
///
/// 返回值：woff 字体字节流（Content-Type: font/woff）
async fn glyphicon_font() -> Response {
    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("font/woff"));
    (headers, FONT_GLYPHICONS).into_response()
}

/// 下载上传目录内的文件（网页端列表下载按钮使用）
///
/// 参数：params 查询参数（path 为相对上传目录的文件路径）；ctx 服务上下文
/// 返回值：application/octet-stream 附件流响应（64KB 分块，避免大文件占内存）；
///         非法路径返回 403，目标不存在返回 404，文件夹返回 400
async fn api_download(
    Query(params): Query<HashMap<String, String>>,
    State(ctx): State<ServerContext>,
) -> Result<Response, (StatusCode, String)> {
    let rel = params.get("path").map(|s| s.as_str()).unwrap_or("");
    let target = resolve_in_upload_dir(&ctx.upload_dir, rel)?;
    let meta = tokio::fs::metadata(&target)
        .await
        .map_err(|_| (StatusCode::NOT_FOUND, "文件不存在".to_string()))?;
    if meta.is_dir() {
        return Err((StatusCode::BAD_REQUEST, "不支持下载文件夹".to_string()));
    }
    let file_name = target
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "download".to_string());
    let file = tokio::fs::File::open(&target)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("打开文件失败: {}", e)))?;

    // 分块流式读取，避免大文件整体载入内存
    let body_stream = stream::unfold(file, |mut file| async move {
        let mut buf = vec![0u8; 64 * 1024];
        match AsyncReadExt::read(&mut file, &mut buf).await {
            Ok(0) => None,
            Ok(n) => Some((
                Ok::<Bytes, std::io::Error>(Bytes::copy_from_slice(&buf[..n])),
                file,
            )),
            Err(e) => Some((Err(e), file)),
        }
    });

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::CONTENT_LENGTH, meta.len())
        .header(header::CONTENT_DISPOSITION, content_disposition(&file_name))
        .body(Body::from_stream(body_stream))
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("构建响应失败: {}", e)))
}

/// 构造 Content-Disposition 附件头（ASCII 回退名 + RFC 5987 UTF-8 编码名，支持中文文件名）
///
/// 参数：file_name 已清洗的文件名
/// 返回值：如 `attachment; filename="_.txt"; filename*=UTF-8''%E4%B8%AD.txt` 的头值
fn content_disposition(file_name: &str) -> String {
    // ASCII 回退名：非安全 ASCII 字符替换为下划线
    let ascii: String = file_name
        .chars()
        .map(|c| {
            if c.is_ascii() && !c.is_control() && c != '"' && c != '\\' {
                c
            } else {
                '_'
            }
        })
        .collect();
    // RFC 5987 percent-encoding：仅保留 unreserved 字符
    let mut encoded = String::new();
    for b in file_name.as_bytes() {
        let c = *b;
        let unreserved = c.is_ascii_alphanumeric() || matches!(c, b'-' | b'.' | b'_' | b'~');
        if unreserved {
            encoded.push(c as char);
        } else {
            encoded.push_str(&format!("%{:02X}", c));
        }
    }
    format!("attachment; filename=\"{}\"; filename*=UTF-8''{}", ascii, encoded)
}

/// 处理 multipart 文件上传：校验扩展名、清洗文件名、落盘并逐个推送事件。
/// 表单中可含 "group_id" 字段指定目标分组（先于文件字段发送；缺省/无效时不分组）。
///
/// 参数：ctx 服务上下文（应用句柄与上传目录）；multipart 请求体
/// 返回值：JSON 响应（已保存与已跳过列表）；请求格式错误返回 400，写入失败返回 500
async fn upload_handler(
    State(ctx): State<ServerContext>,
    mut multipart: Multipart,
) -> Result<Json<UploadResponse>, (StatusCode, String)> {
    let mut saved: Vec<ReceivedFile> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    // 目标分组：解析 group_id 字段并校验分组存在（缺省/失效回退不分组）
    let mut group_id: Option<i64> = None;
    // 全自动入库：接收文件落盘后立即移入应用书库目录 library/，wifi_uploads 不保留已接收文件
    let lib_dir = ctx
        .app
        .path()
        .app_data_dir()
        .map(|d| d.join("library"))
        .unwrap_or_else(|_| ctx.upload_dir.clone());
    if let Err(e) = tokio::fs::create_dir_all(&lib_dir).await {
        eprintln!("[wifi_transfer] 创建书库目录失败: {}", e);
    }

    while let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("解析上传数据失败: {}", e)))?
    {
        let field_name = field.name().unwrap_or("").to_string();

        // 目标分组字段：读取文本内容并校验分组在书架中存在
        if field_name == "group_id" {
            let raw = field
                .text()
                .await
                .map_err(|e| (StatusCode::BAD_REQUEST, format!("读取分组字段失败: {}", e)))?;
            group_id = resolve_wifi_group(&ctx.app, raw.trim().parse::<i64>().ok()).await;
            continue;
        }

        // 无文件名的字段（普通表单项）直接跳过
        let filename = match field.file_name() {
            Some(name) if !name.trim().is_empty() => name.trim().to_string(),
            _ => continue,
        };

        // 扩展名白名单校验
        let ext = file_extension(&filename);
        if !SUPPORTED_EXTENSIONS.contains(&ext.as_str()) {
            skipped.push(filename);
            continue;
        }

        // 落盘目录：上传根目录（服务启动时已创建，入库前暂存）
        tokio::fs::create_dir_all(&ctx.upload_dir)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("创建目录失败: {}", e)))?;

        // 清洗文件名并生成不重名的保存路径
        let safe_name = sanitize_filename(&filename);
        let target = unique_target(&ctx.upload_dir, &safe_name).await;

        // 流式写入磁盘，避免大文件占用内存
        let mut size: u64 = 0;
        let mut file = tokio::io::BufWriter::new(
            tokio::fs::File::create(&target)
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("创建文件失败: {}", e)))?,
        );
        while let Some(chunk) = field
            .chunk()
            .await
            .map_err(|e| (StatusCode::BAD_REQUEST, format!("读取上传数据失败: {}", e)))?
        {
            file.write_all(&chunk)
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("写入文件失败: {}", e)))?;
            size += chunk.len() as u64;
        }
        file.flush()
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("写入文件失败: {}", e)))?;
        drop(file);

        // 全自动入库：落盘后立即移入书库目录 library/，网页端列表不再保留已接收文件。
        // 移动失败时降级保留在 wifi_uploads 原路径（事件仍照常推送，导入不受影响）。
        let final_target = match move_into_library(&lib_dir, &target).await {
            Ok(p) => p,
            Err(e) => {
                eprintln!("[wifi_transfer] 移入书库目录失败（保留原路径）: {}", e);
                target.clone()
            }
        };

        // 逐个推送事件，前端静默自动入库（group_id 已在服务端校验存在）
        let received = ReceivedFile {
            name: safe_name,
            path: final_target.to_string_lossy().to_string(),
            size,
            group_id,
        };
        let _ = ctx.app.emit("goread:wifi:received", &received);
        saved.push(received);
    }

    Ok(Json(UploadResponse {
        ok: true,
        saved,
        skipped,
    }))
}

/// 列出上传目录内的文件（仅文件，不含子目录；名称不区分大小写升序）
///
/// 参数：ctx 服务上下文
/// 返回值：JSON {ok, entries:[{name,size,is_dir}]}（is_dir 恒为 false，兼容旧网页结构）
async fn api_list(
    State(ctx): State<ServerContext>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let mut rd = tokio::fs::read_dir(&ctx.upload_dir)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("读取目录失败: {}", e)))?;
    let mut entries: Vec<serde_json::Value> = Vec::new();
    while let Some(entry) = rd
        .next_entry()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("读取目录失败: {}", e)))?
    {
        let meta = entry
            .metadata()
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("读取文件信息失败: {}", e)))?;
        // 只列文件：分组化改造后网页端不再有子目录概念
        if meta.is_dir() {
            continue;
        }
        entries.push(json!({
            "name": entry.file_name().to_string_lossy(),
            "size": meta.len(),
            "is_dir": false,
        }));
    }
    // 名称不区分大小写升序
    entries.sort_by(|a, b| {
        a["name"]
            .as_str()
            .unwrap_or("")
            .to_lowercase()
            .cmp(&b["name"].as_str().unwrap_or("").to_lowercase())
    });

    Ok(Json(json!({
        "ok": true,
        "entries": entries,
    })))
}

/// 分组创建请求体
#[derive(Debug, Deserialize)]
struct GroupCreateRequest {
    /// 新分组名称
    name: String,
}

/// 列出本地书架全量分组（含空分组，供网页端「导入到分组」下拉选择）
///
/// 直读书架 SQLite groups 表，与 App 端书架分组完全同源，
/// 保证 WiFi 网页端与本地书架两端分组数据一致。
///
/// 参数：ctx 服务上下文（经应用句柄访问书架数据库）
/// 返回值：JSON {ok, groups:[Group]}；数据库不可用返回 500
async fn api_list_groups(
    State(ctx): State<ServerContext>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let pool = ctx.app.state::<Arc<Mutex<SqlitePool>>>();
    let guard = pool.lock().await;
    // 空分组同样返回：网页端建组后需立即可选（即使还没有书）
    let groups = sqlx::query_as::<_, Group>(
        "SELECT * FROM groups ORDER BY sort_order DESC, created_at DESC",
    )
    .fetch_all(&*guard)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("读取分组失败: {}", e)))?;
    Ok(Json(json!({ "ok": true, "groups": groups })))
}

/// 创建分组（事务内查重+插入，直接落库书架 groups 表，与 App 端书架同步）
///
/// 参数：ctx 服务上下文；req.name 新分组名称（trim 后非空、不与现有分组重名）
/// 返回值：新分组 JSON；名称为空返回 400，重名返回 409，数据库错误返回 500
async fn api_create_group(
    State(ctx): State<ServerContext>,
    Json(req): Json<GroupCreateRequest>,
) -> Result<Json<Group>, (StatusCode, String)> {
    let trimmed = req.name.trim().to_string();
    if trimmed.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "分组名称不能为空".to_string()));
    }

    let pool = ctx.app.state::<Arc<Mutex<SqlitePool>>>();
    let guard = pool.lock().await;
    // 事务保障：查重与插入原子提交，避免并发创建产生同名分组
    let mut tx = (&*guard)
        .begin()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("开启事务失败: {}", e)))?;

    // 查重含空分组：书架会展示空分组，同名分组不允许重复出现
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM groups WHERE name = ?")
        .bind(&trimmed)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("查询分组失败: {}", e)))?;
    if count > 0 {
        return Err((StatusCode::CONFLICT, "分组名称已存在".to_string()));
    }

    // 排序基准含空分组，保证全局 sort_order 单调递增（与 App 端 add_group 口径一致）
    let max_order: Option<i64> = sqlx::query_scalar("SELECT MAX(sort_order) FROM groups")
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("查询排序失败: {}", e)))?;
    let next_order = max_order.unwrap_or(0) + 1;

    let result = sqlx::query("INSERT INTO groups (name, sort_order) VALUES (?, ?)")
        .bind(&trimmed)
        .bind(next_order)
        .execute(&mut *tx)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("创建分组失败: {}", e)))?;
    let group_id = result.last_insert_rowid();

    let group = sqlx::query_as::<_, Group>("SELECT * FROM groups WHERE id = ?")
        .bind(group_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("读取新分组失败: {}", e)))?;

    tx.commit()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("提交事务失败: {}", e)))?;

    Ok(Json(group))
}

/// 解析并校验上传携带的目标分组 ID：分组存在时返回 Some(id)，否则回退 None（不分组）
///
/// 参数：app 应用句柄（访问书架数据库）；raw 网页端提交的分组 ID（可缺省）
/// 返回值：分组存在于书架时为 Some(id)；缺省、不存在或库错误时为 None
async fn resolve_wifi_group(app: &AppHandle, raw: Option<i64>) -> Option<i64> {
    let gid = raw?;
    let pool = app.state::<Arc<Mutex<SqlitePool>>>();
    let guard = pool.lock().await;
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM groups WHERE id = ?")
        .bind(gid)
        .fetch_one(&*guard)
        .await
        .unwrap_or(0);
    if count > 0 {
        Some(gid)
    } else {
        eprintln!(
            "[wifi_transfer] 上传指定的分组不存在（id={}），回退为不分组",
            gid
        );
        None
    }
}

/// 删除上传目录内的文件或空文件夹（文件夹非空时拒绝）
///
/// 参数：ctx 服务上下文；req.path 相对上传目录的路径
/// 返回值：JSON {ok:true}；非法路径返回 403，目录非空返回 400，目标不存在返回 404
async fn api_delete(
    State(ctx): State<ServerContext>,
    Json(req): Json<DeleteRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let target = resolve_in_upload_dir(&ctx.upload_dir, &req.path)?;
    let meta = tokio::fs::metadata(&target)
        .await
        .map_err(|e| (StatusCode::NOT_FOUND, format!("目标不存在: {}", e)))?;
    if meta.is_dir() {
        // 仅允许删除空文件夹，避免误删整批文件
        tokio::fs::remove_dir(&target).await.map_err(|_| {
            (
                StatusCode::BAD_REQUEST,
                "文件夹非空，无法删除".to_string(),
            )
        })?;
    } else {
        tokio::fs::remove_file(&target)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("删除失败: {}", e)))?;
    }
    Ok(Json(json!({ "ok": true })))
}

/// 删除请求体
#[derive(Debug, Deserialize)]
struct DeleteRequest {
    /// 相对上传目录的文件路径
    path: String,
}

/// 将请求的相对子目录安全解析到上传目录内（防止路径穿越）
///
/// 参数：upload_dir 上传根目录；rel 相对路径（可为空表示根目录）
/// 返回值：解析后的绝对路径；含 ".." 组件时直接拒绝（避免清洗后语义漂移），越界返回 403
fn resolve_in_upload_dir(
    upload_dir: &Path,
    rel: &str,
) -> Result<PathBuf, (StatusCode, String)> {
    // 含 ".." 的原始路径一律拒绝：清洗会改变语义（如 "a/../" 变 "a"），可能误删文件
    if rel.split(['/', '\\']).any(|seg| seg.trim() == "..") {
        return Err((StatusCode::FORBIDDEN, "非法路径".to_string()));
    }
    let cleaned = sanitize_rel_dir(rel);
    let candidate = if cleaned.is_empty() {
        upload_dir.to_path_buf()
    } else {
        upload_dir.join(&cleaned)
    };
    // 双重校验：组件级前缀必须落在上传目录内
    if !candidate.starts_with(upload_dir) {
        return Err((StatusCode::FORBIDDEN, "非法路径".to_string()));
    }
    Ok(candidate)
}

/// 清洗相对子目录：仅保留安全字符段，剔除 ".."/"." 与空段
///
/// 参数：rel 原始相对路径
/// 返回值：清洗后的相对路径（如 "books/novel"；无有效段返回空串）
fn sanitize_rel_dir(rel: &str) -> String {
    rel.split(['/', '\\'])
        .map(str::trim)
        .filter(|seg| !seg.is_empty() && *seg != "." && *seg != "..")
        .map(sanitize_filename)
        .collect::<Vec<_>>()
        .join("/")
}

/// 提取小写扩展名（含点，无扩展名返回空串）
///
/// 参数：filename 文件名
/// 返回值：如 ".pdf"；无扩展名返回 ""
pub(crate) fn file_extension(filename: &str) -> String {
    Path::new(filename)
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy().to_lowercase()))
        .unwrap_or_default()
}

/// 清洗上传文件名：仅保留最后一段路径、替换非法字符、规避 Windows 保留名
///
/// 参数：name 原始文件名
/// 返回值：清洗后的安全文件名（保证非空）
pub(crate) fn sanitize_filename(name: &str) -> String {
    // 仅保留最后一段，防止路径穿越
    let base = name
        .rsplit(|c| c == '/' || c == '\\')
        .next()
        .unwrap_or(name)
        .trim();
    // 替换 Windows 文件名非法字符并去除控制字符
    let cleaned: String = base
        .chars()
        .filter(|c| !c.is_control())
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '|' | '?' | '*' | '/' | '\\' => '_',
            _ => c,
        })
        .collect();
    // 去除首尾空格与点（Windows 不允许结尾为点或空格）
    let mut trimmed = cleaned.trim().trim_matches('.').to_string();

    // Windows 保留设备名检查（按主名判断，忽略扩展名）
    let (stem, _) = match trimmed.find('.') {
        Some(idx) => (trimmed[..idx].to_uppercase(), &trimmed[idx..]),
        None => (trimmed.to_uppercase(), ""),
    };
    if WINDOWS_RESERVED_NAMES.contains(&stem.as_str()) {
        trimmed = format!("book_{}", trimmed);
    }

    if trimmed.is_empty() {
        trimmed = "book_upload".to_string();
    }
    trimmed
}

/// 生成不重名的保存路径（重名时在主名后追加序号，极端情况下回退纳秒时间戳）
///
/// 参数：dir 保存目录；file_name 已清洗的文件名
/// 返回值：不与现有文件冲突的目标路径
pub(crate) async fn unique_target(dir: &Path, file_name: &str) -> PathBuf {
    let first = dir.join(file_name);
    if !tokio::fs::try_exists(&first).await.unwrap_or(false) {
        return first;
    }
    // 拆分主名与扩展名
    let (stem, ext) = match file_name.rfind('.') {
        Some(idx) if idx > 0 => (&file_name[..idx], &file_name[idx..]),
        _ => (file_name, ""),
    };
    for i in 1..1000u32 {
        let candidate = dir.join(format!("{}_{}{}", stem, i, ext));
        if !tokio::fs::try_exists(&candidate).await.unwrap_or(false) {
            return candidate;
        }
    }
    dir.join(format!(
        "{}_{}{}",
        stem,
        chrono::Utc::now()
            .timestamp_nanos_opt()
            .unwrap_or_default(),
        ext
    ))
}

/// 单元测试：is_strictly_under 路径包含判定（wifi_stage_to_library 的安全边界）
#[cfg(test)]
mod wifi_under_tests {
    use super::*;

    /// wifi_uploads 内文件应判定为内部
    #[test]
    fn 内部文件_命中() {
        assert!(is_strictly_under(
            Path::new(r"C:\data\wifi_uploads\a.txt"),
            Path::new(r"C:\data\wifi_uploads"),
        ));
    }

    /// Windows 路径大小写不敏感
    #[test]
    fn 大小写不敏感_命中() {
        assert!(is_strictly_under(
            Path::new(r"c:\Data\WIFI_UPLOADS\Sub\A.TXT"),
            Path::new(r"C:\data\wifi_uploads"),
        ));
    }

    /// 同级前缀目录不得误判（wifi_uploads_x 不是 wifi_uploads 内部）
    #[test]
    fn 同级前缀_不命中() {
        assert!(!is_strictly_under(
            Path::new(r"C:\data\wifi_uploads_x\a.txt"),
            Path::new(r"C:\data\wifi_uploads"),
        ));
    }

    /// 外部盘符路径不命中
    #[test]
    fn 外部路径_不命中() {
        assert!(!is_strictly_under(
            Path::new(r"D:\other\a.txt"),
            Path::new(r"C:\data\wifi_uploads"),
        ));
    }

    /// 目录自身不算“严格内部”
    #[test]
    fn 自身路径_不命中() {
        assert!(!is_strictly_under(
            Path::new(r"C:\data\wifi_uploads"),
            Path::new(r"C:\data\wifi_uploads"),
        ));
    }
}

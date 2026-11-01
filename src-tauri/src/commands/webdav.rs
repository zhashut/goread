//! NAS 获取书籍：WebDAV 客户端命令
//!
//! 通过 WebDAV 协议（PROPFIND 列目录 / GET 下载 / Basic Auth）连接 NAS，
//! 浏览远端目录并下载书籍文件到应用数据目录 `nas_downloads/`，
//! 下载完成后返回本地路径，由前端复用既有导入分组流程入库。
//!
//! 另提供「点击即读」透明缓存通道：`nas_open_remote` 将远端书籍缓存到
//! `nas_cache/<sha256(连接id|远端路径)>.<扩展名>` 的确定性路径并登记书籍记录，
//! 阅读进度、书签挂在书籍 id 上，与缓存生命周期解耦。
//! 每次打开均实时校验远端修改时间（HEAD Last-Modified），NAS 文件更新后
//! 重新下载同步最新内容（本地缓存 mtime 对齐远端作为比对基准）。

use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::book::DbState;
use crate::formats;
use crate::wifi_transfer::{file_extension, sanitize_filename, unique_target};

/// 下载进度事件名（payload: DownloadProgress）
const DOWNLOAD_PROGRESS_EVENT: &str = "goread:nas:download";

/// 下载进度事件推送节流间隔（字节，256KB）
const PROGRESS_EMIT_INTERVAL: u64 = 256 * 1024;

/// 目录请求总超时（秒）：仅约束 PROPFIND 单次请求
const LIST_TIMEOUT_SECS: u64 = 30;

/// 缓存新鲜度校验请求超时（秒）：校验失败时退化为直接使用本地缓存（离线优先）
const FRESHNESS_TIMEOUT_SECS: u64 = 5;

/// 缓存过期判定容差（毫秒）：抵消文件系统修改时间粒度与 HTTP 秒级时间戳误差
const CACHE_MTIME_TOLERANCE_MS: i64 = 2000;

/// PROPFIND 请求体：请求显示名/大小/修改时间/资源类型四个标准属性
const PROPFIND_BODY: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:displayname/>
    <d:getcontentlength/>
    <d:getlastmodified/>
    <d:resourcetype/>
  </d:prop>
</d:propfind>"#;

/// URL 路径编码集：字母数字外全部编码（保留字符按分段处理）
const PATH_SET: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~');

/// WebDAV 目录项（与前端 NasEntry 类型对应）
#[derive(Serialize, Debug)]
pub struct WebDavEntry {
    /// 显示名（displayname 优先，退化为 href 最后一段）
    pub name: String,
    /// 站点内绝对路径（已 percent 解码，以 / 开头，目录以 / 结尾）
    pub path: String,
    /// 是否目录
    pub is_dir: bool,
    /// 文件大小（字节；目录为 None）
    pub size: Option<u64>,
    /// 修改时间（毫秒时间戳；解析失败为 None）
    pub mtime: Option<i64>,
}

/// 下载进度事件 payload（前端监听 goread:nas:download）
#[derive(Serialize, Clone)]
struct DownloadProgress {
    /// 保存文件名（清洗后）
    name: String,
    /// 已下载字节
    downloaded: u64,
    /// 总字节（服务器未提供 Content-Length 时为 None）
    total: Option<u64>,
}

/// 规范化站点根地址：去首尾空白与尾部斜杠，校验协议白名单
///
/// 参数：base_url 用户输入的站点地址
/// 返回值：规范化后的地址（无尾部 /）；协议非法返回错误说明
fn normalize_base_url(base_url: &str) -> Result<String, String> {
    let trimmed = base_url.trim().trim_end_matches('/');
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err("地址必须以 http:// 或 https:// 开头".to_string());
    }
    Ok(trimmed.to_string())
}

/// 归一目录路径：以 / 开头、以 / 结尾（根为 "/"）
///
/// 参数：dir 原始目录路径
/// 返回值：归一后的目录路径
fn normalize_dir_path(dir: &str) -> String {
    let mut p = dir.trim().to_string();
    if p.is_empty() {
        return "/".to_string();
    }
    if !p.starts_with('/') {
        p.insert(0, '/');
    }
    if !p.ends_with('/') {
        p.push('/');
    }
    p
}

/// 归一文件路径：以 / 开头、去尾部斜杠
///
/// 参数：p 原始文件路径
/// 返回值：归一后的文件路径
fn normalize_file_path(p: &str) -> String {
    let mut s = p.trim().to_string();
    while s.ends_with('/') {
        s.pop();
    }
    if !s.starts_with('/') {
        s.insert(0, '/');
    }
    s
}

/// 将已解码的站点内路径按 / 分段做 percent 编码，生成可请求 URL 路径
///
/// 参数：path 已解码路径（如 "/books/小说/"）
/// 返回值：编码后的 URL 路径（如 "/books/%E5%B0%8F%E8%AF%B4/"）
fn encode_site_path(path: &str) -> String {
    path.split('/')
        .map(|seg| utf8_percent_encode(seg, PATH_SET).to_string())
        .collect::<Vec<_>>()
        .join("/")
}

/// 解码 href 中的 percent 编码（非法序列原样保留）
///
/// 参数：href 原始 href 字符串
/// 返回值：解码后的字符串
fn decode_href(href: &str) -> String {
    percent_encoding::percent_decode_str(href)
        .decode_utf8_lossy()
        .to_string()
}

/// 从 href 提取站点内路径（兼容绝对 URL 与相对路径两种服务器返回形式）
///
/// 参数：href 原始 href（如 "http://host/dav/a/" 或 "/dav/a/"）
/// 返回值：站点内绝对路径（如 "/dav/a/"）
fn href_to_site_path(href: &str) -> String {
    let decoded = decode_href(href);
    if let Some(idx) = decoded.find("://") {
        if let Some(slash) = decoded[idx + 3..].find('/') {
            return decoded[idx + 3 + slash..].to_string();
        }
        return "/".to_string();
    }
    decoded
}

/// 解析 HTTP 日期（RFC 2822/1123 格式，WebDAV getlastmodified 标准格式）
///
/// 参数：s 日期字符串（如 "Wed, 21 Oct 2015 07:28:00 GMT"）
/// 返回值：毫秒时间戳；解析失败返回 None
fn parse_http_date(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc2822(s)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

/// 构建 HTTP 客户端：接受自签证书（NAS 场景普遍）、限制连接超时，不设总超时（大文件下载需要）
///
/// 返回值：可复用的 HTTP 客户端；构建失败返回错误说明
fn build_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .connect_timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("初始化 HTTP 客户端失败: {}", e))
}

/// 为请求附加 Basic 认证（账号为空则匿名）
///
/// 参数：req 待附加的请求构造器；username 账号；password 密码
/// 返回值：附加认证后的请求构造器
fn with_auth(
    req: reqwest::RequestBuilder,
    username: Option<&str>,
    password: Option<&str>,
) -> reqwest::RequestBuilder {
    match username.filter(|u| !u.is_empty()) {
        Some(u) => req.basic_auth(u, password),
        None => req,
    }
}

/// 解析 PROPFIND multistatus XML 为目录项列表
///
/// 参数：xml 207 响应正文
/// 返回值：目录项列表（含目录自身，由调用方剔除）；解析失败返回错误说明
fn parse_propfind_response(xml: &str) -> Result<Vec<WebDavEntry>, String> {
    let doc = roxmltree::Document::parse(xml).map_err(|e| format!("解析目录响应失败: {}", e))?;
    let mut entries = Vec::new();
    for resp in doc
        .descendants()
        .filter(|n| n.is_element() && n.tag_name().name() == "response")
    {
        // href：条目路径（部分服务器返回绝对 URL，统一转为站点内路径）
        let href = resp
            .children()
            .filter(|n| n.is_element() && n.tag_name().name() == "href")
            .find_map(|n| n.text())
            .unwrap_or("")
            .to_string();
        if href.is_empty() {
            continue;
        }

        // prop 属性解析（按 local name 匹配，兼容 d:/D:/默认命名空间三种前缀形式）
        let mut displayname = String::new();
        let mut size: Option<u64> = None;
        let mut mtime: Option<i64> = None;
        let mut is_dir = false;
        if let Some(prop) = resp
            .children()
            .find(|n| n.is_element() && n.tag_name().name() == "propstat")
            .and_then(|ps| {
                ps.children()
                    .find(|n| n.is_element() && n.tag_name().name() == "prop")
            })
        {
            for child in prop.children().filter(|n| n.is_element()) {
                match child.tag_name().name() {
                    "displayname" => {
                        displayname = child.text().unwrap_or("").trim().to_string()
                    }
                    "getcontentlength" => {
                        if let Some(v) = child.text().and_then(|t| t.trim().parse::<u64>().ok()) {
                            size = Some(v);
                        }
                    }
                    "getlastmodified" => {
                        mtime = child.text().and_then(|t| parse_http_date(t.trim()));
                    }
                    "resourcetype" => {
                        is_dir = child
                            .descendants()
                            .any(|n| n.is_element() && n.tag_name().name() == "collection");
                    }
                    _ => {}
                }
            }
        }

        let site_path = href_to_site_path(&href);
        // 兜底目录判定：href 以 / 结尾（个别服务器 resourcetype 缺失时）
        if !is_dir && site_path.ends_with('/') {
            is_dir = true;
        }
        // name：displayname 优先，否则取路径最后一段
        let name = if !displayname.is_empty() {
            displayname
        } else {
            site_path
                .trim_end_matches('/')
                .rsplit('/')
                .next()
                .unwrap_or("")
                .to_string()
        };
        entries.push(WebDavEntry {
            name,
            path: site_path,
            is_dir,
            size: if is_dir { None } else { size },
            mtime,
        });
    }
    Ok(entries)
}

/// 列出 WebDAV 目录内容
///
/// 参数：base_url 站点根地址；username/password 认证信息（可为 None 匿名）；
///       dir_path 站点内目录路径（如 "/" 或 "/books/"）
/// 返回值：子项列表（目录在前、按名称排序，已剔除目录自身与群晖回收站 #recycle）；失败返回错误说明
#[tauri::command]
pub async fn webdav_list(
    base_url: String,
    username: Option<String>,
    password: Option<String>,
    dir_path: String,
) -> Result<Vec<WebDavEntry>, String> {
    let base = normalize_base_url(&base_url)?;
    let dir = normalize_dir_path(&dir_path);
    let url = format!("{}{}", base, encode_site_path(&dir));

    let client = build_client()?;
    let req = with_auth(
        client
            .request(
                reqwest::Method::from_bytes(b"PROPFIND").expect("合法 HTTP 方法"),
                &url,
            )
            .header("Depth", "1")
            .header("Content-Type", "application/xml; charset=utf-8")
            .body(PROPFIND_BODY),
        username.as_deref(),
        password.as_deref(),
    )
    .timeout(std::time::Duration::from_secs(LIST_TIMEOUT_SECS));

    let resp = req.send().await.map_err(|e| format!("连接失败: {}", e))?;
    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err("认证失败：请检查账号或密码".to_string());
    }
    if !status.is_success() {
        return Err(format!("服务器返回错误: {} {}", status.as_u16(), status));
    }
    let text = resp.text().await.map_err(|e| format!("读取响应失败: {}", e))?;
    let mut entries = parse_propfind_response(&text)?;

    // 剔除目录自身（服务器返回的第一项即被列目录本身）
    let self_key = dir.trim_end_matches('/').to_string();
    entries.retain(|e| e.path.trim_end_matches('/') != self_key);

    // 过滤群晖 NAS 回收站目录（#recycle）：书架与导入页均不应展示回收站内容
    entries.retain(|e| e.name != "#recycle");

    // 排序：目录在前，再按名称（不区分大小写）
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(entries)
}

/// 下载失败时删除半成品文件（清理失败静默忽略）
///
/// 参数：path 半成品文件路径
async fn cleanup_partial(path: &std::path::Path) {
    let _ = tokio::fs::remove_file(path).await;
}

/// 下载核心：请求 URL 并流式写入目标文件
///
/// 参数：client HTTP 客户端；url 完整下载地址；username/password 认证信息；
///       target 本地目标文件路径；on_progress 进度回调（已下载字节, 总字节）
/// 返回值：(实际下载字节数, 服务器报告的总字节数)；失败返回错误说明（半成品文件由调用方清理）
async fn download_to_file(
    client: &reqwest::Client,
    url: &str,
    username: Option<&str>,
    password: Option<&str>,
    target: &std::path::Path,
    mut on_progress: impl FnMut(u64, Option<u64>),
) -> Result<(u64, Option<u64>), String> {
    let req = with_auth(client.get(url), username, password);
    let mut resp = req
        .send()
        .await
        .map_err(|e| format!("下载请求失败: {}", e))?;
    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err("认证失败：请检查账号或密码".to_string());
    }
    if !status.is_success() {
        return Err(format!("服务器返回错误: {} {}", status.as_u16(), status));
    }

    let total = resp.content_length();
    let mut file = tokio::fs::File::create(target)
        .await
        .map_err(|e| format!("创建本地文件失败: {}", e))?;

    use tokio::io::AsyncWriteExt;
    let mut downloaded: u64 = 0;
    loop {
        match resp.chunk().await {
            Ok(Some(chunk)) => {
                file.write_all(&chunk)
                    .await
                    .map_err(|e| format!("写入本地文件失败: {}", e))?;
                downloaded += chunk.len() as u64;
                on_progress(downloaded, total);
            }
            Ok(None) => break,
            Err(e) => {
                return Err(format!("下载数据流中断: {}", e));
            }
        }
    }
    file.flush()
        .await
        .map_err(|e| format!("写入本地文件失败: {}", e))?;
    Ok((downloaded, total))
}

/// 远端文件状态探测结果
#[derive(Debug, PartialEq, Eq)]
enum RemoteMtime {
    /// 远端文件存在，携带 Last-Modified 解析出的毫秒时间戳
    Present(i64),
    /// 远端明确确认文件不存在（HTTP 404/410，通常已在服务器上删除或移动）
    Missing,
    /// 无法判定（网络错误、超时、认证失败、服务器错误或未提供 Last-Modified）
    Unknown,
}

/// 探测远端文件状态与修改时间（HEAD 请求的 Last-Modified 响应头）
///
/// 参数：client HTTP 客户端；url 完整文件地址；username/password 认证信息
/// 返回值：RemoteMtime 探测结果——区分「远端明确不存在」「存在（含修改时间）」
///         与「无法判定」三类；仅 404/410 视为明确不存在，其余异常均归入
///         Unknown 以保持离线优先语义（不因网络故障误删数据）
async fn probe_remote_mtime(
    client: &reqwest::Client,
    url: &str,
    username: Option<&str>,
    password: Option<&str>,
) -> RemoteMtime {
    let resp = match with_auth(client.head(url), username, password)
        .timeout(std::time::Duration::from_secs(FRESHNESS_TIMEOUT_SECS))
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => return RemoteMtime::Unknown,
    };
    let status = resp.status();
    if status == reqwest::StatusCode::NOT_FOUND || status == reqwest::StatusCode::GONE {
        return RemoteMtime::Missing;
    }
    if !status.is_success() {
        return RemoteMtime::Unknown;
    }
    match resp
        .headers()
        .get(reqwest::header::LAST_MODIFIED)
        .and_then(|v| v.to_str().ok())
        .and_then(parse_http_date)
    {
        Some(ms) => RemoteMtime::Present(ms),
        None => RemoteMtime::Unknown,
    }
}

/// 判断本地缓存是否已落后于远端文件（需要重新下载同步）
///
/// 参数：remote_mtime_ms 远端文件修改时间（毫秒）；local_mtime_ms 本地缓存文件修改时间（毫秒）
/// 返回值：远端修改时间超出容差地晚于本地缓存时间时返回 true
fn cache_is_stale(remote_mtime_ms: i64, local_mtime_ms: i64) -> bool {
    remote_mtime_ms > local_mtime_ms + CACHE_MTIME_TOLERANCE_MS
}

/// 将本地文件修改时间设置为远端文件修改时间（作为下次新鲜度比对基准）
///
/// 两侧比对值均来自远端时钟，本机与 NAS 时钟偏差不影响判定。
///
/// 参数：path 本地缓存文件路径；mtime_ms 远端修改时间毫秒时间戳
async fn set_file_mtime(path: &std::path::Path, mtime_ms: i64) {
    if mtime_ms < 0 {
        return;
    }
    let system_time =
        std::time::UNIX_EPOCH + std::time::Duration::from_millis(mtime_ms as u64);
    if let Ok(file) = tokio::fs::OpenOptions::new().write(true).open(path).await {
        let std_file = file.into_std().await;
        // 失败静默忽略：仅影响下次同步判定精度，不影响本次打开
        let _ = std_file.set_modified(system_time);
    }
}

/// 从 WebDAV 下载书籍文件到应用数据目录
///
/// 参数：app 应用句柄（进度事件发射与数据目录定位）；base_url 站点根地址；
///       username/password 认证信息；remote_path 站点内文件完整路径；file_name 保存文件名
/// 返回值：本地保存的绝对路径；失败返回错误说明（半成品文件自动清理）
#[tauri::command]
pub async fn webdav_download(
    app: AppHandle,
    base_url: String,
    username: Option<String>,
    password: Option<String>,
    remote_path: String,
    file_name: String,
) -> Result<String, String> {
    let base = normalize_base_url(&base_url)?;

    // 扩展名白名单：仅允许受支持的书籍格式
    let ext = file_extension(&file_name);
    let ext_no_dot = ext.trim_start_matches('.').to_string();
    if ext_no_dot.is_empty() || !formats::is_scan_supported_extension(&ext_no_dot) {
        return Err(format!("不支持的文件格式: {}", ext));
    }
    let safe_name = sanitize_filename(&file_name);

    // 保存目录：app_data/nas_downloads，重名自动追加序号
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {}", e))?
        .join("nas_downloads");
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("创建下载目录失败: {}", e))?;
    let target = unique_target(&dir, &safe_name).await;

    // 下载请求：remote_path 为站点内完整文件路径
    let remote = normalize_file_path(&remote_path);
    let url = format!("{}{}", base, encode_site_path(&remote));
    let client = build_client()?;

    // 流式下载 + 进度事件（按 256KB 节流推送）
    let mut last_emit: u64 = 0;
    let app_for_progress = app.clone();
    let event_name = safe_name.clone();
    let download_result = download_to_file(
        &client,
        &url,
        username.as_deref(),
        password.as_deref(),
        &target,
        |downloaded, total| {
            if downloaded - last_emit >= PROGRESS_EMIT_INTERVAL {
                last_emit = downloaded;
                let _ = app_for_progress.emit(
                    DOWNLOAD_PROGRESS_EVENT,
                    DownloadProgress {
                        name: event_name.clone(),
                        downloaded,
                        total,
                    },
                );
            }
        },
    )
    .await;

    let (downloaded, total) = match download_result {
        Ok(v) => v,
        Err(e) => {
            cleanup_partial(&target).await;
            return Err(e);
        }
    };

    // 完成事件：前端凭 downloaded == total 或收到完成信号更新最终进度
    let _ = app.emit(
        DOWNLOAD_PROGRESS_EVENT,
        DownloadProgress {
            name: safe_name.clone(),
            downloaded,
            total,
        },
    );
    Ok(target.to_string_lossy().to_string())
}

/// NAS 打开结果（前端据此跳转阅读器）
#[derive(Serialize, Clone)]
pub struct NasOpenResult {
    /// 书籍记录 id（books 表主键）
    pub book_id: i64,
    /// 本地缓存文件绝对路径（即 books.file_path）
    pub cache_path: String,
    /// 本次是否命中未变化缓存（true=直接打开，false=新下载或远端已更新重新下载）
    pub was_cached: bool,
}

/// NAS 缓存统计（设置页缓存管理展示用）
#[derive(Serialize, Clone)]
pub struct NasCacheStats {
    /// 缓存文件数量
    pub file_count: u32,
    /// 缓存总字节数
    pub total_bytes: u64,
}

/// 计算网络书架缓存键：sha256(连接id + "|" + 远端路径) 的十六进制摘要
///
/// 参数：connection_id NAS 连接 id；remote_path 归一化后的远端文件路径
/// 返回值：64 位十六进制字符串（确定性：清除缓存重建后路径不变，保障 file_path 持续有效）
fn nas_cache_hash(connection_id: &str, remote_path: &str) -> String {
    let digest = Sha256::digest(format!("{}|{}", connection_id, remote_path).as_bytes());
    digest.iter().map(|b| format!("{:02x}", b)).collect()
}

/// 按身份查询或登记 NAS 缓存书籍记录
///
/// 参数：pool 数据库连接池；connection_id NAS 连接 id；remote_path 归一化远端路径；
///       cache_path 本地缓存文件绝对路径；title 书籍标题（文件名去扩展名）
/// 返回值：书籍记录 id；数据库操作失败返回错误说明
async fn ensure_nas_book_record(
    pool: &sqlx::SqlitePool,
    connection_id: &str,
    remote_path: &str,
    cache_path: &str,
    title: &str,
) -> Result<i64, String> {
    // 身份定位：同一连接下的同一远端文件视为同一本书
    let existing: Option<i64> = sqlx::query_scalar(
        "SELECT id FROM books WHERE source = 'nas' AND source_conn_id = ? AND source_path = ?",
    )
    .bind(connection_id)
    .bind(remote_path)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("查询书籍记录失败: {}", e))?;
    if let Some(id) = existing {
        return Ok(id);
    }

    // 新书记录：file_path UNIQUE 约束 + INSERT OR IGNORE 保证幂等
    sqlx::query("INSERT OR IGNORE INTO books (title, file_path, total_pages, reading_mode, hide_divider) VALUES (?, ?, 1, NULL, NULL)")
        .bind(title)
        .bind(cache_path)
        .execute(pool)
        .await
        .map_err(|e| format!("登记书籍失败: {}", e))?;
    let id: i64 = sqlx::query_scalar("SELECT id FROM books WHERE file_path = ?")
        .bind(cache_path)
        .fetch_one(pool)
        .await
        .map_err(|e| format!("登记书籍失败: {}", e))?;
    sqlx::query("UPDATE books SET source = 'nas', source_conn_id = ?, source_path = ? WHERE id = ?")
        .bind(connection_id)
        .bind(remote_path)
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| format!("登记书籍失败: {}", e))?;
    Ok(id)
}

/// 打开网络书架远端书籍：命中未变化缓存直接返回，否则流式下载到确定性缓存路径并登记书籍
///
/// 缓存键为 sha256(连接id|远端路径)，路径与阅读进度解耦于缓存生命周期：
/// 清空缓存后重新打开会重建同路径文件，books.file_path 持续有效，进度与书签不丢。
/// 打开时实时探测远端状态（HEAD Last-Modified）：本地缓存落后于远端时重新下载
/// 同步最新内容；校验失败（离线/服务器不支持）退化为直接使用本地缓存，离线仍可读；
/// 远端明确确认文件不存在（404/410）时清理本地缓存与书籍记录并返回错误，
/// 已在服务器上删除的书籍不会再从「最近」中以残留缓存打开。
///
/// 参数：app 应用句柄（数据目录定位与进度事件）；connection_id NAS 连接 id；
///       base_url 站点根地址；username/password 认证信息；
///       remote_path 站点内文件完整路径；file_name 远端文件名（用于标题与进度展示）
/// 返回值：NasOpenResult（书籍 id / 缓存路径 / 是否命中未变化缓存）；失败返回错误说明
#[tauri::command]
pub async fn nas_open_remote(
    app: AppHandle,
    connection_id: String,
    base_url: String,
    username: Option<String>,
    password: Option<String>,
    remote_path: String,
    file_name: String,
    db: DbState<'_>,
) -> Result<NasOpenResult, String> {
    let base = normalize_base_url(&base_url)?;

    // 扩展名白名单：仅允许受支持的书籍格式
    let ext = file_extension(&file_name);
    let ext_no_dot = ext.trim_start_matches('.').to_string();
    if ext_no_dot.is_empty() || !formats::is_scan_supported_extension(&ext_no_dot) {
        return Err(format!("不支持的文件格式: {}", ext));
    }
    let safe_name = sanitize_filename(&file_name);

    // 确定性缓存路径：app_data/nas_cache/<sha256(conn_id|remote_path)>.<小写扩展名>
    let remote = normalize_file_path(&remote_path);
    let cache_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {}", e))?
        .join("nas_cache");
    let target = cache_dir.join(format!(
        "{}.{}",
        nas_cache_hash(&connection_id, &remote),
        ext_no_dot
    ));
    let target_str = target.to_string_lossy().to_string();

    // 下载地址与 HTTP 客户端提前构建：新鲜度校验与可能的重新下载共用
    let url = format!("{}{}", base, encode_site_path(&remote));
    let client = build_client()?;

    // 远端文件状态实时探测：文件更新检测的比对基准与存在性确认
    let remote_state = probe_remote_mtime(
        &client,
        &url,
        username.as_deref(),
        password.as_deref(),
    )
    .await;

    // 远端明确确认文件不存在（404/410，通常已在服务器上删除或移动）：
    // 清理本地缓存与书籍记录，使其从「最近」与书架中消失，避免继续打开残留缓存。
    // 仅在服务器明确应答 404/410 时执行删除；网络故障等 Unknown 情况绝不误删。
    if remote_state == RemoteMtime::Missing {
        let _ = tokio::fs::remove_file(&target).await;
        let pool = db.lock().await;
        // 项目未启用 SQLite 外键级联（PRAGMA foreign_keys 默认关闭），
        // 删除书籍记录前需显式清理该书签，避免 bookmarks 残留孤儿记录
        if let Err(e) = sqlx::query(
            "DELETE FROM bookmarks WHERE book_id IN (SELECT id FROM books WHERE source = 'nas' AND source_conn_id = ? AND source_path = ?)",
        )
        .bind(&connection_id)
        .bind(&remote)
        .execute(&*pool)
        .await
        {
            eprintln!("[nas_open_remote] 删除已失效书籍书签失败: {}", e);
        }
        if let Err(e) = sqlx::query(
            "DELETE FROM books WHERE source = 'nas' AND source_conn_id = ? AND source_path = ?",
        )
        .bind(&connection_id)
        .bind(&remote)
        .execute(&*pool)
        .await
        {
            eprintln!("[nas_open_remote] 删除已失效书籍记录失败: {}", e);
        }
        return Err("远端文件已不存在（可能已在服务器上删除），已从书架移除".to_string());
    }

    // 缓存新鲜度比对基准：仅远端存在时才有确定的修改时间
    let remote_mtime = match remote_state {
        RemoteMtime::Present(ms) => Some(ms),
        _ => None,
    };

    // 缓存命中判定：文件存在且未落后于远端修改时间。
    // 文件被手动删除时自动重新下载；NAS 上文件已更新时重新下载同步最新内容；
    // 无法比对（离线或服务器未提供修改时间）时沿用本地缓存（离线优先）。
    let mut was_cached = false;
    if let Ok(meta) = tokio::fs::metadata(&target).await {
        let local_ms = meta
            .modified()
            .ok()
            .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64);
        let stale = match (remote_mtime, local_ms) {
            (Some(remote_ms), Some(local_ms)) => cache_is_stale(remote_ms, local_ms),
            _ => false,
        };
        was_cached = !stale;
    }

    if !was_cached {
        tokio::fs::create_dir_all(&cache_dir)
            .await
            .map_err(|e| format!("创建缓存目录失败: {}", e))?;

        // 流式下载 + 进度事件（复用 goread:nas:download 事件，256KB 节流）
        let mut last_emit: u64 = 0;
        let app_for_progress = app.clone();
        let event_name = safe_name.clone();
        let download_result = download_to_file(
            &client,
            &url,
            username.as_deref(),
            password.as_deref(),
            &target,
            |downloaded, total| {
                if downloaded - last_emit >= PROGRESS_EMIT_INTERVAL {
                    last_emit = downloaded;
                    let _ = app_for_progress.emit(
                        DOWNLOAD_PROGRESS_EVENT,
                        DownloadProgress {
                            name: event_name.clone(),
                            downloaded,
                            total,
                        },
                    );
                }
            },
        )
        .await;

        let (downloaded, total) = match download_result {
            Ok(v) => v,
            Err(e) => {
                cleanup_partial(&target).await;
                return Err(e);
            }
        };

        // 完成事件：前端凭 downloaded == total 或 total 为 None 时收尾隐藏浮层
        let _ = app.emit(
            DOWNLOAD_PROGRESS_EVENT,
            DownloadProgress {
                name: safe_name.clone(),
                downloaded,
                total,
            },
        );

        // 本地文件修改时间对齐远端：下次打开据此判断是否需要重新同步
        if let Some(remote_ms) = remote_mtime {
            set_file_mtime(&target, remote_ms).await;
        }
    }

    // 标题：文件名去扩展名（与本地导入的降级命名一致）
    let title = safe_name
        .rsplit_once('.')
        .map(|(stem, _)| stem)
        .filter(|stem| !stem.is_empty())
        .unwrap_or(&safe_name)
        .to_string();

    let pool = db.lock().await;
    let book_id = ensure_nas_book_record(&pool, &connection_id, &remote, &target_str, &title).await?;

    Ok(NasOpenResult {
        book_id,
        cache_path: target_str,
        was_cached,
    })
}

/// 统计网络书架缓存目录的文件数量与总大小
///
/// 参数：app 应用句柄（数据目录定位）
/// 返回值：NasCacheStats（文件数 / 总字节）；目录不存在按 0 处理
#[tauri::command]
pub async fn nas_cache_stats(app: AppHandle) -> Result<NasCacheStats, String> {
    let cache_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {}", e))?
        .join("nas_cache");

    let mut file_count: u32 = 0;
    let mut total_bytes: u64 = 0;
    let mut entries = match tokio::fs::read_dir(&cache_dir).await {
        Ok(e) => e,
        Err(_) => return Ok(NasCacheStats { file_count, total_bytes }),
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        if path.is_file() {
            if let Ok(meta) = entry.metadata().await {
                file_count += 1;
                total_bytes += meta.len();
            }
        }
    }
    Ok(NasCacheStats {
        file_count,
        total_bytes,
    })
}

/// 清空网络书架缓存目录（nas_cache）下全部文件
///
/// 仅删除缓存文件，不删除书籍记录：缓存重建后确定性路径不变，file_path 依旧有效。
///
/// 参数：app 应用句柄（数据目录定位）
/// 返回值：删除的文件数量；目录不存在视为已清空返回 0
#[tauri::command]
pub async fn nas_cache_clear(app: AppHandle) -> Result<u32, String> {
    let cache_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {}", e))?
        .join("nas_cache");

    let mut removed: u32 = 0;
    let mut entries = match tokio::fs::read_dir(&cache_dir).await {
        Ok(e) => e,
        Err(_) => return Ok(0),
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        if path.is_file() && tokio::fs::remove_file(&path).await.is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use std::io::{Read, Write};
    use std::sync::mpsc::Receiver;

    /// 启动一次性本地 mock HTTP 服务器：接收一个请求、记录请求原文并返回预置响应
    ///
    /// 参数：response 完整 HTTP 响应字节（含状态行/头/体）
    /// 返回值：(站点根地址, 请求原文接收通道)
    fn spawn_mock_server(response: Vec<u8>) -> (String, Receiver<String>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("绑定 mock 端口");
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 8192];
                let n = stream.read(&mut buf).unwrap_or(0);
                let _ = tx.send(String::from_utf8_lossy(&buf[..n]).to_string());
                let _ = stream.write_all(&response);
                let _ = stream.flush();
            }
        });
        (format!("http://127.0.0.1:{}", port), rx)
    }

    /// 构造 207 Multi-Status 响应字节
    fn multistatus_response(body: &str) -> Vec<u8> {
        format!(
            "HTTP/1.1 207 Multi-Status\r\nContent-Type: application/xml; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
        .into_bytes()
    }

    /// 构造 GET 文件响应字节
    fn file_response(body: &[u8]) -> Vec<u8> {
        let mut resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        resp.extend_from_slice(body);
        resp
    }

    /// 构造 HEAD 响应字节（可选携带 Last-Modified 头）
    fn head_response(last_modified: Option<&str>) -> Vec<u8> {
        match last_modified {
            Some(lm) => format!(
                "HTTP/1.1 200 OK\r\nLast-Modified: {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                lm
            )
            .into_bytes(),
            None => b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
        }
    }

    #[test]
    fn test_normalize_helpers() {
        assert_eq!(normalize_base_url(" http://nas:5005/ ").unwrap(), "http://nas:5005");
        assert_eq!(normalize_base_url("ftp://x").unwrap_err(), "地址必须以 http:// 或 https:// 开头");
        assert_eq!(normalize_dir_path(""), "/");
        assert_eq!(normalize_dir_path("books"), "/books/");
        assert_eq!(normalize_dir_path("/books"), "/books/");
        assert_eq!(normalize_file_path("/a/b.txt/"), "/a/b.txt");
        assert_eq!(normalize_file_path("a.txt"), "/a.txt");
    }

    #[test]
    fn test_encode_and_decode_path() {
        // 中文与空格需编码，斜杠保留
        assert_eq!(encode_site_path("/books/我的 书/"), "/books/%E6%88%91%E7%9A%84%20%E4%B9%A6/");
        assert_eq!(decode_href("/dav/%E5%B0%8F%E8%AF%B4.txt"), "/dav/小说.txt");
        // 绝对 URL 形式的 href 应提取站点内路径
        assert_eq!(href_to_site_path("http://host:5005/dav/a/"), "/dav/a/");
        assert_eq!(href_to_site_path("/dav/a/"), "/dav/a/");
    }

    #[test]
    fn test_parse_http_date() {
        let ms = parse_http_date("Wed, 21 Oct 2015 07:28:00 GMT").unwrap();
        assert_eq!(ms, 1445412480000);
        assert!(parse_http_date("garbage").is_none());
    }

    #[test]
    fn test_parse_propfind_response() {
        let xml = r#"<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/dav/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat>
  </d:response>
  <d:response>
    <d:href>/dav/%E5%B0%8F%E8%AF%B4/</d:href>
    <d:propstat><d:prop>
      <d:displayname>小说</d:displayname>
      <d:resourcetype><d:collection/></d:resourcetype>
      <d:getlastmodified>Wed, 21 Oct 2015 07:28:00 GMT</d:getlastmodified>
    </d:prop></d:propstat>
  </d:response>
  <d:response>
    <d:href>/dav/book%20one.txt</d:href>
    <d:propstat><d:prop>
      <d:getcontentlength>2048</d:getcontentlength>
      <d:getlastmodified>Wed, 21 Oct 2015 07:28:00 GMT</d:getlastmodified>
      <d:resourcetype/>
    </d:prop></d:propstat>
  </d:response>
</d:multistatus>"#;
        let entries = parse_propfind_response(xml).unwrap();
        assert_eq!(entries.len(), 3);
        // 根目录自身
        assert!(entries[0].is_dir && entries[0].path == "/dav/");
        // 目录：displayname 优先、mtime 已解析
        assert_eq!(entries[1].name, "小说");
        assert!(entries[1].is_dir);
        assert_eq!(entries[1].mtime, Some(1445412480000));
        // 文件：displayname 缺失退化为路径最后一段（已解码）、目录 size 为 None
        assert_eq!(entries[2].name, "book one.txt");
        assert!(!entries[2].is_dir);
        assert_eq!(entries[2].size, Some(2048));
    }

    #[tokio::test]
    async fn test_webdav_list_full_chain() {
        let xml = r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/dav/</D:href>
    <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/b.txt</D:href>
    <D:propstat><D:prop><D:getcontentlength>1</D:getcontentlength><D:resourcetype/></D:prop></D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/%E4%B8%AD%E6%96%87%E7%9B%AE%E5%BD%95/</D:href>
    <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/%23recycle/</D:href>
    <D:propstat><D:prop>
      <D:displayname>#recycle</D:displayname>
      <D:resourcetype><D:collection/></D:resourcetype>
    </D:prop></D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/a.txt</D:href>
    <D:propstat><D:prop><D:getcontentlength>2</D:getcontentlength><D:resourcetype/></D:prop></D:propstat>
  </D:response>
</D:multistatus>"#;
        let (base, rx) = spawn_mock_server(multistatus_response(xml));

        let entries = webdav_list(
            base,
            Some("user".to_string()),
            Some("pass".to_string()),
            "/dav".to_string(),
        )
        .await
        .unwrap();

        // 请求校验：方法 PROPFIND、Depth 1、Basic 认证头、路径已编码
        let request = rx.recv().unwrap();
        assert!(request.starts_with("PROPFIND /dav/ HTTP/1.1"));
        assert!(request.to_uppercase().contains("DEPTH: 1"));
        let expected_auth = format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode("user:pass")
        );
        assert!(request.contains(&expected_auth));

        // 结果校验：目录自身与群晖回收站目录（#recycle）被剔除、目录在前、按名称排序
        assert_eq!(entries.len(), 3);
        assert!(entries.iter().all(|e| e.name != "#recycle"));
        assert!(entries[0].is_dir);
        assert_eq!(entries[0].name, "中文目录");
        assert_eq!(entries[0].path, "/dav/中文目录/");
        assert_eq!(entries[1].name, "a.txt");
        assert_eq!(entries[2].name, "b.txt");
    }

    #[tokio::test]
    async fn test_webdav_list_unauthorized() {
        let (base, _rx) = spawn_mock_server(
            b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                .to_vec(),
        );
        let err = webdav_list(base, Some("u".into()), Some("bad".into()), "/".into())
            .await
            .unwrap_err();
        assert!(err.contains("认证失败"));
    }

    #[tokio::test]
    async fn test_download_to_file() {
        // 内容 256KB + 1 字节，跨进度节流边界
        let payload: Vec<u8> = (0..=PROGRESS_EMIT_INTERVAL)
            .map(|i| (i % 251) as u8)
            .collect();
        let (base, rx) = spawn_mock_server(file_response(&payload));

        let dir = std::env::temp_dir().join(format!("goread_nas_test_{}", std::process::id()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let target = dir.join("测试书籍.txt");

        let mut progress_calls = 0usize;
        let (downloaded, total) = download_to_file(
            &build_client().unwrap(),
            &format!("{}/dav/%E6%B5%8B%E8%AF%95%E4%B9%A6%E7%B1%8D.txt", base),
            None,
            None,
            &target,
            |_, _| progress_calls += 1,
        )
        .await
        .unwrap();

        // 请求行与目标路径编码正确
        let request = rx.recv().unwrap();
        assert!(request.starts_with("GET /dav/%E6%B5%8B%E8%AF%95%E4%B9%A6%E7%B1%8D.txt HTTP/1.1"));

        // 字节数与落盘内容一致
        assert_eq!(downloaded, payload.len() as u64);
        assert_eq!(total, Some(payload.len() as u64));
        let saved = tokio::fs::read(&target).await.unwrap();
        assert_eq!(saved, payload);

        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn test_download_not_found() {
        let (base, _rx) = spawn_mock_server(
            b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
        );
        let dir = std::env::temp_dir().join(format!("goread_nas_test_404_{}", std::process::id()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let target = dir.join("missing.txt");
        let result = download_to_file(
            &build_client().unwrap(),
            &format!("{}/missing.txt", base),
            None,
            None,
            &target,
            |_, _| {},
        )
        .await;
        assert!(result.unwrap_err().contains("404"));
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[test]
    fn test_nas_cache_hash() {
        // 确定性：同输入同输出、长度为 64 位十六进制
        let a = nas_cache_hash("conn1", "/books/a.epub");
        assert_eq!(a, nas_cache_hash("conn1", "/books/a.epub"));
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        // 身份隔离：连接或路径不同则键不同
        assert_ne!(a, nas_cache_hash("conn2", "/books/a.epub"));
        assert_ne!(a, nas_cache_hash("conn1", "/books/b.epub"));
    }

    #[tokio::test]
    async fn test_ensure_nas_book_record() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query(
            "CREATE TABLE books (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                file_path TEXT NOT NULL UNIQUE,
                cover_image TEXT,
                current_page INTEGER DEFAULT 1,
                total_pages INTEGER DEFAULT 1,
                last_read_time INTEGER,
                group_id INTEGER,
                position_in_group INTEGER,
                precise_progress REAL,
                theme TEXT,
                font_size INTEGER,
                reading_mode TEXT DEFAULT 'vertical',
                hide_divider INTEGER DEFAULT 0,
                created_at INTEGER DEFAULT (strftime('%s', 'now')),
                source TEXT,
                source_conn_id TEXT,
                source_path TEXT
            )",
        )
        .execute(&pool)
        .await
        .unwrap();

        let id1 = ensure_nas_book_record(&pool, "c1", "/books/a.epub", "C:/cache/1.epub", "A")
            .await
            .unwrap();
        // 同一身份幂等：返回同一记录
        let id1_again = ensure_nas_book_record(&pool, "c1", "/books/a.epub", "C:/cache/1.epub", "A")
            .await
            .unwrap();
        assert_eq!(id1, id1_again);
        // 不同远端路径建不同记录
        let id2 = ensure_nas_book_record(&pool, "c1", "/books/b.epub", "C:/cache/2.epub", "B")
            .await
            .unwrap();
        assert_ne!(id1, id2);
        // 记录内容：source 三元组已写入
        let row: (String, String, String) = sqlx::query_as(
            "SELECT source, source_conn_id, source_path FROM books WHERE id = ?",
        )
        .bind(id1)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row, ("nas".into(), "c1".into(), "/books/a.epub".into()));
    }

    #[test]
    fn test_cache_is_stale() {
        // 容差内（含相等）视为未过期：抵消 mtime 粒度与 HTTP 秒级时间戳误差
        assert!(!cache_is_stale(1000, 1000));
        assert!(!cache_is_stale(3000, 1000));
        // 超过容差 1ms 即判定过期（NAS 文件已更新）
        assert!(cache_is_stale(3001, 1000));
        // 远端更旧（时钟回拨/旧副本）不触发重新下载
        assert!(!cache_is_stale(999, 1000));
    }

    #[tokio::test]
    async fn test_probe_remote_mtime() {
        // 正常链路：HEAD 请求携带 Basic 认证头，Last-Modified 解析为毫秒时间戳
        let (base, rx) = spawn_mock_server(head_response(Some("Wed, 21 Oct 2015 07:28:00 GMT")));
        let state = probe_remote_mtime(
            &build_client().unwrap(),
            &format!("{}/dav/a.txt", base),
            Some("user"),
            Some("pass"),
        )
        .await;
        assert_eq!(state, RemoteMtime::Present(1445412480000));
        let request = rx.recv().unwrap();
        assert!(request.starts_with("HEAD /dav/a.txt HTTP/1.1"));
        let expected_auth = format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode("user:pass")
        );
        assert!(request.contains(&expected_auth));

        // 服务器未提供 Last-Modified 头：无法判定（离线优先沿用缓存）
        let (base, _rx) = spawn_mock_server(head_response(None));
        let state = probe_remote_mtime(
            &build_client().unwrap(),
            &format!("{}/a.txt", base),
            None,
            None,
        )
        .await;
        assert_eq!(state, RemoteMtime::Unknown);

        // 远端不存在（404）：明确判定文件已缺失（服务器端删除场景）
        let (base, _rx) = spawn_mock_server(
            b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
        );
        let state = probe_remote_mtime(
            &build_client().unwrap(),
            &format!("{}/missing.txt", base),
            None,
            None,
        )
        .await;
        assert_eq!(state, RemoteMtime::Missing);

        // 服务器内部错误（500）：无法判定，保持离线优先（不误删缓存）
        let (base, _rx) = spawn_mock_server(
            b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                .to_vec(),
        );
        let state = probe_remote_mtime(
            &build_client().unwrap(),
            &format!("{}/broken.txt", base),
            None,
            None,
        )
        .await;
        assert_eq!(state, RemoteMtime::Unknown);
    }
}

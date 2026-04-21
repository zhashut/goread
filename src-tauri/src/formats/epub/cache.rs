//! EPUB 缓存管理器
//! 负责将 EPUB 章节内容和资源持久化到磁盘

use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::fs;
use tokio::sync::RwLock;

/// 缓存根目录
fn epub_cache_root() -> PathBuf {
    if let Ok(dir) = std::env::var("GOREAD_EPUB_CACHE_ROOT") {
        if !dir.trim().is_empty() {
            return PathBuf::from(dir);
        }
    }
    let mut dir = std::env::temp_dir();
    dir.push("goread_cache");
    dir.push("epub");
    dir
}

fn epub_cache_root_legacy() -> PathBuf {
    let mut dir = std::env::temp_dir();
    dir.push("goread_cache");
    dir.push("epub");
    dir
}

/// 章节缓存目录
fn epub_section_cache_dir(book_hash: &str) -> PathBuf {
    let mut dir = epub_cache_root();
    dir.push("sections");
    dir.push(book_hash);
    dir
}

/// 资源缓存目录
fn epub_resource_cache_dir(book_hash: &str) -> PathBuf {
    let mut dir = epub_cache_root();
    dir.push("resources");
    dir.push(book_hash);
    dir
}

/// 元数据缓存目录
fn epub_metadata_cache_dir() -> PathBuf {
    let mut dir = epub_cache_root();
    dir.push("metadata");
    dir
}

/// 计算书籍 ID 的哈希值
fn compute_book_hash(book_id: &str) -> String {
    let mut hasher = DefaultHasher::new();
    book_id.hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

/// 计算资源路径的哈希值（用于文件名）
fn compute_resource_hash(resource_path: &str) -> String {
    let mut hasher = DefaultHasher::new();
    resource_path.hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

/// 章节缓存元数据
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SectionCacheMeta {
    pub book_id: String,
    pub section_index: u32,
    pub last_access_time: u64,
    pub size_bytes: usize,
    /// 样式表列表
    #[serde(default)]
    pub styles: Vec<String>,
    /// 资源引用列表
    #[serde(default)]
    pub resource_refs: Vec<String>,
}

/// 章节缓存数据（load_section 返回值）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SectionCacheData {
    /// HTML 内容
    pub html: String,
    /// 样式表列表
    pub styles: Vec<String>,
    /// 资源引用列表
    pub resource_refs: Vec<String>,
}

/// 资源缓存元数据
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResourceCacheMeta {
    pub book_id: String,
    pub resource_path: String,
    pub mime_type: String,
    pub last_access_time: u64,
    pub size_bytes: usize,
}

/// 书籍目录项（与前端 TocItem 对应）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TocItem {
    pub title: Option<String>,
    pub location: Option<String>,
    #[serde(default)]
    pub level: i32,
    #[serde(default)]
    pub children: Vec<TocItem>,
}

/// 书籍信息（与前端 BookInfo 对应）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BookInfo {
    pub title: Option<String>,
    pub author: Option<String>,
    pub description: Option<String>,
    pub publisher: Option<String>,
    pub language: Option<String>,
    pub page_count: i32,
    pub format: String,
    pub cover_image: Option<String>,
}

/// EPUB 元数据缓存条目
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetadataCacheEntry {
    pub book_id: String,
    pub book_info: BookInfo,
    pub toc: Vec<TocItem>,
    pub section_count: u32,
    pub spine: Vec<String>,
    pub last_access_time: u64,
    /// 缓存结构版本，用于在解析能力升级后主动淘汰旧缓存
    #[serde(default)]
    pub schema_version: u32,
}

/// 当前 EPUB 元数据缓存版本号。
/// 1：新增 EPUB3 nav.xhtml 目录解析能力；老版本（0）缓存若目录为空需要重建。
pub const EPUB_METADATA_SCHEMA_VERSION: u32 = 1;

/// 默认磁盘缓存上限（字节），前端未下发时的 fallback
const DEFAULT_DISK_CACHE_MAX_BYTES: usize = 256 * 1024 * 1024;

/// EPUB 缓存管理器
pub struct EpubCacheManager {
    /// 缓存有效期（天），0 表示不限
    expiry_days: Arc<AtomicU64>,
    /// 缓存大小统计
    total_size: Arc<RwLock<usize>>,
    /// 最大缓存大小（字节）
    max_size: usize,
}

impl EpubCacheManager {
    /// 创建新的缓存管理器
    pub fn new() -> Self {
        Self {
            expiry_days: Arc::new(AtomicU64::new(0)),
            total_size: Arc::new(RwLock::new(0)),
            max_size: DEFAULT_DISK_CACHE_MAX_BYTES,
        }
    }

    /// 设置最大缓存容量（字节），由前端下发
    pub fn set_max_size(&mut self, max_size_bytes: usize) {
        self.max_size = max_size_bytes;
    }

    /// 设置缓存有效期（天）
    pub fn set_expiry_days(&self, days: u64) {
        self.expiry_days.store(days, Ordering::Relaxed);
    }

    /// 获取当前时间戳（毫秒）
    fn now_millis() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }

    /// 检查缓存是否过期
    fn is_expired(&self, last_access_time: u64) -> bool {
        let days = self.expiry_days.load(Ordering::Relaxed);
        if days == 0 {
            return false; // 不限时间
        }
        let expiry_millis = days * 24 * 60 * 60 * 1000;
        let now = Self::now_millis();
        now.saturating_sub(last_access_time) > expiry_millis
    }

    /// 保存章节缓存到磁盘（包含完整的样式和资源引用信息）
    pub async fn save_section(
        &self,
        book_id: &str,
        section_index: u32,
        html_content: &str,
        styles: Vec<String>,
        resource_refs: Vec<String>,
    ) -> Result<(), String> {
        let book_hash = compute_book_hash(book_id);
        let cache_dir = epub_section_cache_dir(&book_hash);

        // 创建目录
        fs::create_dir_all(&cache_dir)
            .await
            .map_err(|e| format!("创建缓存目录失败: {}", e))?;

        // 保存 HTML 内容
        let html_path = cache_dir.join(format!("{}.html", section_index));
        fs::write(&html_path, html_content)
            .await
            .map_err(|e| format!("写入章节缓存失败: {}", e))?;

        // 保存元数据（包含样式和资源引用）
        let meta = SectionCacheMeta {
            book_id: book_id.to_string(),
            section_index,
            last_access_time: Self::now_millis(),
            size_bytes: html_content.len(),
            styles,
            resource_refs,
        };
        let meta_path = cache_dir.join(format!("{}.meta.json", section_index));
        let meta_json = serde_json::to_string(&meta).map_err(|e| format!("序列化元数据失败: {}", e))?;
        fs::write(&meta_path, meta_json)
            .await
            .map_err(|e| format!("写入元数据失败: {}", e))?;

        Ok(())
    }

    async fn read_section_entry_from_dir(
        &self,
        cache_dir: &PathBuf,
        section_index: u32,
    ) -> Result<Option<(SectionCacheMeta, String)>, String> {
        let html_path = cache_dir.join(format!("{}.html", section_index));
        let meta_path = cache_dir.join(format!("{}.meta.json", section_index));

        if !html_path.exists() || !meta_path.exists() {
            return Ok(None);
        }

        let meta_json = fs::read_to_string(&meta_path)
            .await
            .map_err(|e| format!("读取元数据失败: {}", e))?;
        let meta: SectionCacheMeta =
            serde_json::from_str(&meta_json).map_err(|e| format!("解析元数据失败: {}", e))?;

        if self.is_expired(meta.last_access_time) {
            let _ = fs::remove_file(&html_path).await;
            let _ = fs::remove_file(&meta_path).await;
            return Ok(None);
        }

        let html_content = fs::read_to_string(&html_path)
            .await
            .map_err(|e| format!("读取章节缓存失败: {}", e))?;

        Ok(Some((meta, html_content)))
    }

    /// 从磁盘加载章节缓存（返回完整的 HTML、样式和资源引用）
    pub async fn load_section(
        &self,
        book_id: &str,
        section_index: u32,
    ) -> Result<Option<SectionCacheData>, String> {
        let book_hash = compute_book_hash(book_id);
        let cache_dir = epub_section_cache_dir(&book_hash);

        if let Some((meta, html_content)) =
            self.read_section_entry_from_dir(&cache_dir, section_index).await?
        {
            let updated_meta = SectionCacheMeta {
                last_access_time: Self::now_millis(),
                ..meta.clone()
            };
            if let Ok(updated_meta_json) = serde_json::to_string(&updated_meta) {
                let meta_path = cache_dir.join(format!("{}.meta.json", section_index));
                let _ = fs::write(&meta_path, updated_meta_json).await;
            }

            return Ok(Some(SectionCacheData {
                html: html_content,
                styles: meta.styles,
                resource_refs: meta.resource_refs,
            }));
        }

        let legacy_cache_dir = {
            let mut dir = epub_cache_root_legacy();
            dir.push("sections");
            dir.push(&book_hash);
            dir
        };

        let legacy_loaded = match self
            .read_section_entry_from_dir(&legacy_cache_dir, section_index)
            .await
        {
            Ok(v) => v,
            Err(_) => None,
        };

        let Some((meta, html_content)) = legacy_loaded else {
            return Ok(None);
        };

        let updated_meta = SectionCacheMeta {
            last_access_time: Self::now_millis(),
            ..meta.clone()
        };
        let updated_meta_json =
            serde_json::to_string(&updated_meta).map_err(|e| format!("序列化元数据失败: {}", e))?;

        if legacy_cache_dir == cache_dir {
            let meta_path = cache_dir.join(format!("{}.meta.json", section_index));
            let _ = fs::write(&meta_path, updated_meta_json).await;

            return Ok(Some(SectionCacheData {
                html: html_content,
                styles: meta.styles,
                resource_refs: meta.resource_refs,
            }));
        }

        let _ = fs::create_dir_all(&cache_dir).await;

        let primary_html_path = cache_dir.join(format!("{}.html", section_index));
        let primary_meta_path = cache_dir.join(format!("{}.meta.json", section_index));
        let html_write_res = fs::write(&primary_html_path, &html_content).await;
        let meta_write_res = fs::write(&primary_meta_path, updated_meta_json).await;

        let legacy_html_path = legacy_cache_dir.join(format!("{}.html", section_index));
        let legacy_meta_path = legacy_cache_dir.join(format!("{}.meta.json", section_index));
        if html_write_res.is_ok() && meta_write_res.is_ok() {
            let _ = fs::remove_file(&legacy_html_path).await;
            let _ = fs::remove_file(&legacy_meta_path).await;
        }

        Ok(Some(SectionCacheData {
            html: html_content,
            styles: meta.styles,
            resource_refs: meta.resource_refs,
        }))
    }

    /// 保存资源缓存到磁盘
    pub async fn save_resource(
        &self,
        book_id: &str,
        resource_path: &str,
        data: &[u8],
        mime_type: &str,
    ) -> Result<(), String> {
        let book_hash = compute_book_hash(book_id);
        let cache_dir = epub_resource_cache_dir(&book_hash);
        let resource_hash = compute_resource_hash(resource_path);

        // 创建目录
        fs::create_dir_all(&cache_dir)
            .await
            .map_err(|e| format!("创建缓存目录失败: {}", e))?;

        // 保存资源数据
        let data_path = cache_dir.join(format!("{}.data", resource_hash));
        fs::write(&data_path, data)
            .await
            .map_err(|e| format!("写入资源缓存失败: {}", e))?;

        // 保存元数据
        let meta = ResourceCacheMeta {
            book_id: book_id.to_string(),
            resource_path: resource_path.to_string(),
            mime_type: mime_type.to_string(),
            last_access_time: Self::now_millis(),
            size_bytes: data.len(),
        };
        let meta_path = cache_dir.join(format!("{}.meta.json", resource_hash));
        let meta_json = serde_json::to_string(&meta).map_err(|e| format!("序列化元数据失败: {}", e))?;
        fs::write(&meta_path, meta_json)
            .await
            .map_err(|e| format!("写入元数据失败: {}", e))?;

        Ok(())
    }

    async fn read_resource_entry_from_dir(
        &self,
        cache_dir: &PathBuf,
        resource_hash: &str,
    ) -> Result<Option<(ResourceCacheMeta, Vec<u8>)>, String> {
        let data_path = cache_dir.join(format!("{}.data", resource_hash));
        let meta_path = cache_dir.join(format!("{}.meta.json", resource_hash));

        if !data_path.exists() || !meta_path.exists() {
            return Ok(None);
        }

        let meta_json = fs::read_to_string(&meta_path)
            .await
            .map_err(|e| format!("读取元数据失败: {}", e))?;
        let meta: ResourceCacheMeta =
            serde_json::from_str(&meta_json).map_err(|e| format!("解析元数据失败: {}", e))?;

        if self.is_expired(meta.last_access_time) {
            let _ = fs::remove_file(&data_path).await;
            let _ = fs::remove_file(&meta_path).await;
            return Ok(None);
        }

        let data = fs::read(&data_path)
            .await
            .map_err(|e| format!("读取资源缓存失败: {}", e))?;

        Ok(Some((meta, data)))
    }

    /// 从磁盘加载资源缓存
    pub async fn load_resource(
        &self,
        book_id: &str,
        resource_path: &str,
    ) -> Result<Option<(Vec<u8>, String)>, String> {
        let book_hash = compute_book_hash(book_id);
        let cache_dir = epub_resource_cache_dir(&book_hash);
        let resource_hash = compute_resource_hash(resource_path);

        if let Some((meta, data)) = self
            .read_resource_entry_from_dir(&cache_dir, &resource_hash)
            .await?
        {
            let mime_type = meta.mime_type.clone();
            let updated_meta = ResourceCacheMeta {
                last_access_time: Self::now_millis(),
                ..meta
            };
            if let Ok(updated_meta_json) = serde_json::to_string(&updated_meta) {
                let meta_path = cache_dir.join(format!("{}.meta.json", resource_hash));
                let _ = fs::write(&meta_path, updated_meta_json).await;
            }
            return Ok(Some((data, mime_type)));
        }

        let legacy_cache_dir = {
            let mut dir = epub_cache_root_legacy();
            dir.push("resources");
            dir.push(&book_hash);
            dir
        };

        let legacy_loaded = match self
            .read_resource_entry_from_dir(&legacy_cache_dir, &resource_hash)
            .await
        {
            Ok(v) => v,
            Err(_) => None,
        };

        let Some((meta, data)) = legacy_loaded else {
            return Ok(None);
        };

        let mime_type = meta.mime_type.clone();
        let updated_meta = ResourceCacheMeta {
            last_access_time: Self::now_millis(),
            ..meta
        };
        let updated_meta_json =
            serde_json::to_string(&updated_meta).map_err(|e| format!("序列化元数据失败: {}", e))?;

        if legacy_cache_dir == cache_dir {
            let meta_path = cache_dir.join(format!("{}.meta.json", resource_hash));
            let _ = fs::write(&meta_path, updated_meta_json).await;
            return Ok(Some((data, mime_type)));
        }

        let _ = fs::create_dir_all(&cache_dir).await;

        let primary_data_path = cache_dir.join(format!("{}.data", resource_hash));
        let primary_meta_path = cache_dir.join(format!("{}.meta.json", resource_hash));
        let data_write_res = fs::write(&primary_data_path, &data).await;
        let meta_write_res = fs::write(&primary_meta_path, updated_meta_json).await;

        let legacy_data_path = legacy_cache_dir.join(format!("{}.data", resource_hash));
        let legacy_meta_path = legacy_cache_dir.join(format!("{}.meta.json", resource_hash));
        if data_write_res.is_ok() && meta_write_res.is_ok() {
            let _ = fs::remove_file(&legacy_data_path).await;
            let _ = fs::remove_file(&legacy_meta_path).await;
        }

        Ok(Some((data, mime_type)))
    }

    /// 清理指定书籍的所有缓存（包括章节、资源、元数据）
    pub async fn clear_book_cache(&self, book_id: &str) -> Result<(), String> {
        let book_hash = compute_book_hash(book_id);

        // 清理章节缓存
        let section_dir = epub_section_cache_dir(&book_hash);
        if section_dir.exists() {
            let _ = fs::remove_dir_all(&section_dir).await;
        }

        // 清理资源缓存
        let resource_dir = epub_resource_cache_dir(&book_hash);
        if resource_dir.exists() {
            let _ = fs::remove_dir_all(&resource_dir).await;
        }

        // 清理元数据缓存
        let _ = self.delete_metadata(book_id).await;

        let legacy_section_dir = {
            let mut dir = epub_cache_root_legacy();
            dir.push("sections");
            dir.push(&book_hash);
            dir
        };
        if legacy_section_dir.exists() {
            let _ = fs::remove_dir_all(&legacy_section_dir).await;
        }

        let legacy_resource_dir = {
            let mut dir = epub_cache_root_legacy();
            dir.push("resources");
            dir.push(&book_hash);
            dir
        };
        if legacy_resource_dir.exists() {
            let _ = fs::remove_dir_all(&legacy_resource_dir).await;
        }

        let legacy_meta_path = {
            let mut dir = epub_cache_root_legacy();
            dir.push("metadata");
            dir.push(format!("{}.json", book_hash));
            dir
        };
        if legacy_meta_path.exists() {
            let _ = fs::remove_file(&legacy_meta_path).await;
        }

        Ok(())
    }

    /// 清理所有过期缓存（包括章节、资源、元数据）
    pub async fn cleanup_expired(&self) -> Result<usize, String> {
        let days = self.expiry_days.load(Ordering::Relaxed);
        if days == 0 {
            return Ok(0); // 不限时间，不清理
        }

        let mut cleaned_count = 0;

        // 清理章节缓存
        let sections_root = {
            let mut dir = epub_cache_root();
            dir.push("sections");
            dir
        };
        if sections_root.exists() {
            cleaned_count += self.cleanup_directory(&sections_root).await?;
        }

        // 清理资源缓存
        let resources_root = {
            let mut dir = epub_cache_root();
            dir.push("resources");
            dir
        };
        if resources_root.exists() {
            cleaned_count += self.cleanup_directory(&resources_root).await?;
        }

        // 清理元数据缓存
        cleaned_count += self.cleanup_expired_metadata().await?;

        Ok(cleaned_count)
    }

    /// 清理指定目录下的过期文件
    async fn cleanup_directory(&self, dir: &PathBuf) -> Result<usize, String> {
        let mut cleaned_count = 0;

        let mut entries = fs::read_dir(dir)
            .await
            .map_err(|e| format!("读取目录失败: {}", e))?;

        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|e| format!("读取目录项失败: {}", e))?
        {
            let path = entry.path();
            if path.is_dir() {
                // 递归清理子目录
                cleaned_count += Box::pin(self.cleanup_directory(&path)).await?;

                // 如果目录为空，删除它
                if let Ok(mut sub_entries) = fs::read_dir(&path).await {
                    if sub_entries.next_entry().await.ok().flatten().is_none() {
                        let _ = fs::remove_dir(&path).await;
                    }
                }
            } else if path.extension().map_or(false, |ext| ext == "json") {
                // 检查元数据文件
                if let Ok(meta_json) = fs::read_to_string(&path).await {
                    // 尝试解析为章节或资源元数据
                    let is_expired = if let Ok(meta) =
                        serde_json::from_str::<SectionCacheMeta>(&meta_json)
                    {
                        self.is_expired(meta.last_access_time)
                    } else if let Ok(meta) =
                        serde_json::from_str::<ResourceCacheMeta>(&meta_json)
                    {
                        self.is_expired(meta.last_access_time)
                    } else {
                        false
                    };

                    if is_expired {
                        // 删除元数据和对应的数据文件
                        let _ = fs::remove_file(&path).await;

                        // 删除对应的数据文件
                        let data_path = path.with_extension("html");
                        if data_path.exists() {
                            let _ = fs::remove_file(&data_path).await;
                            cleaned_count += 1;
                        }
                        let data_path = path.with_extension("data");
                        if data_path.exists() {
                            let _ = fs::remove_file(&data_path).await;
                            cleaned_count += 1;
                        }
                    }
                }
            }
        }

        Ok(cleaned_count)
    }

    /// 获取缓存统计信息
    pub async fn get_stats(&self) -> Result<CacheStats, String> {
        let mut total_size = 0usize;
        let mut section_count = 0usize;
        let mut resource_count = 0usize;

        // 统计章节缓存
        let sections_root = {
            let mut dir = epub_cache_root();
            dir.push("sections");
            dir
        };
        if sections_root.exists() {
            let (size, count) = self.count_directory(&sections_root).await?;
            total_size += size;
            section_count = count;
        }

        // 统计资源缓存
        let resources_root = {
            let mut dir = epub_cache_root();
            dir.push("resources");
            dir
        };
        if resources_root.exists() {
            let (size, count) = self.count_directory(&resources_root).await?;
            total_size += size;
            resource_count = count;
        }

        Ok(CacheStats {
            total_size,
            section_count,
            resource_count,
            max_size: self.max_size,
            expiry_days: self.expiry_days.load(Ordering::Relaxed),
        })
    }

    // ====================== 元数据缓存 ======================

    /// 保存书籍元数据到磁盘
    pub async fn save_metadata(
        &self,
        book_id: &str,
        book_info: BookInfo,
        toc: Vec<TocItem>,
        section_count: u32,
        spine: Vec<String>,
    ) -> Result<(), String> {
        let book_hash = compute_book_hash(book_id);
        let cache_dir = epub_metadata_cache_dir();

        // 创建目录
        fs::create_dir_all(&cache_dir)
            .await
            .map_err(|e| format!("创建元数据缓存目录失败: {}", e))?;

        let entry = MetadataCacheEntry {
            book_id: book_id.to_string(),
            book_info,
            toc,
            section_count,
            spine,
            last_access_time: Self::now_millis(),
            schema_version: EPUB_METADATA_SCHEMA_VERSION,
        };

        let meta_path = cache_dir.join(format!("{}.json", book_hash));
        let meta_json = serde_json::to_string(&entry)
            .map_err(|e| format!("序列化元数据失败: {}", e))?;
        fs::write(&meta_path, meta_json)
            .await
            .map_err(|e| format!("写入元数据缓存失败: {}", e))?;

        Ok(())
    }

    /// 从磁盘加载书籍元数据
    pub async fn load_metadata(
        &self,
        book_id: &str,
    ) -> Result<Option<MetadataCacheEntry>, String> {
        let book_hash = compute_book_hash(book_id);
        let cache_dir = epub_metadata_cache_dir();
        let meta_path = cache_dir.join(format!("{}.json", book_hash));

        if meta_path.exists() {
            let meta_json = fs::read_to_string(&meta_path)
                .await
                .map_err(|e| format!("读取元数据缓存失败: {}", e))?;
            let entry: MetadataCacheEntry = serde_json::from_str(&meta_json)
                .map_err(|e| format!("解析元数据缓存失败: {}", e))?;

            if self.is_expired(entry.last_access_time) {
                let _ = fs::remove_file(&meta_path).await;
                return Ok(None);
            }

            // 解析能力升级兜底：旧版本缓存且目录为空时主动淘汰，触发下次重建
            if entry.schema_version < EPUB_METADATA_SCHEMA_VERSION && entry.toc.is_empty() {
                let _ = fs::remove_file(&meta_path).await;
                return Ok(None);
            }

            let updated_entry = MetadataCacheEntry {
                last_access_time: Self::now_millis(),
                ..entry.clone()
            };
            let updated_json = serde_json::to_string(&updated_entry)
                .map_err(|e| format!("序列化元数据失败: {}", e))?;
            let _ = fs::write(&meta_path, updated_json).await;

            return Ok(Some(entry));
        }

        let legacy_meta_path = {
            let mut dir = epub_cache_root_legacy();
            dir.push("metadata");
            dir.push(format!("{}.json", book_hash));
            dir
        };

        let legacy_meta_json = match fs::read_to_string(&legacy_meta_path).await {
            Ok(v) => v,
            Err(_) => return Ok(None),
        };
        let entry: MetadataCacheEntry = match serde_json::from_str(&legacy_meta_json) {
            Ok(v) => v,
            Err(_) => return Ok(None),
        };

        if self.is_expired(entry.last_access_time) {
            let _ = fs::remove_file(&legacy_meta_path).await;
            return Ok(None);
        }

        // 与主分支保持一致：旧版本缓存 + 空目录直接淘汰
        if entry.schema_version < EPUB_METADATA_SCHEMA_VERSION && entry.toc.is_empty() {
            let _ = fs::remove_file(&legacy_meta_path).await;
            return Ok(None);
        }

        let updated_entry = MetadataCacheEntry {
            last_access_time: Self::now_millis(),
            ..entry.clone()
        };
        let updated_json = serde_json::to_string(&updated_entry)
            .map_err(|e| format!("序列化元数据失败: {}", e))?;

        if legacy_meta_path == meta_path {
            let _ = fs::write(&meta_path, updated_json).await;
            return Ok(Some(entry));
        }

        let _ = fs::create_dir_all(&cache_dir).await;
        let write_res = fs::write(&meta_path, updated_json).await;
        if write_res.is_ok() {
            let _ = fs::remove_file(&legacy_meta_path).await;
        }

        Ok(Some(entry))
    }

    /// 删除书籍元数据缓存
    pub async fn delete_metadata(&self, book_id: &str) -> Result<(), String> {
        let book_hash = compute_book_hash(book_id);
        let cache_dir = epub_metadata_cache_dir();
        let meta_path = cache_dir.join(format!("{}.json", book_hash));

        if meta_path.exists() {
            fs::remove_file(&meta_path)
                .await
                .map_err(|e| format!("删除元数据缓存失败: {}", e))?;
        }

        Ok(())
    }

    /// 提取逻辑 ID：book_id 中第一个 `#` 之前的部分
    /// 格式约定：`逻辑ID#内容指纹`；没有 `#` 时返回原字符串
    fn extract_logical_id(book_id: &str) -> &str {
        match book_id.find('#') {
            Some(idx) => &book_id[..idx],
            None => book_id,
        }
    }

    /// 清理与当前 book_id 共享同一逻辑 ID 但指纹不同的旧版本缓存
    /// 仅在 EPUB 缓存范围内工作，不会影响其他格式
    /// 返回清理掉的旧版本数量
    pub async fn prune_stale_versions(&self, current_book_id: &str) -> Result<usize, String> {
        let current_logical = Self::extract_logical_id(current_book_id);
        // 退化为不带内容指纹的旧版本 bookId（未启用新机制的场景）直接跳过，避免误删
        if current_logical == current_book_id {
            return Ok(0);
        }

        let mut stale_ids: Vec<String> = Vec::new();

        // 1) 从元数据目录读取所有 book_id，挑出同一逻辑 ID 但完整 ID 不同的
        let metadata_dir = epub_metadata_cache_dir();
        if metadata_dir.exists() {
            if let Ok(mut entries) = fs::read_dir(&metadata_dir).await {
                while let Some(entry) = entries.next_entry().await.ok().flatten() {
                    let path = entry.path();
                    if !path.extension().map_or(false, |ext| ext == "json") {
                        continue;
                    }
                    let Ok(meta_json) = fs::read_to_string(&path).await else {
                        continue;
                    };
                    let Ok(meta) = serde_json::from_str::<MetadataCacheEntry>(&meta_json) else {
                        continue;
                    };
                    let logical = Self::extract_logical_id(&meta.book_id);
                    if logical == current_logical && meta.book_id != current_book_id {
                        stale_ids.push(meta.book_id);
                    }
                }
            }
        }

        // 2) 扫描 sections / resources 目录中可能残留的孤儿 bookId
        //    依据目录内任意一个 *.meta.json 里的 book_id 字段回溯
        for subdir in ["sections", "resources"] {
            let mut root = epub_cache_root();
            root.push(subdir);
            if !root.exists() {
                continue;
            }
            let Ok(mut entries) = fs::read_dir(&root).await else {
                continue;
            };
            while let Some(entry) = entries.next_entry().await.ok().flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                if let Some(book_id) = Self::probe_book_id_in_dir(&path).await {
                    let logical = Self::extract_logical_id(&book_id);
                    if logical == current_logical
                        && book_id != current_book_id
                        && !stale_ids.contains(&book_id)
                    {
                        stale_ids.push(book_id);
                    }
                }
            }
        }

        let mut cleaned = 0usize;
        for stale_id in stale_ids {
            if self.clear_book_cache(&stale_id).await.is_ok() {
                cleaned += 1;
            }
        }

        Ok(cleaned)
    }

    /// 在章节/资源子目录中寻找任意一个 meta.json，读取其 book_id
    async fn probe_book_id_in_dir(dir: &PathBuf) -> Option<String> {
        let mut entries = fs::read_dir(dir).await.ok()?;
        while let Some(entry) = entries.next_entry().await.ok().flatten() {
            let path = entry.path();
            if path.extension().map_or(false, |ext| ext == "json") {
                let meta_json = fs::read_to_string(&path).await.ok()?;
                if let Ok(meta) = serde_json::from_str::<SectionCacheMeta>(&meta_json) {
                    return Some(meta.book_id);
                }
                if let Ok(meta) = serde_json::from_str::<ResourceCacheMeta>(&meta_json) {
                    return Some(meta.book_id);
                }
            }
        }
        None
    }

    /// 清理过期的元数据缓存
    pub async fn cleanup_expired_metadata(&self) -> Result<usize, String> {
        let days = self.expiry_days.load(Ordering::Relaxed);
        if days == 0 {
            return Ok(0); // 不限时间，不清理
        }

        let mut cleaned_count = 0;
        let cache_dir = epub_metadata_cache_dir();

        if !cache_dir.exists() {
            return Ok(0);
        }

        let mut entries = fs::read_dir(&cache_dir)
            .await
            .map_err(|e| format!("读取元数据目录失败: {}", e))?;

        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|e| format!("读取目录项失败: {}", e))?
        {
            let path = entry.path();
            if path.extension().map_or(false, |ext| ext == "json") {
                if let Ok(meta_json) = fs::read_to_string(&path).await {
                    if let Ok(meta) = serde_json::from_str::<MetadataCacheEntry>(&meta_json) {
                        if self.is_expired(meta.last_access_time) {
                            let _ = fs::remove_file(&path).await;
                            cleaned_count += 1;
                        }
                    }
                }
            }
        }

        Ok(cleaned_count)
    }

    /// 统计目录大小和文件数量
    async fn count_directory(&self, dir: &PathBuf) -> Result<(usize, usize), String> {
        let mut total_size = 0usize;
        let mut count = 0usize;

        let mut entries = match fs::read_dir(dir).await {
            Ok(entries) => entries,
            Err(_) => return Ok((0, 0)),
        };

        while let Some(entry) = entries.next_entry().await.ok().flatten() {
            let path = entry.path();
            if path.is_dir() {
                let (size, sub_count) = Box::pin(self.count_directory(&path)).await?;
                total_size += size;
                count += sub_count;
            } else if path.extension().map_or(false, |ext| ext == "html" || ext == "data") {
                if let Ok(metadata) = fs::metadata(&path).await {
                    total_size += metadata.len() as usize;
                    count += 1;
                }
            }
        }

        Ok((total_size, count))
    }
}

impl Clone for EpubCacheManager {
    fn clone(&self) -> Self {
        Self {
            expiry_days: Arc::clone(&self.expiry_days),
            total_size: Arc::clone(&self.total_size),
            max_size: self.max_size,
        }
    }
}

impl Default for EpubCacheManager {
    fn default() -> Self {
        Self::new()
    }
}

/// 缓存统计信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheStats {
    pub total_size: usize,
    pub section_count: usize,
    pub resource_count: usize,
    pub max_size: usize,
    pub expiry_days: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_section_cache() {
        let manager = EpubCacheManager::new();
        let book_id = "test_book_123";
        let section_index = 1;
        let html_content = "<html><body>Test content</body></html>";

        // 保存（添加空的 styles 和 resource_refs）
        manager
            .save_section(book_id, section_index, html_content, vec![], vec![])
            .await
            .unwrap();

        // 加载
        let loaded = manager.load_section(book_id, section_index).await.unwrap();
        assert!(loaded.is_some());
        assert_eq!(loaded.unwrap().html, html_content);

        // 清理
        manager.clear_book_cache(book_id).await.unwrap();

        // 验证已清理
        let loaded_after_clear = manager.load_section(book_id, section_index).await.unwrap();
        assert!(loaded_after_clear.is_none());
    }

    #[tokio::test]
    async fn test_resource_cache() {
        let manager = EpubCacheManager::new();
        let book_id = "test_book_456";
        let resource_path = "images/cover.jpg";
        let data = vec![0u8; 1000];
        let mime_type = "image/jpeg";

        // 保存
        manager
            .save_resource(book_id, resource_path, &data, mime_type)
            .await
            .unwrap();

        // 加载
        let loaded = manager.load_resource(book_id, resource_path).await.unwrap();
        assert!(loaded.is_some());
        let (loaded_data, loaded_mime) = loaded.unwrap();
        assert_eq!(loaded_data, data);
        assert_eq!(loaded_mime, mime_type);

        // 清理
        manager.clear_book_cache(book_id).await.unwrap();
    }
}

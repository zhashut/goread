use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::sync::RwLock;
use moka::future::Cache as MokaCache;
use crate::formats::{BookRenderCache, BoxFuture};
use crate::pdf::types::{CacheKey, RenderResult, PdfError};

const DEFAULT_MAX_CACHE_SIZE: usize = 256 * 1024 * 1024; // 256MB（按权重表示字节数）
const DEFAULT_MAX_CACHE_ITEMS: usize = 50; // 仅用于统计展示
const DEFAULT_CACHE_TIME_TO_IDLE_SECS: u64 = 24 * 60 * 60; // 一天内未访问的页面按默认策略过期

pub struct CacheManager {
    cache: MokaCache<CacheKey, RenderResult>,
    sizes: Arc<RwLock<HashMap<CacheKey, usize>>>,
    // 记录每个缓存项的最后访问时间，实现自定义空闲过期策略
    access_times: Arc<RwLock<HashMap<CacheKey, Instant>>>,
    max_size: usize,
    max_items: usize,
    // 逻辑空闲过期时间（秒），0 表示不限时间，仅按容量淘汰
    time_to_idle_secs: Arc<AtomicU64>,
}

impl CacheManager {
    pub fn new() -> Self {
        Self::with_limits(DEFAULT_MAX_CACHE_SIZE, DEFAULT_MAX_CACHE_ITEMS)
    }

    pub fn with_limits(max_size: usize, max_items: usize) -> Self {
        let cache = MokaCache::builder()
            .weigher(|_k: &CacheKey, v: &RenderResult| v.image_data.len() as u32)
            .max_capacity(max_size as u64)
            .build();
        Self {
            cache,
            sizes: Arc::new(RwLock::new(HashMap::new())),
            max_size,
            max_items,
            access_times: Arc::new(RwLock::new(HashMap::new())),
            time_to_idle_secs: Arc::new(AtomicU64::new(DEFAULT_CACHE_TIME_TO_IDLE_SECS)),
        }
    }

    pub async fn get(&self, key: &CacheKey) -> Option<RenderResult> {
        // 先检查逻辑空闲过期时间
        let ttl_secs = self.time_to_idle_secs.load(Ordering::Relaxed);
        if ttl_secs > 0 {
            let expired = {
                let times = self.access_times.read().await;
                if let Some(last) = times.get(key) {
                    last.elapsed().as_secs() > ttl_secs
                } else {
                    false
                }
            };
            if expired {
                // 过期时同步移除缓存记录
                let _ = self.remove(key).await;
                return None;
            }
        }

        let result = self.cache.get(key).await;
        if result.is_some() && ttl_secs > 0 {
            let mut times = self.access_times.write().await;
            times.insert(key.clone(), Instant::now());
        }
        result
    }

    pub async fn put(&self, key: CacheKey, data: RenderResult) -> Result<(), PdfError> {
        let size = data.image_data.len();
        self.cache.insert(key.clone(), data).await;
        let mut sizes = self.sizes.write().await;
        sizes.insert(key.clone(), size);
        let ttl_secs = self.time_to_idle_secs.load(Ordering::Relaxed);
        if ttl_secs > 0 {
            let mut times = self.access_times.write().await;
            times.insert(key, Instant::now());
        }
        Ok(())
    }

    pub async fn remove(&self, key: &CacheKey) -> Option<RenderResult> {
        let val = self.cache.get(key).await;
        self.cache.invalidate(key).await;
        let mut sizes = self.sizes.write().await;
        sizes.remove(key);
        let mut times = self.access_times.write().await;
        times.remove(key);
        val
    }

    pub async fn clear(&self) {
        self.cache.invalidate_all();
        let mut sizes = self.sizes.write().await;
        sizes.clear();
        let mut times = self.access_times.write().await;
        times.clear();
    }

    pub async fn clear_page(&self, file_path: &str, page_number: u32) {
        let keys: Vec<CacheKey> = {
            let sizes = self.sizes.read().await;
            sizes.keys().filter(|k| k.file_path == file_path && k.page_number == page_number).cloned().collect()
        };
        for k in keys.iter() {
            self.cache.invalidate(k).await;
        }
        let mut sizes = self.sizes.write().await;
        for k in keys.iter() {
            sizes.remove(k);
        }
        let mut times = self.access_times.write().await;
        for k in keys {
            times.remove(&k);
        }
    }

    pub async fn get_stats(&self) -> CacheStats {
        let sizes = self.sizes.read().await;
        let total_size: usize = sizes.values().copied().sum();
        CacheStats {
            item_count: sizes.len(),
            total_size,
            max_size: self.max_size,
            max_items: self.max_items,
            hit_rate: 0.0,
        }
    }

    pub async fn contains(&self, key: &CacheKey) -> bool {
        // get 不改变缓存内容，但会克隆；为避免克隆，这里使用 contains_key
        self.cache.contains_key(key)
    }

    pub async fn get_cached_pages(&self) -> Vec<u32> {
        let sizes = self.sizes.read().await;
        let mut pages: Vec<_> = sizes.keys().map(|k| k.page_number).collect();
        pages.sort_unstable();
        pages.dedup();
        pages
    }

    /// 动态更新逻辑空闲过期时间（秒），0 表示不限时间
    pub fn set_time_to_idle_secs(&self, secs: u64) {
        self.time_to_idle_secs.store(secs, Ordering::Relaxed);
    }

    pub fn set_max_size(&mut self, max_size: usize) {
        self.max_size = max_size;
        // 重新构建缓存容量（注意：这会丢失内部策略状态，但不影响功能）
        let new = MokaCache::builder()
            .weigher(|_k: &CacheKey, v: &RenderResult| v.image_data.len() as u32)
            .max_capacity(max_size as u64)
            .build();
        // 将旧缓存中可见的键值迁移（通过 sizes 表）
        let sizes = futures::executor::block_on(self.sizes.read());
        for (k, _) in sizes.iter() {
            if let Some(v) = futures::executor::block_on(self.cache.get(k)) {
                futures::executor::block_on(new.insert(k.clone(), v));
            }
        }
        drop(sizes);
        self.cache = new;
    }

    pub fn set_max_items(&mut self, max_items: usize) {
        self.max_items = max_items;
    }
}

impl Clone for CacheManager {
    fn clone(&self) -> Self {
        Self {
            cache: self.cache.clone(),
            sizes: Arc::clone(&self.sizes),
            access_times: Arc::clone(&self.access_times),
            max_size: self.max_size,
            max_items: self.max_items,
            time_to_idle_secs: Arc::clone(&self.time_to_idle_secs),
        }
    }
}

#[derive(Debug, Clone)]
pub struct CacheStats {
    pub item_count: usize,
    pub total_size: usize,
    pub max_size: usize,
    pub max_items: usize,
    pub hit_rate: f64,
}

/// PDF 渲染缓存管理器的统一接口实现，直接复用现有缓存逻辑
impl BookRenderCache for CacheManager {
    type Key = CacheKey;
    type Value = RenderResult;
    type Stats = CacheStats;
    type Error = PdfError;

    fn cache_get<'a>(&'a self, key: &'a Self::Key) -> BoxFuture<'a, Option<Self::Value>> {
        Box::pin(CacheManager::get(self, key))
    }

    fn cache_put<'a>(
        &'a self,
        key: Self::Key,
        value: Self::Value,
    ) -> BoxFuture<'a, Result<(), Self::Error>> {
        Box::pin(CacheManager::put(self, key, value))
    }

    fn cache_remove<'a>(&'a self, key: &'a Self::Key) -> BoxFuture<'a, Option<Self::Value>> {
        Box::pin(CacheManager::remove(self, key))
    }

    fn cache_clear_all<'a>(&'a self) -> BoxFuture<'a, ()> {
        Box::pin(CacheManager::clear(self))
    }

    fn cache_clear_page<'a>(&'a self, file_path: &'a str, page_number: u32) -> BoxFuture<'a, ()> {
        Box::pin(CacheManager::clear_page(self, file_path, page_number))
    }

    fn cache_stats<'a>(&'a self) -> BoxFuture<'a, Self::Stats> {
        Box::pin(CacheManager::get_stats(self))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pdf::types::{RenderQuality, ImageFormat};

    #[tokio::test]
    async fn test_cache_basic_operations() {
        let cache = CacheManager::with_limits(1024 * 1024, 10);
        
        let key = CacheKey::new(
            "test.pdf".to_string(),
            1,
            RenderQuality::Standard,
            800,
            600,
            "light".to_string(),
        );
        let data = RenderResult {
            image_data: vec![0u8; 1000],
            width: 800,
            height: 600,
            format: ImageFormat::Png,
        };

        // 测试插入
        cache.put(key.clone(), data.clone()).await.unwrap();
        
        // 测试获取
        let retrieved = cache.get(&key).await;
        assert!(retrieved.is_some());
        assert_eq!(retrieved.unwrap().width, 800);

        // 测试删除
        let removed = cache.remove(&key).await;
        assert!(removed.is_some());
        
        let retrieved_after_remove = cache.get(&key).await;
        assert!(retrieved_after_remove.is_none());
    }

    #[tokio::test]
    async fn test_cache_eviction() {
        let cache = CacheManager::with_limits(5000, 3);
        
        // 插入3个条目
        for i in 1..=3 {
            let key = CacheKey::new(
                "test.pdf".to_string(),
                i,
                RenderQuality::Standard,
                800,
                600,
                "light".to_string(),
            );
            let data = RenderResult {
                image_data: vec![0u8; 1000],
                width: 800,
                height: 600,
                format: ImageFormat::Png,
            };
            cache.put(key, data).await.unwrap();
        }

        // 访问第1个条目，增加其访问计数
        let key1 = CacheKey::new(
            "test.pdf".to_string(),
            1,
            RenderQuality::Standard,
            800,
            600,
            "light".to_string(),
        );
        cache.get(&key1).await;

        // 插入第4个条目，应该触发淘汰
        let key4 = CacheKey::new(
            "test.pdf".to_string(),
            4,
            RenderQuality::Standard,
            800,
            600,
            "light".to_string(),
        );
        let data4 = RenderResult {
            image_data: vec![0u8; 1000],
            width: 800,
            height: 600,
            format: ImageFormat::Png,
        };
        cache.put(key4, data4).await.unwrap();

        // 第1个条目应该还在（因为被访问过）
        assert!(cache.get(&key1).await.is_some());
    }
}

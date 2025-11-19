use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use crate::pdf::types::{CacheKey, RenderResult, PdfError};

const DEFAULT_MAX_CACHE_SIZE: usize = 100 * 1024 * 1024; // 100MB
const DEFAULT_MAX_CACHE_ITEMS: usize = 50;

#[derive(Debug)]
struct CacheEntry {
    data: RenderResult,
    size: usize,
    last_access: std::time::Instant,
    access_count: u32,
}

pub struct CacheManager {
    cache: Arc<RwLock<HashMap<CacheKey, CacheEntry>>>,
    max_size: usize,
    max_items: usize,
    current_size: Arc<RwLock<usize>>,
}

impl CacheManager {
    pub fn new() -> Self {
        Self::with_limits(DEFAULT_MAX_CACHE_SIZE, DEFAULT_MAX_CACHE_ITEMS)
    }

    pub fn with_limits(max_size: usize, max_items: usize) -> Self {
        Self {
            cache: Arc::new(RwLock::new(HashMap::new())),
            max_size,
            max_items,
            current_size: Arc::new(RwLock::new(0)),
        }
    }

    pub async fn get(&self, key: &CacheKey) -> Option<RenderResult> {
        let mut cache = self.cache.write().await;
        
        if let Some(entry) = cache.get_mut(key) {
            entry.last_access = std::time::Instant::now();
            entry.access_count += 1;
            Some(entry.data.clone())
        } else {
            None
        }
    }

    pub async fn put(&self, key: CacheKey, data: RenderResult) -> Result<(), PdfError> {
        let data_size = data.image_data.len();
        
        // 检查是否需要清理缓存
        self.ensure_space(data_size).await?;

        let mut cache = self.cache.write().await;
        let mut current_size = self.current_size.write().await;

        // 如果key已存在，先减去旧数据的大小
        if let Some(old_entry) = cache.get(&key) {
            *current_size -= old_entry.size;
        }

        let entry = CacheEntry {
            data,
            size: data_size,
            last_access: std::time::Instant::now(),
            access_count: 1,
        };

        cache.insert(key, entry);
        *current_size += data_size;

        Ok(())
    }

    async fn ensure_space(&self, required_size: usize) -> Result<(), PdfError> {
        let current_size = *self.current_size.read().await;
        let cache_len = self.cache.read().await.len();

        // 如果需要的空间超过最大缓存大小，返回错误
        if required_size > self.max_size {
            return Err(PdfError::CacheError {
                operation: "ensure_space".to_string(),
                message: format!("数据大小 {} 超过最大缓存限制 {}", required_size, self.max_size),
            });
        }

        // 如果当前大小加上需要的大小超过限制，或者项目数超过限制，进行清理
        if current_size + required_size > self.max_size || cache_len >= self.max_items {
            self.evict_entries(required_size).await?;
        }

        Ok(())
    }

    async fn evict_entries(&self, required_size: usize) -> Result<(), PdfError> {
        let mut cache = self.cache.write().await;
        let mut current_size = self.current_size.write().await;

        // 计算需要释放的空间
        let target_size = if *current_size + required_size > self.max_size {
            self.max_size - required_size - (self.max_size / 10) // 额外释放10%空间
        } else {
            *current_size
        };

        // 使用LRU策略：按最后访问时间和访问次数排序
        let mut entries: Vec<_> = cache.iter().map(|(k, v)| {
            let score = v.last_access.elapsed().as_secs() as f64 / (v.access_count as f64 + 1.0);
            (k.clone(), score)
        }).collect();

        // 按分数降序排序（分数越高越应该被淘汰）
        entries.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());

        // 删除条目直到满足大小要求或项目数要求
        let mut freed_size = 0;
        let mut removed_count = 0;

        for (key, _) in entries {
            if *current_size - freed_size <= target_size && cache.len() - removed_count < self.max_items {
                break;
            }

            if let Some(entry) = cache.remove(&key) {
                freed_size += entry.size;
                removed_count += 1;
            }
        }

        *current_size -= freed_size;

        Ok(())
    }

    pub async fn remove(&self, key: &CacheKey) -> Option<RenderResult> {
        let mut cache = self.cache.write().await;
        let mut current_size = self.current_size.write().await;

        if let Some(entry) = cache.remove(key) {
            *current_size -= entry.size;
            Some(entry.data)
        } else {
            None
        }
    }

    pub async fn clear(&self) {
        let mut cache = self.cache.write().await;
        let mut current_size = self.current_size.write().await;

        cache.clear();
        *current_size = 0;
    }

    pub async fn clear_page(&self, page_number: u32) {
        let mut cache = self.cache.write().await;
        let mut current_size = self.current_size.write().await;

        let keys_to_remove: Vec<_> = cache
            .keys()
            .filter(|k| k.page_number == page_number)
            .cloned()
            .collect();

        for key in keys_to_remove {
            if let Some(entry) = cache.remove(&key) {
                *current_size -= entry.size;
            }
        }
    }

    pub async fn get_stats(&self) -> CacheStats {
        let cache = self.cache.read().await;
        let current_size = *self.current_size.read().await;

        CacheStats {
            item_count: cache.len(),
            total_size: current_size,
            max_size: self.max_size,
            max_items: self.max_items,
            hit_rate: 0.0, // 可以通过跟踪命中/未命中来计算
        }
    }

    pub async fn contains(&self, key: &CacheKey) -> bool {
        let cache = self.cache.read().await;
        cache.contains_key(key)
    }

    pub async fn get_cached_pages(&self) -> Vec<u32> {
        let cache = self.cache.read().await;
        let mut pages: Vec<_> = cache.keys().map(|k| k.page_number).collect();
        pages.sort_unstable();
        pages.dedup();
        pages
    }

    pub fn set_max_size(&mut self, max_size: usize) {
        self.max_size = max_size;
    }

    pub fn set_max_items(&mut self, max_items: usize) {
        self.max_items = max_items;
    }
}

impl Clone for CacheManager {
    fn clone(&self) -> Self {
        Self {
            cache: Arc::clone(&self.cache),
            max_size: self.max_size,
            max_items: self.max_items,
            current_size: Arc::clone(&self.current_size),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pdf::types::{RenderQuality, ImageFormat};

    #[tokio::test]
    async fn test_cache_basic_operations() {
        let cache = CacheManager::with_limits(1024 * 1024, 10);
        
        let key = CacheKey::new(1, RenderQuality::Standard, 800, 600);
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
            let key = CacheKey::new(i, RenderQuality::Standard, 800, 600);
            let data = RenderResult {
                image_data: vec![0u8; 1000],
                width: 800,
                height: 600,
                format: ImageFormat::Png,
            };
            cache.put(key, data).await.unwrap();
        }

        // 访问第1个条目，增加其访问计数
        let key1 = CacheKey::new(1, RenderQuality::Standard, 800, 600);
        cache.get(&key1).await;

        // 插入第4个条目，应该触发淘汰
        let key4 = CacheKey::new(4, RenderQuality::Standard, 800, 600);
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
//! EPUB 格式引擎
//! 提供 EPUB 缓存持久化功能

pub mod cache;

pub use cache::{EpubCacheManager, CacheStats, MetadataCacheEntry, BookInfo, TocItem, SectionCacheData};

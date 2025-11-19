// 性能监控模块
// 用于收集和分析PDF渲染性能指标

use std::time::{Duration, Instant};
use std::collections::VecDeque;
use std::sync::Arc;
use tokio::sync::RwLock;
use serde::{Serialize, Deserialize};

/// 性能指标
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PerformanceMetrics {
    /// 平均渲染时间（毫秒）
    pub avg_render_time_ms: f64,
    /// 最小渲染时间（毫秒）
    pub min_render_time_ms: f64,
    /// 最大渲染时间（毫秒）
    pub max_render_time_ms: f64,
    /// 缓存命中率
    pub cache_hit_rate: f64,
    /// 总渲染次数
    pub total_renders: usize,
    /// 缓存命中次数
    pub cache_hits: usize,
    /// 缓存未命中次数
    pub cache_misses: usize,
    /// 当前内存使用（字节）
    pub memory_usage_bytes: usize,
    /// 最近渲染时间列表
    pub recent_render_times: Vec<f64>,
}

impl Default for PerformanceMetrics {
    fn default() -> Self {
        Self {
            avg_render_time_ms: 0.0,
            min_render_time_ms: f64::MAX,
            max_render_time_ms: 0.0,
            cache_hit_rate: 0.0,
            total_renders: 0,
            cache_hits: 0,
            cache_misses: 0,
            memory_usage_bytes: 0,
            recent_render_times: Vec::new(),
        }
    }
}

/// 性能监控器
pub struct PerformanceMonitor {
    metrics: Arc<RwLock<PerformanceMetrics>>,
    render_times: Arc<RwLock<VecDeque<Duration>>>,
    max_history: usize,
}

impl PerformanceMonitor {
    pub fn new() -> Self {
        Self {
            metrics: Arc::new(RwLock::new(PerformanceMetrics::default())),
            render_times: Arc::new(RwLock::new(VecDeque::new())),
            max_history: 100, // 保留最近100次渲染记录
        }
    }

    pub fn with_history_size(max_history: usize) -> Self {
        Self {
            metrics: Arc::new(RwLock::new(PerformanceMetrics::default())),
            render_times: Arc::new(RwLock::new(VecDeque::new())),
            max_history,
        }
    }

    /// 记录渲染时间
    pub async fn record_render_time(&self, duration: Duration) {
        let mut times = self.render_times.write().await;
        let mut metrics = self.metrics.write().await;

        // 添加新记录
        times.push_back(duration);
        if times.len() > self.max_history {
            times.pop_front();
        }

        // 更新指标
        metrics.total_renders += 1;
        let duration_ms = duration.as_secs_f64() * 1000.0;
        
        metrics.min_render_time_ms = metrics.min_render_time_ms.min(duration_ms);
        metrics.max_render_time_ms = metrics.max_render_time_ms.max(duration_ms);
        
        // 计算平均值
        let total_ms: f64 = times.iter().map(|d| d.as_secs_f64() * 1000.0).sum();
        metrics.avg_render_time_ms = total_ms / times.len() as f64;
        
        // 更新最近渲染时间
        metrics.recent_render_times = times.iter()
            .map(|d| d.as_secs_f64() * 1000.0)
            .collect();
    }

    /// 记录缓存命中
    pub async fn record_cache_hit(&self) {
        let mut metrics = self.metrics.write().await;
        metrics.cache_hits += 1;
        self.update_cache_hit_rate(&mut metrics);
    }

    /// 记录缓存未命中
    pub async fn record_cache_miss(&self) {
        let mut metrics = self.metrics.write().await;
        metrics.cache_misses += 1;
        self.update_cache_hit_rate(&mut metrics);
    }

    fn update_cache_hit_rate(&self, metrics: &mut PerformanceMetrics) {
        let total = metrics.cache_hits + metrics.cache_misses;
        if total > 0 {
            metrics.cache_hit_rate = metrics.cache_hits as f64 / total as f64;
        }
    }

    /// 更新内存使用
    pub async fn update_memory_usage(&self, bytes: usize) {
        let mut metrics = self.metrics.write().await;
        metrics.memory_usage_bytes = bytes;
    }

    /// 获取当前指标
    pub async fn get_metrics(&self) -> PerformanceMetrics {
        self.metrics.read().await.clone()
    }

    /// 重置指标
    pub async fn reset(&self) {
        let mut metrics = self.metrics.write().await;
        let mut times = self.render_times.write().await;
        
        *metrics = PerformanceMetrics::default();
        times.clear();
    }

    /// 获取性能报告
    pub async fn get_report(&self) -> PerformanceReport {
        let metrics = self.get_metrics().await;
        
        // 修复：metrics moved问题。先生成 recommendations，再构建 struct。
        // 或者克隆一份传给 recommendations。
        let recommendations = self.generate_recommendations(&metrics);

        PerformanceReport {
            metrics, // 这里 move metrics
            timestamp: chrono::Utc::now().to_rfc3339(),
            recommendations,
        }
    }

    fn generate_recommendations(&self, metrics: &PerformanceMetrics) -> Vec<String> {
        let mut recommendations = Vec::new();

        // 渲染性能建议
        if metrics.avg_render_time_ms > 200.0 {
            recommendations.push("平均渲染时间较长，建议降低渲染质量或优化PDF内容".to_string());
        }

        // 缓存命中率建议
        if metrics.cache_hit_rate < 0.5 && metrics.total_renders > 10 {
            recommendations.push("缓存命中率较低，建议增加缓存大小或优化预加载策略".to_string());
        }

        // 内存使用建议
        if metrics.memory_usage_bytes > 200 * 1024 * 1024 {
            recommendations.push("内存使用较高，建议清理缓存或减少预加载页面数".to_string());
        }

        // 性能波动建议
        if metrics.max_render_time_ms > metrics.avg_render_time_ms * 3.0 {
            recommendations.push("渲染时间波动较大，可能存在复杂页面，建议使用渐进式渲染".to_string());
        }

        if recommendations.is_empty() {
            recommendations.push("性能表现良好，无需优化".to_string());
        }

        recommendations
    }
}

impl Clone for PerformanceMonitor {
    fn clone(&self) -> Self {
        Self {
            metrics: Arc::clone(&self.metrics),
            render_times: Arc::clone(&self.render_times),
            max_history: self.max_history,
        }
    }
}

/// 性能报告
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PerformanceReport {
    pub metrics: PerformanceMetrics,
    pub timestamp: String,
    pub recommendations: Vec<String>,
}

/// 性能计时器
pub struct PerformanceTimer {
    start: Instant,
    monitor: Option<PerformanceMonitor>,
}

impl PerformanceTimer {
    pub fn new() -> Self {
        Self {
            start: Instant::now(),
            monitor: None,
        }
    }

    pub fn with_monitor(monitor: PerformanceMonitor) -> Self {
        Self {
            start: Instant::now(),
            monitor: Some(monitor),
        }
    }

    pub fn elapsed(&self) -> Duration {
        self.start.elapsed()
    }

    pub fn elapsed_ms(&self) -> f64 {
        self.elapsed().as_secs_f64() * 1000.0
    }

    pub async fn finish(self) -> Duration {
        let duration = self.elapsed();
        
        if let Some(monitor) = self.monitor {
            monitor.record_render_time(duration).await;
        }
        
        duration
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::time::sleep;

    #[tokio::test]
    async fn test_performance_monitor() {
        let monitor = PerformanceMonitor::new();

        // 记录几次渲染
        monitor.record_render_time(Duration::from_millis(50)).await;
        monitor.record_render_time(Duration::from_millis(100)).await;
        monitor.record_render_time(Duration::from_millis(75)).await;

        let metrics = monitor.get_metrics().await;
        assert_eq!(metrics.total_renders, 3);
        assert!(metrics.avg_render_time_ms > 0.0);
    }

    #[tokio::test]
    async fn test_cache_hit_rate() {
        let monitor = PerformanceMonitor::new();

        monitor.record_cache_hit().await;
        monitor.record_cache_hit().await;
        monitor.record_cache_miss().await;

        let metrics = monitor.get_metrics().await;
        assert_eq!(metrics.cache_hits, 2);
        assert_eq!(metrics.cache_misses, 1);
        assert!((metrics.cache_hit_rate - 0.666).abs() < 0.01);
    }

    #[tokio::test]
    async fn test_performance_timer() {
        let monitor = PerformanceMonitor::new();
        let timer = PerformanceTimer::with_monitor(monitor.clone());

        sleep(Duration::from_millis(10)).await;
        
        let duration = timer.finish().await;
        assert!(duration.as_millis() >= 10);

        let metrics = monitor.get_metrics().await;
        assert_eq!(metrics.total_renders, 1);
    }

    #[tokio::test]
    async fn test_performance_report() {
        let monitor = PerformanceMonitor::new();

        // 模拟一些性能数据
        for _ in 0..10 {
            monitor.record_render_time(Duration::from_millis(50)).await;
            monitor.record_cache_hit().await;
        }

        let report = monitor.get_report().await;
        assert!(!report.recommendations.is_empty());
        assert!(report.metrics.cache_hit_rate > 0.0);
    }
}
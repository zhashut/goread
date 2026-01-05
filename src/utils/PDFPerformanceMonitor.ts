/**
 * PDF性能监控工具
 * 用于收集和分析PDF阅读器的性能指标
 */

import { log } from '../services/index';

export interface PerformanceMetrics {
    renderTime: number; // 渲染时间（ms）
    cacheHit: boolean; // 是否命中缓存
    pageNumber: number; // 页码
    timestamp: number; // 时间戳
    scale: number; // 缩放比例
}

export class PDFPerformanceMonitor {
    private metrics: PerformanceMetrics[] = [];
    private maxMetrics: number = 100; // 最多保留100条记录

    /**
     * 记录渲染性能
     */
    recordRender(
        pageNumber: number,
        renderTime: number,
        cacheHit: boolean,
        scale: number = 1.0
    ): void {
        this.metrics.push({
            renderTime,
            cacheHit,
            pageNumber,
            timestamp: Date.now(),
            scale,
        });

        // 限制记录数量
        if (this.metrics.length > this.maxMetrics) {
            this.metrics.shift();
        }
    }

    /**
     * 获取统计信息
     */
    getStats(): {
        totalRenders: number;
        cacheHitRate: number;
        avgRenderTime: number;
        avgCacheHitTime: number;
        avgCacheMissTime: number;
    } {
        if (this.metrics.length === 0) {
            return {
                totalRenders: 0,
                cacheHitRate: 0,
                avgRenderTime: 0,
                avgCacheHitTime: 0,
                avgCacheMissTime: 0,
            };
        }

        const cacheHits = this.metrics.filter(m => m.cacheHit);
        const cacheMisses = this.metrics.filter(m => !m.cacheHit);

        const totalRenderTime = this.metrics.reduce((sum, m) => sum + m.renderTime, 0);
        const cacheHitTime = cacheHits.reduce((sum, m) => sum + m.renderTime, 0);
        const cacheMissTime = cacheMisses.reduce((sum, m) => sum + m.renderTime, 0);

        return {
            totalRenders: this.metrics.length,
            cacheHitRate: (cacheHits.length / this.metrics.length) * 100,
            avgRenderTime: totalRenderTime / this.metrics.length,
            avgCacheHitTime: cacheHits.length > 0 ? cacheHitTime / cacheHits.length : 0,
            avgCacheMissTime: cacheMisses.length > 0 ? cacheMissTime / cacheMisses.length : 0,
        };
    }

    /**
     * 打印性能报告
     */
    async printReport(): Promise<void> {
        const stats = this.getStats();

        await log('📊 PDF Performance Report', 'info');
        await log(`Total Renders: ${stats.totalRenders}`, 'info');
        await log(`Cache Hit Rate: ${stats.cacheHitRate.toFixed(2)}%`, 'info');
        await log(`Avg Render Time: ${stats.avgRenderTime.toFixed(2)}ms`, 'info');
        await log(`Avg Cache Hit Time: ${stats.avgCacheHitTime.toFixed(2)}ms`, 'info');
        await log(`Avg Cache Miss Time: ${stats.avgCacheMissTime.toFixed(2)}ms`, 'info');
        await log(`Performance Improvement: ${stats.avgCacheMissTime > 0
                ? ((1 - stats.avgCacheHitTime / stats.avgCacheMissTime) * 100).toFixed(2) + '%'
                : 'N/A'
            }`, 'info');
    }

    /**
     * 清空记录
     */
    clear(): void {
        this.metrics = [];
    }

    /**
     * 导出数据（用于分析）
     */
    export(): PerformanceMetrics[] {
        return [...this.metrics];
    }
}

// 创建全局实例（可选）
export const globalPDFMonitor = new PDFPerformanceMonitor();

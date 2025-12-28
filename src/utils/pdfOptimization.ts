/**
 * PDF优化工具集
 */

export { PageCacheManager, PdfPageCache } from './PageCacheManager';
export type { CachedPage } from './PageCacheManager';

export { ProgressiveRenderer } from './ProgressiveRenderer';
export type { ProgressiveRenderOptions } from './ProgressiveRenderer';

export { PagePreloader } from './PagePreloader';
export type { PreloadTask } from './PagePreloader';

export { PDFPerformanceMonitor, globalPDFMonitor } from './PDFPerformanceMonitor';
export type { PerformanceMetrics } from './PDFPerformanceMonitor';

export { WorkerPool } from './WorkerPool';

export { SmartPredictor } from './SmartPredictor';
export type { ReadingBehavior } from './SmartPredictor';

export { MemoryOptimizer } from './MemoryOptimizer';
export type { MemoryStats } from './MemoryOptimizer';

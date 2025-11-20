/**
 * 内存优化管理器
 * 监控和优化PDF阅读器的内存使用
 */

export interface MemoryStats {
    usedMemory: number; // 已使用内存（字节）
    totalMemory: number; // 总内存（字节）
    cacheSize: number; // 缓存大小（字节）
    canvasCount: number; // Canvas数量
}

export class MemoryOptimizer {
    private maxMemoryUsage: number; // 最大内存使用（字节）
    private canvasRefs: Set<HTMLCanvasElement> = new Set();
    private cleanupCallbacks: Array<() => void> = [];

    constructor(maxMemoryMB: number = 200) {
        this.maxMemoryUsage = maxMemoryMB * 1024 * 1024;
    }

    /**
     * 获取当前内存使用情况
     */
    getMemoryStats(): MemoryStats {
        let cacheSize = 0;

        // 估算canvas占用的内存
        this.canvasRefs.forEach(canvas => {
            if (canvas.width && canvas.height) {
                // 每个像素4字节（RGBA）
                cacheSize += canvas.width * canvas.height * 4;
            }
        });

        // 尝试获取系统内存信息（如果支持）
        const performance = (window.performance as any);
        const memory = performance.memory;

        return {
            usedMemory: memory?.usedJSHeapSize || 0,
            totalMemory: memory?.totalJSHeapSize || 0,
            cacheSize,
            canvasCount: this.canvasRefs.size,
        };
    }

    /**
     * 注册canvas以便跟踪
     */
    registerCanvas(canvas: HTMLCanvasElement): void {
        this.canvasRefs.add(canvas);
    }

    /**
     * 注销canvas
     */
    unregisterCanvas(canvas: HTMLCanvasElement): void {
        this.canvasRefs.delete(canvas);
        this.cleanupCanvas(canvas);
    }

    /**
     * 清理canvas
     */
    private cleanupCanvas(canvas: HTMLCanvasElement): void {
        try {
            const ctx = canvas.getContext('2d');
            if (ctx) {
                ctx.clearRect(0, 0, canvas.width, canvas.height);
            }
            // 重置canvas尺寸以释放内存
            canvas.width = 0;
            canvas.height = 0;
        } catch (error) {
            console.warn('Failed to cleanup canvas:', error);
        }
    }

    /**
     * 注册清理回调
     */
    registerCleanupCallback(callback: () => void): void {
        this.cleanupCallbacks.push(callback);
    }

    /**
     * 检查是否需要清理内存
     */
    shouldCleanup(): boolean {
        const stats = this.getMemoryStats();

        // 如果缓存大小超过限制
        if (stats.cacheSize > this.maxMemoryUsage) {
            return true;
        }

        // 如果系统内存使用率过高（如果支持）
        if (stats.totalMemory > 0) {
            const usageRatio = stats.usedMemory / stats.totalMemory;
            if (usageRatio > 0.9) {
                return true;
            }
        }

        return false;
    }

    /**
     * 执行内存清理
     */
    cleanup(): void {
        console.log('Performing memory cleanup...');

        // 执行所有注册的清理回调
        this.cleanupCallbacks.forEach(callback => {
            try {
                callback();
            } catch (error) {
                console.warn('Cleanup callback failed:', error);
            }
        });

        // 清理未使用的canvas
        const canvasesToRemove: HTMLCanvasElement[] = [];
        this.canvasRefs.forEach(canvas => {
            // 检查canvas是否还在DOM中
            if (!document.body.contains(canvas)) {
                canvasesToRemove.push(canvas);
            }
        });

        canvasesToRemove.forEach(canvas => {
            this.unregisterCanvas(canvas);
        });

        // 建议垃圾回收（如果支持）
        if ((window as any).gc) {
            try {
                (window as any).gc();
            } catch (e) {
                // Ignore
            }
        }

        console.log('Memory cleanup completed');
    }

    /**
     * 自动内存管理
     */
    startAutoCleanup(intervalMs: number = 30000): () => void {
        const intervalId = setInterval(() => {
            if (this.shouldCleanup()) {
                this.cleanup();
            }
        }, intervalMs);

        // 返回停止函数
        return () => clearInterval(intervalId);
    }

    /**
     * 优化canvas尺寸
     */
    optimizeCanvasSize(
        canvas: HTMLCanvasElement,
        targetWidth: number,
        targetHeight: number,
        maxSize: number = 2048
    ): { width: number; height: number; scale: number } {
        let width = targetWidth;
        let height = targetHeight;
        let scale = 1.0;

        // 如果尺寸超过最大限制，按比例缩小
        if (width > maxSize || height > maxSize) {
            const ratio = Math.min(maxSize / width, maxSize / height);
            width = Math.floor(width * ratio);
            height = Math.floor(height * ratio);
            scale = ratio;
        }

        return { width, height, scale };
    }

    /**
     * 创建优化的canvas
     */
    createOptimizedCanvas(
        width: number,
        height: number,
        maxSize: number = 2048
    ): { canvas: HTMLCanvasElement; scale: number } {
        const optimized = this.optimizeCanvasSize(
            document.createElement('canvas'),
            width,
            height,
            maxSize
        );

        const canvas = document.createElement('canvas');
        canvas.width = optimized.width;
        canvas.height = optimized.height;

        this.registerCanvas(canvas);

        return {
            canvas,
            scale: optimized.scale,
        };
    }

    /**
     * 使用ImageBitmap优化图像存储
     */
    async canvasToImageBitmap(canvas: HTMLCanvasElement): Promise<ImageBitmap | null> {
        if (typeof createImageBitmap === 'undefined') {
            return null;
        }

        try {
            const bitmap = await createImageBitmap(canvas);
            return bitmap;
        } catch (error) {
            console.warn('Failed to create ImageBitmap:', error);
            return null;
        }
    }

    /**
     * 从ImageBitmap绘制到canvas
     */
    drawImageBitmap(
        bitmap: ImageBitmap,
        canvas: HTMLCanvasElement
    ): void {
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        ctx.drawImage(bitmap, 0, 0);
    }

    /**
     * 清理所有资源
     */
    destroy(): void {
        this.canvasRefs.forEach(canvas => {
            this.cleanupCanvas(canvas);
        });
        this.canvasRefs.clear();
        this.cleanupCallbacks = [];
    }
}

/**
 * Worker池管理器
 * 用于管理多个Web Workers进行并行PDF页面渲染
 */

import { logError, log } from '../services/index';

export class WorkerPool {
    private workers: Worker[] = [];
    private workerCount: number;

    constructor(workerCount: number = navigator.hardwareConcurrency || 4) {
        this.workerCount = Math.min(workerCount, 8); // 最多8个worker
    }

    /**
     * 初始化Worker池
     */
    async initialize(): Promise<void> {
        // 注意：PDF.js的Worker是全局的，我们不需要创建多个Worker
        // 这里我们使用OffscreenCanvas来实现并行渲染
        await log(`WorkerPool initialized with ${this.workerCount} workers`, 'info');
    }

    /**
     * 并行渲染多个页面
     */
    async renderPages(
        pdf: any,
        pageNumbers: number[],
        scale: number = 1.0
    ): Promise<Map<number, HTMLCanvasElement>> {
        const results = new Map<number, HTMLCanvasElement>();

        // 使用Promise.all并行渲染（受限于并发数）
        const chunks = this.chunkArray(pageNumbers, this.workerCount);

        for (const chunk of chunks) {
            const promises = chunk.map(async (pageNum) => {
                try {
                    const page = await pdf.getPage(pageNum);
                    const viewport = page.getViewport({ scale });

                    // 创建canvas
                    const canvas = document.createElement('canvas');
                    canvas.width = viewport.width;
                    canvas.height = viewport.height;
                    const context = canvas.getContext('2d');

                    if (!context) {
                        throw new Error('Failed to get canvas context');
                    }

                    // 渲染页面
                    await page.render({
                        canvasContext: context,
                        viewport: viewport,
                    }).promise;

                    return { pageNum, canvas };
                } catch (error) {
                    logError(`渲染页面失败`, { pageNum, error: String(error) }).catch(() => {});
                    return null;
                }
            });

            const chunkResults = await Promise.all(promises);
            chunkResults.forEach(result => {
                if (result) {
                    results.set(result.pageNum, result.canvas);
                }
            });
        }

        return results;
    }

    /**
     * 渲染单个页面（使用OffscreenCanvas如果支持）
     */
    async renderPage(
        page: any,
        scale: number = 1.0
    ): Promise<HTMLCanvasElement> {
        const viewport = page.getViewport({ scale });

        // 检查是否支持OffscreenCanvas
        if (typeof OffscreenCanvas !== 'undefined') {
            try {
                const offscreen = new OffscreenCanvas(viewport.width, viewport.height);
                const context = offscreen.getContext('2d');

                if (context) {
                    await page.render({
                        canvasContext: context,
                        viewport: viewport,
                    }).promise;

                    // 转换为普通canvas
                    const canvas = document.createElement('canvas');
                    canvas.width = viewport.width;
                    canvas.height = viewport.height;
                    const ctx = canvas.getContext('2d');
                    if (ctx) {
                        const bitmap = await offscreen.transferToImageBitmap();
                        ctx.drawImage(bitmap, 0, 0);
                        bitmap.close();
                    }
                    return canvas;
                }
            } catch (error) {
                logError('OffscreenCanvas 渲染失败，降级为普通 canvas', { error: String(error) }).catch(() => {});
            }
        }

        // 降级到普通canvas
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const context = canvas.getContext('2d');

        if (!context) {
            throw new Error('Failed to get canvas context');
        }

        await page.render({
            canvasContext: context,
            viewport: viewport,
        }).promise;

        return canvas;
    }

    /**
     * 将数组分块
     */
    private chunkArray<T>(array: T[], chunkSize: number): T[][] {
        const chunks: T[][] = [];
        for (let i = 0; i < array.length; i += chunkSize) {
            chunks.push(array.slice(i, i + chunkSize));
        }
        return chunks;
    }

    /**
     * 销毁Worker池
     */
    destroy(): void {
        this.workers.forEach(worker => worker.terminate());
        this.workers = [];
    }
}

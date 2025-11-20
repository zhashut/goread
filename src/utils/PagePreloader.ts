/**
 * 页面预加载管理器
 * 智能预加载相邻页面，提升翻页体验
 */

export interface PreloadTask {
    pageNumber: number;
    priority: number; // 优先级：数字越小优先级越高
    scale: number;
}

export class PagePreloader {
    private preloadQueue: PreloadTask[];
    private isPreloading: boolean;
    private maxConcurrent: number; // 最大并发预加载数
    private currentTasks: Set<number>;

    constructor(maxConcurrent: number = 3) {
        this.preloadQueue = [];
        this.isPreloading = false;
        this.maxConcurrent = maxConcurrent;
        this.currentTasks = new Set();
    }

    /**
     * 添加预加载任务
     */
    addTask(pageNumber: number, priority: number = 5, scale: number = 1.0): void {
        // 检查是否已在队列中
        const exists = this.preloadQueue.some(task =>
            task.pageNumber === pageNumber && task.scale === scale
        );

        if (!exists && !this.currentTasks.has(pageNumber)) {
            this.preloadQueue.push({ pageNumber, priority, scale });
            // 按优先级排序（数字越小优先级越高）
            this.preloadQueue.sort((a, b) => a.priority - b.priority);
        }
    }

    /**
     * 批量添加预加载任务
     */
    addTasks(tasks: PreloadTask[]): void {
        tasks.forEach(task => this.addTask(task.pageNumber, task.priority, task.scale));
    }

    /**
     * 生成预加载任务列表（基于当前页）
     */
    generatePreloadTasks(
        currentPage: number,
        totalPages: number,
        readingMode: 'horizontal' | 'vertical',
        preloadRange: number = 2
    ): PreloadTask[] {
        const tasks: PreloadTask[] = [];

        if (readingMode === 'horizontal') {
            // 横向模式：优先预加载前后N页
            // 优先级：当前页后1页 > 当前页前1页 > 当前页后2页 > 当前页前2页...
            for (let offset = 1; offset <= preloadRange; offset++) {
                // 后面的页面（优先级更高，因为通常向后翻页）
                const nextPage = currentPage + offset;
                if (nextPage <= totalPages) {
                    tasks.push({
                        pageNumber: nextPage,
                        priority: offset,
                        scale: 1.0,
                    });
                }

                // 前面的页面
                const prevPage = currentPage - offset;
                if (prevPage >= 1) {
                    tasks.push({
                        pageNumber: prevPage,
                        priority: offset + 0.5, // 稍低优先级
                        scale: 1.0,
                    });
                }
            }
        } else {
            // 纵向模式：预加载下方更多页面（因为通常向下滚动）
            const forwardRange = preloadRange * 2; // 向下预加载更多
            const backwardRange = preloadRange; // 向上预加载较少

            for (let offset = 1; offset <= forwardRange; offset++) {
                const nextPage = currentPage + offset;
                if (nextPage <= totalPages) {
                    tasks.push({
                        pageNumber: nextPage,
                        priority: offset,
                        scale: 1.0,
                    });
                }
            }

            for (let offset = 1; offset <= backwardRange; offset++) {
                const prevPage = currentPage - offset;
                if (prevPage >= 1) {
                    tasks.push({
                        pageNumber: prevPage,
                        priority: forwardRange + offset,
                        scale: 1.0,
                    });
                }
            }
        }

        return tasks;
    }

    /**
     * 开始预加载
     */
    async startPreload(
        renderFunction: (pageNumber: number, scale: number) => Promise<void>
    ): Promise<void> {
        if (this.isPreloading) return;
        this.isPreloading = true;

        while (this.preloadQueue.length > 0) {
            // 控制并发数
            while (this.currentTasks.size < this.maxConcurrent && this.preloadQueue.length > 0) {
                const task = this.preloadQueue.shift();
                if (!task) break;

                this.currentTasks.add(task.pageNumber);

                // 异步执行渲染
                renderFunction(task.pageNumber, task.scale)
                    .catch(error => {
                        console.warn(`Preload page ${task.pageNumber} failed:`, error);
                    })
                    .finally(() => {
                        this.currentTasks.delete(task.pageNumber);
                    });
            }

            // 等待一些任务完成
            if (this.currentTasks.size >= this.maxConcurrent) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }

        // 等待所有任务完成
        while (this.currentTasks.size > 0) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }

        this.isPreloading = false;
    }

    /**
     * 清空预加载队列
     */
    clear(): void {
        this.preloadQueue = [];
    }

    /**
     * 停止预加载
     */
    stop(): void {
        this.isPreloading = false;
        this.clear();
    }

    /**
     * 获取队列状态
     */
    getStatus(): {
        queueLength: number;
        isPreloading: boolean;
        currentTasks: number;
    } {
        return {
            queueLength: this.preloadQueue.length,
            isPreloading: this.isPreloading,
            currentTasks: this.currentTasks.size,
        };
    }
}

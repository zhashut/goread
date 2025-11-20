/**
 * 智能阅读预测器
 * 根据用户的阅读行为（速度、方向、模式）智能预测并调整预加载策略
 */

export interface ReadingBehavior {
    direction: 'forward' | 'backward' | 'random';
    speed: 'slow' | 'medium' | 'fast';
    pattern: 'sequential' | 'jumping';
    avgTimePerPage: number; // 平均每页停留时间（毫秒）
}

export class SmartPredictor {
    private pageHistory: Array<{ page: number; timestamp: number }> = [];
    private maxHistorySize: number = 20;
    private lastPrediction: number[] = [];

    constructor() { }

    /**
     * 记录页面访问
     */
    recordPageVisit(pageNumber: number): void {
        const now = Date.now();
        this.pageHistory.push({ page: pageNumber, timestamp: now });

        // 限制历史记录大小
        if (this.pageHistory.length > this.maxHistorySize) {
            this.pageHistory.shift();
        }
    }

    /**
     * 分析阅读行为
     */
    analyzeReadingBehavior(): ReadingBehavior {
        if (this.pageHistory.length < 2) {
            return {
                direction: 'forward',
                speed: 'medium',
                pattern: 'sequential',
                avgTimePerPage: 5000,
            };
        }

        // 分析方向
        let forwardCount = 0;
        let backwardCount = 0;
        let jumpCount = 0;

        for (let i = 1; i < this.pageHistory.length; i++) {
            const diff = this.pageHistory[i].page - this.pageHistory[i - 1].page;
            if (diff === 1) {
                forwardCount++;
            } else if (diff === -1) {
                backwardCount++;
            } else if (Math.abs(diff) > 1) {
                jumpCount++;
            }
        }

        const direction =
            forwardCount > backwardCount ? 'forward' : backwardCount > forwardCount ? 'backward' : 'random';
        const pattern = jumpCount > this.pageHistory.length * 0.3 ? 'jumping' : 'sequential';

        // 分析速度（基于最近5次翻页的平均时间）
        const recentHistory = this.pageHistory.slice(-6);
        let totalTime = 0;
        let validIntervals = 0;

        for (let i = 1; i < recentHistory.length; i++) {
            const timeDiff = recentHistory[i].timestamp - recentHistory[i - 1].timestamp;
            // 只统计合理的时间间隔（100ms - 60s）
            if (timeDiff > 100 && timeDiff < 60000) {
                totalTime += timeDiff;
                validIntervals++;
            }
        }

        const avgTimePerPage = validIntervals > 0 ? totalTime / validIntervals : 5000;

        let speed: 'slow' | 'medium' | 'fast';
        if (avgTimePerPage < 2000) {
            speed = 'fast';
        } else if (avgTimePerPage < 5000) {
            speed = 'medium';
        } else {
            speed = 'slow';
        }

        return {
            direction,
            speed,
            pattern,
            avgTimePerPage,
        };
    }

    /**
     * 预测下一步可能访问的页面
     */
    predictNextPages(
        currentPage: number,
        totalPages: number,
        readingMode: 'horizontal' | 'vertical'
    ): number[] {
        const behavior = this.analyzeReadingBehavior();
        const predictions: number[] = [];

        // 基础预加载范围
        let baseRange = 2;

        // 根据阅读速度调整范围
        if (behavior.speed === 'fast') {
            baseRange = 4; // 快速阅读，预加载更多
        } else if (behavior.speed === 'slow') {
            baseRange = 2; // 慢速阅读，预加载较少
        } else {
            baseRange = 3; // 中速阅读
        }

        // 根据阅读模式调整
        if (readingMode === 'vertical') {
            baseRange = Math.ceil(baseRange * 1.5); // 纵向模式预加载更多
        }

        // 根据阅读方向生成预测
        if (behavior.direction === 'forward') {
            // 向前阅读：优先预加载后面的页面
            for (let i = 1; i <= baseRange * 2; i++) {
                const nextPage = currentPage + i;
                if (nextPage <= totalPages) {
                    predictions.push(nextPage);
                }
            }
            // 少量预加载前面的页面
            for (let i = 1; i <= Math.ceil(baseRange / 2); i++) {
                const prevPage = currentPage - i;
                if (prevPage >= 1) {
                    predictions.push(prevPage);
                }
            }
        } else if (behavior.direction === 'backward') {
            // 向后阅读：优先预加载前面的页面
            for (let i = 1; i <= baseRange * 2; i++) {
                const prevPage = currentPage - i;
                if (prevPage >= 1) {
                    predictions.push(prevPage);
                }
            }
            // 少量预加载后面的页面
            for (let i = 1; i <= Math.ceil(baseRange / 2); i++) {
                const nextPage = currentPage + i;
                if (nextPage <= totalPages) {
                    predictions.push(nextPage);
                }
            }
        } else {
            // 随机阅读：均衡预加载前后页面
            for (let i = 1; i <= baseRange; i++) {
                const nextPage = currentPage + i;
                const prevPage = currentPage - i;
                if (nextPage <= totalPages) {
                    predictions.push(nextPage);
                }
                if (prevPage >= 1) {
                    predictions.push(prevPage);
                }
            }
        }

        // 如果是跳跃模式，额外预加载一些常见的跳跃目标
        if (behavior.pattern === 'jumping') {
            // 预加载章节起始页（假设每10页是一个章节）
            const chapterSize = 10;
            const nextChapter = Math.ceil(currentPage / chapterSize) * chapterSize + 1;
            if (nextChapter <= totalPages && !predictions.includes(nextChapter)) {
                predictions.push(nextChapter);
            }
        }

        this.lastPrediction = predictions;
        return predictions;
    }

    /**
     * 获取预加载优先级
     */
    getPriority(pageNumber: number, currentPage: number, behavior: ReadingBehavior): number {
        const distance = Math.abs(pageNumber - currentPage);
        let priority = distance;

        // 根据方向调整优先级
        if (behavior.direction === 'forward' && pageNumber > currentPage) {
            priority *= 0.8; // 提高优先级
        } else if (behavior.direction === 'backward' && pageNumber < currentPage) {
            priority *= 0.8; // 提高优先级
        }

        // 根据速度调整优先级
        if (behavior.speed === 'fast') {
            priority *= 0.9; // 快速阅读时提高所有预加载的优先级
        }

        return priority;
    }

    /**
     * 清空历史记录
     */
    clear(): void {
        this.pageHistory = [];
        this.lastPrediction = [];
    }

    /**
     * 获取统计信息
     */
    getStats(): {
        historySize: number;
        behavior: ReadingBehavior;
        lastPrediction: number[];
    } {
        return {
            historySize: this.pageHistory.length,
            behavior: this.analyzeReadingBehavior(),
            lastPrediction: this.lastPrediction,
        };
    }
}

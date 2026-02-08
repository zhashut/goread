/**
 * TXT 书籍预加载器
 * 在用户点击书籍准备进入阅读页时，提前触发元数据加载
 * 利用页面切换动画的时间完成目录解析，减少进入阅读页的等待时间
 */

import { log, logError, getInvoke } from '../../index';
import { txtCacheService, TxtBookMeta, TxtChapterContent } from './txtCacheService';

/** 预加载任务状态 */
interface PreloadTask {
    bookId: string;
    filePath: string;
    promise: Promise<TxtBookMeta>;
    createdAt: number;
}

/**
 * 从文件路径生成书籍 ID
 */
export function generateTxtBookId(filePath: string): string {
    // 使用文件路径的哈希作为 ID
    let hash = 0;
    for (let i = 0; i < filePath.length; i++) {
        const char = filePath.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // 转换为 32 位整数
    }
    return `txt_${Math.abs(hash).toString(36)}`;
}

/**
 * 判断文件是否为 TXT 格式
 */
export function isTxtFile(filePath: string): boolean {
    return filePath.toLowerCase().endsWith('.txt');
}

/**
 * TXT 预加载器类（单例）
 */
class TxtPreloader {
    // 正在进行的预加载任务
    private _pendingTasks = new Map<string, PreloadTask>();

    /**
     * 触发预加载（不等待结果）
     */
    preload(filePath: string): void {
        const bookId = generateTxtBookId(filePath);

        // 如果已有缓存，跳过
        if (txtCacheService.hasMetadata(bookId)) {
            logError(`[TxtPreloader] 元数据已缓存，跳过预加载: ${filePath}`).catch(() => { });
            return;
        }

        // 如果正在加载，跳过
        if (this._pendingTasks.has(bookId)) {
            logError(`[TxtPreloader] 正在预加载中，跳过: ${filePath}`).catch(() => { });
            return;
        }

        logError(`[TxtPreloader] 开始预加载: ${filePath}`).catch(() => { });

        // 创建预加载任务
        const promise = this._loadMetadata(filePath, bookId);

        const task: PreloadTask = {
            bookId,
            filePath,
            promise,
            createdAt: Date.now(),
        };

        this._pendingTasks.set(bookId, task);

        // 任务完成后清理
        promise
            .then(() => {
                this._pendingTasks.delete(bookId);
            })
            .catch(() => {
                this._pendingTasks.delete(bookId);
            });
    }

    /**
     * 获取预加载的元数据（等待完成）
     */
    async get(filePath: string): Promise<TxtBookMeta | null> {
        const bookId = generateTxtBookId(filePath);

        // 检查缓存
        const cached = txtCacheService.getMetadata(bookId);
        if (cached) {
            logError(`[TxtPreloader] 元数据缓存命中: ${filePath}`).catch(() => { });
            return cached;
        }

        // 检查是否有正在进行的任务
        const task = this._pendingTasks.get(bookId);
        if (task) {
            logError(`[TxtPreloader] 等待预加载完成: ${filePath}`).catch(() => { });
            try {
                return await task.promise;
            } catch {
                return null;
            }
        }

        // 如果没有缓存也没有正在加载，返回 null
        return null;
    }

    /**
     * 获取或加载元数据
     */
    async getOrLoad(filePath: string): Promise<TxtBookMeta> {
        const bookId = generateTxtBookId(filePath);

        // 检查缓存
        const cached = txtCacheService.getMetadata(bookId);
        if (cached) {
            return cached;
        }

        // 检查是否有正在进行的任务
        const task = this._pendingTasks.get(bookId);
        if (task) {
            return await task.promise;
        }

        // 否则加载
        return await this._loadMetadata(filePath, bookId);
    }

    /**
     * 预加载章节（在进入阅读页后调用）
     */
    async preloadChapters(
        filePath: string,
        centerIndex: number,
        totalChapters: number
    ): Promise<void> {
        const bookId = generateTxtBookId(filePath);
        const config = txtCacheService.getConfig();
        const baseRange = config.preloadRange;
        const range = totalChapters > 800 ? Math.min(baseRange, 2) : baseRange;

        // 计算预加载范围
        const startIndex = Math.max(0, centerIndex - range);
        const endIndex = Math.min(totalChapters - 1, centerIndex + range);

        // 收集需要加载的章节
        const toLoad: number[] = [];
        for (let i = startIndex; i <= endIndex; i++) {
            if (!txtCacheService.hasChapter(bookId, i)) {
                toLoad.push(i);
            }
        }

        if (toLoad.length === 0) {
            logError(`[TxtPreloader] 所有章节已缓存，跳过预加载`).catch(() => { });
            return;
        }

        logError(`[TxtPreloader] 预加载章节: ${toLoad.join(', ')}`).catch(() => { });

        try {
            const invoke = await getInvoke();
            const chapters = await invoke<TxtChapterContent[]>('txt_load_chapter', {
                filePath,
                chapterIndex: centerIndex,
                extraChapters: toLoad.filter(i => i !== centerIndex),
            });

            // 存入缓存
            txtCacheService.setChapters(bookId, chapters);

            logError(`[TxtPreloader] 章节预加载完成: ${chapters.length} 章`).catch(() => { });
        } catch (e) {
            logError(`[TxtPreloader] 章节预加载失败: ${e}`).catch(() => { });
        }
    }

    /**
     * 检查是否有预加载缓存
     */
    has(filePath: string): boolean {
        const bookId = generateTxtBookId(filePath);
        return txtCacheService.hasMetadata(bookId) || this._pendingTasks.has(bookId);
    }

    /**
     * 清除指定文件的预加载缓存
     */
    clear(filePath: string): void {
        const bookId = generateTxtBookId(filePath);
        txtCacheService.clearBook(bookId);
        this._pendingTasks.delete(bookId);
    }

    /**
     * 清除所有预加载缓存
     */
    clearAll(): void {
        txtCacheService.clearAll();
        this._pendingTasks.clear();
    }

    /**
     * 内部方法：加载元数据
     */
    private async _loadMetadata(filePath: string, bookId: string): Promise<TxtBookMeta> {
        const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
        try {
            const invoke = await getInvoke();
            const meta = await invoke<TxtBookMeta>('txt_load_metadata', { filePath });

            // 存入缓存
            txtCacheService.setMetadata(bookId, meta);

            const end = typeof performance !== 'undefined' ? performance.now() : Date.now();
            const elapsedMs = Math.round(end - start);
            log("[TxtPreloader] 预热完成", "info", {
                filePath,
                bookId,
                chapters: meta.chapters.length,
                totalChars: meta.total_chars,
                totalBytes: meta.total_bytes,
                elapsedMs,
            }).catch(() => { });
            return meta;
        } catch (e) {
            const end = typeof performance !== 'undefined' ? performance.now() : Date.now();
            const elapsedMs = Math.round(end - start);
            logError("[TxtPreloader] 元数据加载失败", {
                filePath,
                elapsedMs,
                error: String(e),
            }).catch(() => { });
            throw e;
        }
    }
}

// 导出单例实例
export const txtPreloader = new TxtPreloader();

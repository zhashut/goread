/**
 * 分块文件读取工具
 * 用于读取大文件避免 OOM
 */

import { invoke } from '@tauri-apps/api/core';
import { logError } from '../services/index';

/** 分块读取选项 */
interface ChunkedReadOptions {
    /** 文件路径 */
    filePath: string;
    /** 每块大小（字节），默认 2MB */
    chunkSize?: number;
    /** 进度回调 */
    onProgress?: (percent: number, bytesRead: number) => void;
    /** 日志前缀 */
    logPrefix?: string;
}

/** 分块读取结果 */
interface ChunkedReadResult {
    /** 文件内容 */
    arrayBuffer: ArrayBuffer;
    /** 文件总字节数 */
    totalBytes: number;
}

/**
 * Base64 解码为 Uint8Array
 * 比 atob + charCodeAt 更高效
 */
function base64ToUint8Array(base64: string): Uint8Array {
    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

/**
 * 分块读取文件
 * 使用 Tauri Channel 流式传输数据，避免大文件 OOM
 */
export async function readFileChunked(options: ChunkedReadOptions): Promise<ChunkedReadResult> {
    const { filePath, chunkSize = 2 * 1024 * 1024, onProgress, logPrefix = '[ChunkedReader]' } = options;

    const { Channel } = await import('@tauri-apps/api/core');

    // 获取文件大小
    let fileSize = 0;
    try {
        const stats = await invoke<{ size: number }>('get_file_stats', { path: filePath });
        fileSize = stats.size;
        logError(`${logPrefix} 文件大小: ${(fileSize / 1024 / 1024).toFixed(1)}MB`).catch(() => { });
    } catch {
        // 获取失败，继续
    }

    const startTime = Date.now();
    const binaryChunks: Uint8Array[] = [];
    let receivedBytes = 0;
    let lastProgressLog = 0;

    const channel = new Channel<string>();
    channel.onmessage = (base64Chunk: string) => {
        // 优化 Base64 解码，减少中间对象创建
        const bytes = base64ToUint8Array(base64Chunk);
        binaryChunks.push(bytes);
        receivedBytes += bytes.length;

        // 进度回调和日志
        if (fileSize > 0) {
            const progress = Math.floor((receivedBytes / fileSize) * 100);
            if (progress - lastProgressLog >= 5) {
                lastProgressLog = progress;
                logError(`${logPrefix} 读取进度: ${progress}% (${(receivedBytes / 1024 / 1024).toFixed(1)}MB)`).catch(() => { });
                if (onProgress) {
                    onProgress(progress, receivedBytes);
                }
            }
        }
    };

    const reportedBytes = await invoke<number>('read_file_chunked', {
        path: filePath,
        chunkSize,
        onChunk: channel,
    });

    // 等待所有 Channel 消息处理完成（最多 5 秒）
    const expectedChunks = Math.ceil(reportedBytes / chunkSize);
    let waitCount = 0;
    while (binaryChunks.length < expectedChunks && waitCount < 50) {
        await new Promise(r => setTimeout(r, 100));
        waitCount++;
    }

    logError(`${logPrefix} 文件读取完成，耗时: ${Date.now() - startTime}ms，预期 ${expectedChunks} 块，收到 ${binaryChunks.length} 块，共 ${(receivedBytes / 1024 / 1024).toFixed(1)}MB`).catch(() => { });

    // 验证数据完整性
    if (Math.abs(receivedBytes - reportedBytes) > 1024 * 1024) {
        logError(`${logPrefix} 警告：数据可能不完整，后端报告 ${(reportedBytes / 1024 / 1024).toFixed(1)}MB，实际接收 ${(receivedBytes / 1024 / 1024).toFixed(1)}MB`).catch(() => { });
    }

    // 使用流式合并，避免 Blob 中间对象
    // 计算总长度并预分配内存
    const mergeStart = Date.now();
    const totalLength = binaryChunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const result = new Uint8Array(totalLength);

    // 流式复制，避免 Blob 中间对象
    let offset = 0;
    for (let i = 0; i < binaryChunks.length; i++) {
        result.set(binaryChunks[i], offset);
        offset += binaryChunks[i].length;
        // 立即释放引用，帮助 GC
        (binaryChunks as any)[i] = null;
    }
    // 清空数组引用
    binaryChunks.length = 0;

    logError(`${logPrefix} 数据合并完成，耗时: ${Date.now() - mergeStart}ms，文件大小: ${(totalLength / 1024 / 1024).toFixed(1)}MB`).catch(() => { });

    return {
        arrayBuffer: result.buffer,
        totalBytes: totalLength,
    };
}

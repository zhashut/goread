import { getInvoke } from './index';

export interface FileEntry {
    name: string;
    path: string;
    type: 'file' | 'dir';
    size?: number;
    mtime?: number;
    childrenCount?: number;
}

export interface IFileSystemService {
    /**
     * 扫描设备存储中的所有 PDF 文件
     * @param rootPath 可选，指定扫描的根路径
     * @param onProgress 进度回调，参数为已扫描的文件数量
     */
    scanPdfFiles(
        rootPath?: string,
        onProgress?: (scannedCount: number, foundCount: number) => void
    ): Promise<FileEntry[]>;

    /**
     * 列出指定目录的内容（仅目录和 PDF 文件）
     */
    listDirectory(path: string): Promise<FileEntry[]>;

    /**
     * 获取根目录列表
     */
    getRootDirectories(): Promise<FileEntry[]>;

    /**
     * 检查存储权限
     */
    checkStoragePermission(): Promise<boolean>;

    /**
     * 请求存储权限
     */
    requestStoragePermission(): Promise<boolean>;

    /**
     * 取消当前扫描
     */
    cancelScan(): Promise<void>;
}

class TauriFileSystemService implements IFileSystemService {
    async scanPdfFiles(
        rootPath?: string,
        onProgress?: (scannedCount: number, foundCount: number) => void
    ): Promise<FileEntry[]> {
        const invoke = await getInvoke();

        // 监听扫描进度事件
        let unlistenFn: (() => void) | null = null;
        if (onProgress) {
            const { listen } = await import('@tauri-apps/api/event');
            const unlisten = await listen('goread:scan:progress', (event: any) => {
                // Tauri v2 事件 payload 直接是数据对象
                const payload = event.payload as any;
                const scanned = typeof payload.scanned === 'number' ? payload.scanned : 0;
                const found = typeof payload.found === 'number' ? payload.found : 0;
                onProgress(scanned, found);
            });
            unlistenFn = unlisten;
        }

        try {
            const results = await invoke('scan_pdf_files', { rootPath });
            return results.map((item: any) => ({
                ...item,
                type: item.type === 'dir' ? 'dir' : 'file',
            }));
        } finally {
            // 清理事件监听器
            if (unlistenFn) {
                unlistenFn();
            }
        }
    }

    async cancelScan(): Promise<void> {
        const invoke = await getInvoke();
        await invoke('cancel_scan');
    }

    async listDirectory(path: string): Promise<FileEntry[]> {
        const invoke = await getInvoke();
        const results = await invoke('list_directory', { path });
        return results.map((item: any) => ({
            ...item,
            type: item.type === 'dir' ? 'dir' : 'file',
        }));
    }

    async getRootDirectories(): Promise<FileEntry[]> {
        const invoke = await getInvoke();
        const results = await invoke('get_root_directories');
        return results.map((item: any) => ({
            ...item,
            type: 'dir' as const,
        }));
    }

    async checkStoragePermission(): Promise<boolean> {
        try {
            const invoke = await getInvoke();
            return await invoke('check_storage_permission');
        } catch (error) {
            console.error('检查存储权限失败:', error);
            return false;
        }
    }

    async requestStoragePermission(): Promise<boolean> {
        try {
            const invoke = await getInvoke();
            return await invoke('request_storage_permission');
        } catch (error) {
            console.error('请求存储权限失败:', error);
            return false;
        }
    }
}

export const fileSystemService = new TauriFileSystemService();


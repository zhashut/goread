/**
 * EPUB 书籍预加载器
 * 在用户点击书籍准备进入阅读页时，提前触发书籍加载
 * 利用页面切换动画的时间完成 ZIP 解析，减少横向模式的等待时间
 */

import { useEpubLoader, type EpubBook } from './hooks';
import { logError } from '../../index';

/** 获取 Tauri invoke 函数 */
async function getInvoke() {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke;
}

/** 预加载缓存条目 */
interface PreloadCacheEntry {
  /** 加载 Promise */
  promise: Promise<EpubBook>;
  /** 创建时间 */
  createdAt: number;
  /** 清理定时器 */
  cleanupTimer: ReturnType<typeof setTimeout>;
}

/** 预加载缓存过期时间（毫秒）*/
const CACHE_EXPIRY_MS = 5 * 60 * 1000; // 5 分钟

/**
 * EPUB 预加载器类
 * 单例模式，在用户点击书籍时触发预加载
 */
class EpubPreloader {
  /** 预加载缓存 */
  private _cache = new Map<string, PreloadCacheEntry>();
  
  /** loader hook 实例 */
  private _loaderHook = useEpubLoader();

  /**
   * 触发预加载（不等待结果）
   * @param filePath - EPUB 文件路径
   */
  preload(filePath: string): void {
    // 已经在加载中则跳过
    if (this._cache.has(filePath)) {
      return;
    }

    // 立即开始加载，不等待结果
    const loadPromise = this._loadBook(filePath);
    
    // 设置自动清理定时器
    const cleanupTimer = setTimeout(() => {
      this._cache.delete(filePath);
    }, CACHE_EXPIRY_MS);

    // 存入缓存
    this._cache.set(filePath, {
      promise: loadPromise,
      createdAt: Date.now(),
      cleanupTimer,
    });

    // 处理加载失败的情况
    loadPromise.catch(() => {
      // 加载失败时立即清理
      const entry = this._cache.get(filePath);
      if (entry) {
        clearTimeout(entry.cleanupTimer);
        this._cache.delete(filePath);
      }
    });

    logError(`[EpubPreloader] 开始预加载: ${filePath}`).catch(() => {});
  }

  /**
   * 获取预加载的书籍（如果有）
   * @param filePath - EPUB 文件路径
   * @returns 预加载的书籍对象，或 null
   */
  async get(filePath: string): Promise<EpubBook | null> {
    const entry = this._cache.get(filePath);
    if (!entry) {
      return null;
    }

    try {
      const book = await entry.promise;
      
      // 获取成功后，保留缓存但重置过期时间
      // 这样如果用户快速退出再进入，仍可复用
      clearTimeout(entry.cleanupTimer);
      entry.cleanupTimer = setTimeout(() => {
        this._cache.delete(filePath);
      }, CACHE_EXPIRY_MS);
      
      logError(`[EpubPreloader] 命中预加载缓存: ${filePath}`).catch(() => {});
      return book;
    } catch (e) {
      // 加载失败，清理缓存
      clearTimeout(entry.cleanupTimer);
      this._cache.delete(filePath);
      logError(`[EpubPreloader] 预加载失败: ${e}`).catch(() => {});
      return null;
    }
  }

  /**
   * 检查是否有预加载缓存（不等待）
   * @param filePath - EPUB 文件路径
   */
  has(filePath: string): boolean {
    return this._cache.has(filePath);
  }

  /**
   * 清除指定文件的预加载缓存
   * @param filePath - EPUB 文件路径
   */
  clear(filePath: string): void {
    const entry = this._cache.get(filePath);
    if (entry) {
      clearTimeout(entry.cleanupTimer);
      this._cache.delete(filePath);
    }
  }

  /**
   * 清除所有预加载缓存
   */
  clearAll(): void {
    for (const [, entry] of this._cache) {
      clearTimeout(entry.cleanupTimer);
    }
    this._cache.clear();
  }

  /**
   * 内部加载方法
   */
  private async _loadBook(filePath: string): Promise<EpubBook> {
    // 通过 Tauri 读取文件
    const invoke = await getInvoke();
    const bytes = await invoke<number[]>('read_file_bytes', { path: filePath });
    const arrayBuffer = new Uint8Array(bytes).buffer;

    // 创建 File 对象
    const fileName = this._loaderHook.extractFileName(filePath);
    const file = new File([arrayBuffer], fileName + '.epub', {
      type: 'application/epub+zip',
    });

    // 解析 EPUB
    const book = await this._loaderHook.createBookFromFile(file);
    
    logError(`[EpubPreloader] 预加载完成: ${filePath}`).catch(() => {});
    return book;
  }
}

/** 导出单例实例 */
export const epubPreloader = new EpubPreloader();

/**
 * 判断文件是否为 EPUB 格式
 * @param filePath - 文件路径
 */
export function isEpubFile(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.epub');
}

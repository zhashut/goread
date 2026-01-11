/**
 * EPUB 缓存服务（全局单例）
 * 提供章节缓存和资源缓存的全局访问
 * 支持 IndexedDB 持久化
 */

import { logError } from '../../index';
import {
  EpubSectionCacheManager,
  EpubResourceCacheManager,
  type IEpubSectionCache,
  type IEpubResourceCache,
  type EpubSectionCacheEntry,
} from './cache';

// IndexedDB 配置
const DB_NAME = 'goread_epub_cache';
const DB_VERSION = 3; // 升级版本以修复 metadata store schema
const SECTION_STORE = 'sections';
const RESOURCE_STORE = 'resources';
const METADATA_STORE = 'metadata';

import { BookInfo, TocItem } from '../types';

export interface EpubMetadataCacheEntry {
  bookId: string;
  bookInfo: BookInfo;
  toc: TocItem[];
  sectionCount: number;
  lastAccessTime: number;
}

/**
 * 全局 EPUB 缓存服务
 */
class EpubCacheService {
  private _sectionCache: IEpubSectionCache;
  private _resourceCache: IEpubResourceCache;
  private _db: IDBDatabase | null = null;
  private _dbReady: Promise<void>;

  constructor() {
    // 内存缓存（一级缓存）
    this._sectionCache = new EpubSectionCacheManager(100, 100);
    this._resourceCache = new EpubResourceCacheManager(150);

    // 初始化 IndexedDB（二级缓存）
    this._dbReady = this._initIndexedDB();
  }

  /**
   * 获取章节缓存管理器
   */
  get sectionCache(): IEpubSectionCache {
    return this._sectionCache;
  }

  /**
   * 获取资源缓存管理器
   */
  get resourceCache(): IEpubResourceCache {
    return this._resourceCache;
  }

  /**
   * 初始化 IndexedDB
   */
  private async _initIndexedDB(): Promise<void> {
    return new Promise((resolve) => {
      try {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = () => {
          logError('[EpubCacheService] IndexedDB 打开失败:', request.error).catch(() => {});
          resolve(); // 降级为纯内存缓存
        };

        request.onsuccess = () => {
          this._db = request.result;
          logError('[EpubCacheService] IndexedDB 初始化成功').catch(() => {});
          resolve();
        };

        request.onupgradeneeded = (event) => {
          const db = (event.target as IDBOpenDBRequest).result;

          // 章节缓存存储
          if (!db.objectStoreNames.contains(SECTION_STORE)) {
            const sectionStore = db.createObjectStore(SECTION_STORE, { keyPath: 'key' });
            sectionStore.createIndex('bookId', 'bookId', { unique: false });
            sectionStore.createIndex('lastAccessTime', 'lastAccessTime', { unique: false });
          }

          // 资源缓存存储
          if (!db.objectStoreNames.contains(RESOURCE_STORE)) {
            const resourceStore = db.createObjectStore(RESOURCE_STORE, { keyPath: 'key' });
            resourceStore.createIndex('bookId', 'bookId', { unique: false });
            resourceStore.createIndex('lastAccessTime', 'lastAccessTime', { unique: false });
          }

          // 元数据缓存存储 (版本 3: 删除并重建以修复 schema)
          if (db.objectStoreNames.contains(METADATA_STORE)) {
            db.deleteObjectStore(METADATA_STORE);
          }
          const metadataStore = db.createObjectStore(METADATA_STORE, { keyPath: 'bookId' });
          metadataStore.createIndex('lastAccessTime', 'lastAccessTime', { unique: false });
        };
      } catch (e) {
        logError('[EpubCacheService] IndexedDB 初始化异常:', e).catch(() => {});
        resolve(); // 降级为纯内存缓存
      }
    });
  }

  /**
   * 等待 IndexedDB 就绪
   */
  async waitForReady(): Promise<void> {
    await this._dbReady;
  }

  /**
   * 从 IndexedDB 加载章节缓存到内存
   */
  async loadSectionFromDB(bookId: string, sectionIndex: number): Promise<EpubSectionCacheEntry | null> {
    await this._dbReady;
    if (!this._db) return null;

    return new Promise((resolve) => {
      try {
        const key = `${bookId}:${sectionIndex}`;
        const transaction = this._db!.transaction(SECTION_STORE, 'readonly');
        const store = transaction.objectStore(SECTION_STORE);
        const request = store.get(key);

        request.onsuccess = () => {
          const result = request.result;
          if (result && result.entry) {
            resolve(result.entry as EpubSectionCacheEntry);
          } else {
            resolve(null);
          }
        };

        request.onerror = () => {
          resolve(null);
        };
      } catch {
        resolve(null);
      }
    });
  }

  /**
   * 将章节缓存写入 IndexedDB
   */
  async saveSectionToDB(entry: EpubSectionCacheEntry): Promise<void> {
    await this._dbReady;
    if (!this._db) return;

    try {
      const key = `${entry.bookId}:${entry.sectionIndex}`;
      const transaction = this._db.transaction(SECTION_STORE, 'readwrite');
      const store = transaction.objectStore(SECTION_STORE);

      const record = {
        key,
        bookId: entry.bookId,
        sectionIndex: entry.sectionIndex,
        lastAccessTime: entry.meta.lastAccessTime,
        entry,
      };

      store.put(record);
    } catch (e) {
      logError('[EpubCacheService] 写入 IndexedDB 失败:', e).catch(() => {});
    }
  }

  /**
   * 加载元数据缓存
   */
  async getMetadata(bookId: string): Promise<EpubMetadataCacheEntry | null> {
    await this._dbReady;
    if (!this._db) return null;

    return new Promise((resolve) => {
      try {
        const transaction = this._db!.transaction(METADATA_STORE, 'readonly');
        const store = transaction.objectStore(METADATA_STORE);
        const request = store.get(bookId);

        request.onsuccess = () => {
          resolve(request.result || null);
        };
        request.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  /**
   * 保存元数据缓存
   */
  async saveMetadata(bookId: string, entry: Omit<EpubMetadataCacheEntry, 'bookId' | 'lastAccessTime'>): Promise<void> {
    await this._dbReady;
    if (!this._db) return;

    return new Promise((resolve) => {
      try {
        const transaction = this._db!.transaction(METADATA_STORE, 'readwrite');
        const store = transaction.objectStore(METADATA_STORE);
        
        // 深拷贝数据以确保可序列化（移除可能的 getter/函数等）
        const record: EpubMetadataCacheEntry = {
          bookId,
          bookInfo: JSON.parse(JSON.stringify(entry.bookInfo)),
          toc: JSON.parse(JSON.stringify(entry.toc)),
          sectionCount: entry.sectionCount,
          lastAccessTime: Date.now(),
        };

        const request = store.put(record);
        
        request.onsuccess = () => {
          logError(`[EpubCacheService] 元数据保存成功: ${bookId}`).catch(() => {});
          resolve();
        };
        
        request.onerror = () => {
          logError(`[EpubCacheService] 保存元数据失败 (request error): ${request.error?.message || request.error}`).catch(() => {});
          resolve();
        };
        
        transaction.onerror = () => {
          logError(`[EpubCacheService] 保存元数据失败 (transaction error): ${transaction.error?.message || transaction.error}`).catch(() => {});
          resolve();
        };
      } catch (e) {
        logError(`[EpubCacheService] 保存元数据失败 (exception): ${e}`).catch(() => {});
        resolve();
      }
    });
  }

  /**
   * 清空指定书籍的持久化缓存
   */
  async clearBookFromDB(bookId: string): Promise<void> {
    await this._dbReady;
    if (!this._db) return;

    try {
      // 清空章节缓存
      const sectionTx = this._db.transaction(SECTION_STORE, 'readwrite');
      const sectionStore = sectionTx.objectStore(SECTION_STORE);
      const sectionIndex = sectionStore.index('bookId');
      const sectionRequest = sectionIndex.openCursor(IDBKeyRange.only(bookId));

      sectionRequest.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };

      // 清空资源缓存
      const resourceTx = this._db.transaction(RESOURCE_STORE, 'readwrite');
      const resourceStore = resourceTx.objectStore(RESOURCE_STORE);
      const resourceIndex = resourceStore.index('bookId');
      const resourceRequest = resourceIndex.openCursor(IDBKeyRange.only(bookId));

      resourceRequest.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };

      // 清空元数据
      const metadataTx = this._db.transaction(METADATA_STORE, 'readwrite');
      metadataTx.objectStore(METADATA_STORE).delete(bookId);

    } catch (e) {
      logError('[EpubCacheService] 清空书籍持久化缓存失败:', e).catch(() => {});
    }
  }

  /**
   * 清空所有持久化缓存
   */
  async clearAllFromDB(): Promise<void> {
    await this._dbReady;
    if (!this._db) return;

    try {
      const sectionTx = this._db.transaction(SECTION_STORE, 'readwrite');
      sectionTx.objectStore(SECTION_STORE).clear();

      const resourceTx = this._db.transaction(RESOURCE_STORE, 'readwrite');
      resourceTx.objectStore(RESOURCE_STORE).clear();

      const metadataTx = this._db.transaction(METADATA_STORE, 'readwrite');
      metadataTx.objectStore(METADATA_STORE).clear();

      logError('[EpubCacheService] 已清空所有持久化缓存').catch(() => {});
    } catch (e) {
      logError('[EpubCacheService] 清空持久化缓存失败:', e).catch(() => {});
    }
  }


  /**
   * 设置缓存过期时间
   */
  setTimeToIdleSecs(secs: number): void {
    this._sectionCache.setTimeToIdleSecs(secs);
    this._resourceCache.setTimeToIdleSecs(secs);
  }

  /**
   * 清空所有缓存（内存 + IndexedDB）
   */
  async clearAll(): Promise<void> {
    this._sectionCache.clearAll();
    this._resourceCache.clearAll();
    await this.clearAllFromDB();
  }
}

// 全局单例
export const epubCacheService = new EpubCacheService();

// 动态解析 Tauri invoke（兼容 v1 / v2 / 浏览器预览）
const loadTauriAPI = async () => {
  // 1) 先用 window.__TAURI__ 注入的 invoke（WebView 环境最稳）
  const tauriAny = (window as any).__TAURI__;
  const v1Invoke = tauriAny?.invoke;
  if (typeof v1Invoke === 'function') {
    return v1Invoke as (cmd: string, args?: any) => Promise<any>;
  }
  const v2Invoke = tauriAny?.core?.invoke;
  if (typeof v2Invoke === 'function') {
    return v2Invoke as (cmd: string, args?: any) => Promise<any>;
  }

  // 2) 再尝试按包导入（开发者可能安装了 v1 或 v2 的包）
  try {
    const apiMod = await import('@tauri-apps/api').catch(() => null as any);
    if (apiMod && typeof (apiMod as any).invoke === 'function') {
      return (apiMod as any).invoke as (cmd: string, args?: any) => Promise<any>;
    }
  } catch {}

  try {
    const coreMod = await import('@tauri-apps/api/core').catch(() => null as any);
    if (coreMod && typeof (coreMod as any).invoke === 'function') {
      return (coreMod as any).invoke as (cmd: string, args?: any) => Promise<any>;
    }
  } catch {}

  // 3) 浏览器预览环境：返回 mock，避免页面因未找到 invoke 而报错
  console.warn('Tauri invoke not available, using mock for browser preview');
  return async (cmd: string, args?: any) => {
    console.log('Mock invoke:', cmd, args);
    if (cmd === 'get_all_books') return [];
    if (cmd === 'init_database') return;
    return null;
  };
};

// 延迟加载invoke函数
let invokePromise: Promise<any> | null = null;
export const getInvoke = async () => {
  if (!invokePromise) {
    invokePromise = loadTauriAPI();
  }
  return await invokePromise;
};

// 日志工具函数
export const log = async (message: string, level: 'info' | 'warn' | 'error' = 'info', context?: any) => {
  const invoke = await getInvoke();
  await invoke('frontend_log', {
    level,
    message,
    context: context ? JSON.stringify(context) : undefined
  }).catch(() => {}); // 忽略日志错误
};

import { IBook, IGroup, IBookmark, IStatsSummary, IDailyStats, IRangeStats, IBookReadingStats } from '../types';
import { DEFAULT_SETTINGS } from '../constants/config';

// 书籍服务接口
export interface IBookService {
  initDatabase(): Promise<void>;
  addBook(path: string, title: string, coverImage?: string, totalPages?: number): Promise<IBook>;
  getAllBooks(): Promise<IBook[]>;
  getRecentBooks(limit: number): Promise<IBook[]>;
  updateBookProgress(id: number, currentPage: number): Promise<void>;
  updateBookTotalPages(id: number, totalPages: number): Promise<void>;
  markBookOpened(id: number): Promise<void>;
  deleteBook(id: number, deleteLocal?: boolean): Promise<void>;
  clearRecent(bookId: number): Promise<void>;
  updateBooksLastReadTime(updates: [number, number][]): Promise<void>;
}

// 分组服务接口
export interface IGroupService {
  addGroup(name: string): Promise<IGroup>;
  getAllGroups(): Promise<IGroup[]>;
  getBooksByGroup(groupId: number): Promise<IBook[]>;
  moveBookToGroup(bookId: number, groupId?: number): Promise<void>;
  reorderGroupBooks(groupId: number, orderedIds: number[]): Promise<void>;
  updateGroup(groupId: number, name: string): Promise<void>;
  deleteGroup(groupId: number, deleteLocal?: boolean): Promise<void>;
}

// 书签服务接口
export interface IBookmarkService {
  addBookmark(bookId: number, pageNumber: number, title: string): Promise<IBookmark>;
  getBookmarks(bookId: number): Promise<IBookmark[]>;
  deleteBookmark(id: number): Promise<void>;
}

// Tauri实现
export class TauriBookService implements IBookService {
  async initDatabase(): Promise<void> {
    try {
      const invoke = await getInvoke();
      await invoke('init_database');
    } catch (error) {
      console.error('Failed to init database:', error);
      // 如果数据库已经初始化，忽略错误
    }
  }

  async addBook(path: string, title: string, coverImage?: string, totalPages: number = 1): Promise<IBook> {
    const invoke = await getInvoke();
    return await invoke('add_book', {
      path,
      title,
      coverImage,
      totalPages
    });
  }

  async getAllBooks(): Promise<IBook[]> {
    const invoke = await getInvoke();
    return await invoke('get_all_books');
  }

  async getRecentBooks(limit: number): Promise<IBook[]> {
    const invoke = await getInvoke();
    return await invoke('get_recent_books', { limit });
  }

  async updateBookProgress(id: number, currentPage: number): Promise<void> {
    const invoke = await getInvoke();
    await invoke('update_book_progress', { id, currentPage });
  }

  async updateBookTotalPages(id: number, totalPages: number): Promise<void> {
    const invoke = await getInvoke();
    await invoke('update_book_total_pages', { id, totalPages });
  }

  async markBookOpened(id: number): Promise<void> {
    const invoke = await getInvoke();
    await invoke('mark_book_opened', { id });
  }

  async deleteBook(id: number, deleteLocal: boolean = false): Promise<void> {
    const invoke = await getInvoke();
    await invoke('delete_book', { id, deleteLocal });
  }

  async clearRecent(bookId: number): Promise<void> {
    const invoke = await getInvoke();
    await invoke('clear_recent_read_record', { id: bookId });
  }

  async updateBooksLastReadTime(updates: [number, number][]): Promise<void> {
    const invoke = await getInvoke();
    await invoke('update_books_last_read_time', { updates });
  }
}

export class TauriGroupService implements IGroupService {
  async addGroup(name: string): Promise<IGroup> {
    const invoke = await getInvoke();
    try {
      return await invoke('add_group', { name });
    } catch (e) {
      console.error('Failed to create group:', e);
      try {
        await invoke('frontend_log', {
          level: 'error',
          message: 'addGroup failed',
          context: JSON.stringify({ name, error: String(e) })
        });
      } catch {}
      throw e;
    }
  }

  async getAllGroups(): Promise<IGroup[]> {
    const invoke = await getInvoke();
    return await invoke('get_all_groups');
  }

  async getBooksByGroup(groupId: number): Promise<IBook[]> {
    const invoke = await getInvoke();
    return await invoke('get_books_by_group', { groupId });
  }

  async moveBookToGroup(bookId: number, groupId?: number): Promise<void> {
    const invoke = await getInvoke();
    await invoke('move_book_to_group', { bookId, groupId });
  }

  async reorderGroupBooks(groupId: number, orderedIds: number[]): Promise<void> {
    const invoke = await getInvoke();
    await invoke('reorder_group_books', { groupId, orderedIds });
  }

  async updateGroup(groupId: number, name: string): Promise<void> {
    const invoke = await getInvoke();
    await invoke('update_group', { groupId, name });
  }

  async deleteGroup(groupId: number, deleteLocal: boolean = false): Promise<void> {
    const invoke = await getInvoke();
    await invoke('delete_group', { groupId, deleteLocal });
  }
}

export class TauriBookmarkService implements IBookmarkService {
  async addBookmark(bookId: number, pageNumber: number, title: string): Promise<IBookmark> {
    const invoke = await getInvoke();
    return await invoke('add_bookmark', { bookId, pageNumber, title });
  }

  async getBookmarks(bookId: number): Promise<IBookmark[]> {
    const invoke = await getInvoke();
    return await invoke('get_bookmarks', { bookId });
  }

  async deleteBookmark(id: number): Promise<void> {
    const invoke = await getInvoke();
    await invoke('delete_bookmark', { id });
  }
}

// 服务实例
export const bookService = new TauriBookService();
export const groupService = new TauriGroupService();
export const bookmarkService = new TauriBookmarkService();

export const logError = async (message: string, context?: any) => {
  const invoke = await getInvoke();
  try {
    await invoke('frontend_log', {
      level: 'error',
      message,
      context: context ? JSON.stringify(context) : null,
    });
  } catch {}
};

// --------------- 阅读器设置持久化 ---------------
export type ReaderSettings = {
  volumeKeyTurnPage: boolean;
  clickTurnPage: boolean;
  showStatusBar: boolean;
  pageTransition: boolean;
  recentDisplayCount: number;
  scrollSpeed: number; // 像素/秒
  pageGap: number; // 像素
  readingMode?: 'horizontal' | 'vertical'; // 阅读方式（可选，向后兼容）
  renderQuality?: string; // 书籍渲染质量
};

const SETTINGS_KEY = 'reader_settings_v1';

export const getReaderSettings = (): ReaderSettings => {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    const defaults: ReaderSettings = { ...DEFAULT_SETTINGS };
    return { ...defaults, ...(parsed || {}) } as ReaderSettings;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
};

export const saveReaderSettings = (settings: Partial<ReaderSettings>) => {
  try {
    const current = getReaderSettings();
    const next = { ...current, ...settings } as ReaderSettings;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    return next;
  } catch (e) {
    console.warn('Save settings failed', e);
    return getReaderSettings();
  }
};

// ==================== 阅读统计服务 ====================

// 统计服务接口
export interface IStatsService {
  saveReadingSession(bookId: number, duration: number, startTime: number, readDate: string, pagesRead?: number): Promise<void>;
  getStatsSummary(): Promise<IStatsSummary>;
  getDailyStats(days: number): Promise<IDailyStats[]>;
  getReadingStatsByRange(rangeType: string, offset: number): Promise<IRangeStats>;
  getDayStatsByHour(date: string): Promise<number[]>;
  getBooksByDateRange(startDate: string, endDate: string): Promise<IBookReadingStats[]>;
  markBookFinished(bookId: number): Promise<void>;
  unmarkBookFinished(bookId: number): Promise<void>;
}

// Tauri 统计服务实现
export class TauriStatsService implements IStatsService {
  async saveReadingSession(
    bookId: number,
    duration: number,
    startTime: number,
    readDate: string,
    pagesReadCount?: number
  ): Promise<void> {
    const invoke = await getInvoke();
    await invoke('save_reading_session', {
      bookId,
      duration,
      startTime,
      readDate,
      pagesReadCount
    });
  }

  async getStatsSummary(): Promise<IStatsSummary> {
    const invoke = await getInvoke();
    return await invoke('get_stats_summary');
  }

  async getDailyStats(days: number): Promise<IDailyStats[]> {
    const invoke = await getInvoke();
    return await invoke('get_daily_stats', { days });
  }

  async getReadingStatsByRange(rangeType: string, offset: number): Promise<IRangeStats> {
    const invoke = await getInvoke();
    return await invoke('get_reading_stats_by_range', { rangeType, offset });
  }

  async getDayStatsByHour(date: string): Promise<number[]> {
    const invoke = await getInvoke();
    return await invoke('get_day_stats_by_hour', { date });
  }

  async getBooksByDateRange(startDate: string, endDate: string): Promise<IBookReadingStats[]> {
    const invoke = await getInvoke();
    return await invoke('get_books_by_date_range', { startDate, endDate });
  }

  async markBookFinished(bookId: number): Promise<void> {
    const invoke = await getInvoke();
    await invoke('mark_book_finished', { bookId });
  }

  async unmarkBookFinished(bookId: number): Promise<void> {
    const invoke = await getInvoke();
    await invoke('unmark_book_finished', { bookId });
  }
}

// 统计服务实例
export const statsService = new TauriStatsService();

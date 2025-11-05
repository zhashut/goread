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
const getInvoke = async () => {
  if (!invokePromise) {
    invokePromise = loadTauriAPI();
  }
  return await invokePromise;
};
import { IBook, IGroup, IBookmark } from '../types';

// 书籍服务接口
export interface IBookService {
  initDatabase(): Promise<void>;
  addBook(path: string, title: string, coverImage?: string, totalPages?: number): Promise<IBook>;
  getAllBooks(): Promise<IBook[]>;
  getRecentBooks(limit: number): Promise<IBook[]>;
  updateBookProgress(id: number, currentPage: number): Promise<void>;
  deleteBook(id: number): Promise<void>;
}

// 分组服务接口
export interface IGroupService {
  addGroup(name: string): Promise<IGroup>;
  getAllGroups(): Promise<IGroup[]>;
  getBooksByGroup(groupId: number): Promise<IBook[]>;
  moveBookToGroup(bookId: number, groupId?: number): Promise<void>;
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

  async deleteBook(id: number): Promise<void> {
    const invoke = await getInvoke();
    await invoke('delete_book', { id });
  }
}

export class TauriGroupService implements IGroupService {
  async addGroup(name: string): Promise<IGroup> {
    const invoke = await getInvoke();
    return await invoke('add_group', { name });
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
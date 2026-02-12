/**
 * 书籍服务模块
 * 提供书籍相关的数据库操作服务
 */

import { IBook } from '../types';
import { getInvoke, logError } from './commonService';
import type { ReaderTheme } from './formats/types';

// 书籍服务接口
export interface IBookService {
  initDatabase(): Promise<void>;
  addBook(path: string, title: string, coverImage?: string, totalPages?: number): Promise<IBook>;
  getAllBooks(): Promise<IBook[]>;
  getRecentBooks(limit: number): Promise<IBook[]>;
  updateBookProgress(id: number, currentPage: number): Promise<void>;
  updateBookTotalPages(id: number, totalPages: number): Promise<void>;
  markBookOpened(id: number): Promise<boolean>;
  deleteBook(id: number, deleteLocal?: boolean): Promise<void>;
  clearRecent(bookId: number): Promise<void>;
  updateBooksLastReadTime(updates: [number, number][]): Promise<void>;
  reorderRecentBooks(orderedIds: number[]): Promise<void>;
  updateBookTheme(id: number, theme: ReaderTheme | null): Promise<void>;
  updateBookReadingMode(id: number, readingMode: 'horizontal' | 'vertical' | null): Promise<void>;
  updateBookHideDivider(id: number, hide: boolean): Promise<void>;
  resetAllBookThemes(): Promise<void>;
  renameBook(id: number, newTitle: string): Promise<void>;
}

// Tauri 书籍服务实现
export class TauriBookService implements IBookService {
  async initDatabase(): Promise<void> {
    try {
      const invoke = await getInvoke();
      await invoke('init_database');
      } catch (error) {
        await logError('Failed to init database', { error: String(error) });
        // 数据库已初始化时忽略错误
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

  async markBookOpened(id: number): Promise<boolean> {
    const invoke = await getInvoke();
    return await invoke('mark_book_opened', { id });
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

  async reorderRecentBooks(orderedIds: number[]): Promise<void> {
    const invoke = await getInvoke();
    await invoke('reorder_recent_books', { orderedIds });
  }

  async updateBookTheme(id: number, theme: ReaderTheme | null): Promise<void> {
    const invoke = await getInvoke();
    await invoke('update_book_theme', { id, theme });
  }

  async updateBookReadingMode(id: number, readingMode: 'horizontal' | 'vertical' | null): Promise<void> {
    const invoke = await getInvoke();
    await invoke('update_book_reading_mode', { id, readingMode });
  }

  async updateBookHideDivider(id: number, hide: boolean): Promise<void> {
    const invoke = await getInvoke();
    await invoke('update_book_hide_divider', { id, hide });
  }

  async resetAllBookThemes(): Promise<void> {
    const invoke = await getInvoke();
    await invoke('reset_all_book_themes');
  }

  async renameBook(id: number, newTitle: string): Promise<void> {
    const invoke = await getInvoke();
    await invoke('rename_book', { id, newTitle });
  }
}

// 书籍服务实例
export const bookService = new TauriBookService();

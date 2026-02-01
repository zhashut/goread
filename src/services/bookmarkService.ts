/**
 * 书签服务模块
 * 提供书签相关的数据库操作服务
 */

import { IBookmark } from '../types';
import { getInvoke } from './commonService';

// 书签服务接口
export interface IBookmarkService {
  addBookmark(bookId: number, pageNumber: number, title: string): Promise<IBookmark>;
  getBookmarks(bookId: number): Promise<IBookmark[]>;
  deleteBookmark(id: number): Promise<void>;
}

// Tauri 书签服务实现
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

// 书签服务实例
export const bookmarkService = new TauriBookmarkService();

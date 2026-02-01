/**
 * 分组服务模块
 * 提供书籍分组相关的数据库操作服务
 */

import { IBook, IGroup } from '../types';
import { getInvoke, logError } from './commonService';

// 分组服务接口
export interface IGroupService {
  addGroup(name: string): Promise<IGroup>;
  getAllGroups(): Promise<IGroup[]>;
  getBooksByGroup(groupId: number): Promise<IBook[]>;
  moveBookToGroup(bookId: number, groupId?: number): Promise<void>;
  reorderGroupBooks(groupId: number, orderedIds: number[]): Promise<void>;
  reorderGroups(orderedIds: number[]): Promise<void>;
  updateGroup(groupId: number, name: string): Promise<void>;
  deleteGroup(groupId: number, deleteLocal?: boolean): Promise<void>;
}

// Tauri 分组服务实现
export class TauriGroupService implements IGroupService {
  async addGroup(name: string): Promise<IGroup> {
    const invoke = await getInvoke();
    try {
      return await invoke('add_group', { name });
    } catch (e) {
      await logError('Failed to create group', { name, error: String(e) });
      try {
        await invoke('frontend_log', {
          level: 'error',
          message: 'addGroup failed',
          context: JSON.stringify({ name, error: String(e) })
        });
      } catch { }
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

  async reorderGroups(orderedIds: number[]): Promise<void> {
    const invoke = await getInvoke();
    await invoke('reorder_groups', { orderedIds });
  }
}

// 分组服务实例
export const groupService = new TauriGroupService();

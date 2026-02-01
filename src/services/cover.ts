/**
 * 封面服务模块
 * 提供与书籍封面相关的服务接口和实现
 */

import { getInvoke } from './commonService';

// 需要重建封面的书籍信息
export interface BookNeedingCoverRebuild {
  id: number;
  file_path: string;
  format: string;
  title: string;
}

// 封面服务接口
export interface ICoverService {
  getCoverRootPath(): Promise<string>;
  getCoverUrl(bookId: number): Promise<string | null>;
  migrateBookCover(bookId: number): Promise<string | null>;
  getBooksNeedingCoverRebuild(): Promise<BookNeedingCoverRebuild[]>;
  getEpubBooksWithoutCover(): Promise<BookNeedingCoverRebuild[]>;
  getMobiBooksWithoutCover(): Promise<BookNeedingCoverRebuild[]>;
  rebuildPdfCover(bookId: number, coverData: string): Promise<string | null>;
  rebuildEpubCover(bookId: number, coverData: string): Promise<string | null>;
  rebuildMobiCover(bookId: number, coverData: string): Promise<string | null>;
  clearBookCover(bookId: number): Promise<void>;
}

// Tauri 封面服务实现
export class TauriCoverService implements ICoverService {
  private rootPathCache: string | null = null;

  async getCoverRootPath(): Promise<string> {
    if (this.rootPathCache) {
      return this.rootPathCache;
    }
    const invoke = await getInvoke();
    const result = await invoke('get_cover_root_path');
    this.rootPathCache = result;
    return result;
  }

  async getCoverUrl(bookId: number): Promise<string | null> {
    const invoke = await getInvoke();
    return await invoke('get_cover_url', { bookId });
  }

  async migrateBookCover(bookId: number): Promise<string | null> {
    const invoke = await getInvoke();
    return await invoke('migrate_book_cover', { bookId });
  }

  // 获取需要重建封面的书籍列表
  async getBooksNeedingCoverRebuild(): Promise<BookNeedingCoverRebuild[]> {
    const invoke = await getInvoke();
    return await invoke('get_books_needing_cover_rebuild');
  }

  // 获取封面为空但文件存在的 EPUB 书籍列表
  async getEpubBooksWithoutCover(): Promise<BookNeedingCoverRebuild[]> {
    const invoke = await getInvoke();
    return await invoke('get_epub_books_without_cover');
  }

  // 获取封面为空但文件存在的 MOBI 书籍列表
  async getMobiBooksWithoutCover(): Promise<BookNeedingCoverRebuild[]> {
    const invoke = await getInvoke();
    return await invoke('get_mobi_books_without_cover');
  }

  // 使用提供的封面数据重建 PDF 封面
  async rebuildPdfCover(bookId: number, coverData: string): Promise<string | null> {
    const invoke = await getInvoke();
    return await invoke('rebuild_pdf_cover', { bookId, coverData });
  }

  async rebuildEpubCover(bookId: number, coverData: string): Promise<string | null> {
    const invoke = await getInvoke();
    return await invoke('rebuild_epub_cover', { bookId, coverData });
  }

  // 使用提供的封面数据重建 MOBI 封面
  async rebuildMobiCover(bookId: number, coverData: string): Promise<string | null> {
    const invoke = await getInvoke();
    return await invoke('rebuild_mobi_cover', { bookId, coverData });
  }

  // 清空书籍封面字段
  async clearBookCover(bookId: number): Promise<void> {
    const invoke = await getInvoke();
    await invoke('clear_book_cover', { bookId });
  }
}

// 封面服务实例
export const coverService = new TauriCoverService();

/**
 * EPUB 生命周期管理 Hook
 * 处理书籍加载、元数据提取、缓存检查与懒加载逻辑
 */

import { BookInfo, TocItem } from '../../types';
import { logError, getInvoke } from '../../../index';
import { EpubBook, useEpubLoader } from './useEpubLoader';
import { generateQuickBookId } from '../../../../utils/bookId';
import { epubCacheService } from '../epubCacheService';
import { epubPreloader } from '../epubPreloader';

/** 生命周期状态接口 */
export interface EpubLifecycleState {
  isReady: boolean;
  book: EpubBook | null;
  toc: TocItem[];
  totalPages: number;
  sectionCount: number;
  bookId: string | null;
  filePath: string;
}

/** 生命周期 Hook 返回接口 */
export interface EpubLifecycleHook {
  state: EpubLifecycleState;
  /** 加载文档，返回书籍信息 */
  loadDocument: (filePath: string, expectedReadingMode: string | null) => Promise<BookInfo>;
  /** 确保书籍内容已完全加载（用于懒加载模式） */
  ensureBookLoaded: () => Promise<void>;
  /** 强制重新解析书籍（用于白屏修复等场景） */
  reloadBook: () => Promise<void>;
  /** 重置状态 */
  reset: () => void;
}

/**
 * EPUB 生命周期管理 Hook
 */
export function useEpubLifecycle(): EpubLifecycleHook {
  const loaderHook = useEpubLoader();

  // 内部状态
  const state: EpubLifecycleState = {
    isReady: false,
    book: null,
    toc: [],
    totalPages: 1,
    sectionCount: 0,
    bookId: null,
    filePath: '',
  };

  let _bookLoadPromise: Promise<void> | null = null;

  /**
   * 懒加载书籍文件（后台执行）
   */
  const _lazyLoadBook = async (filePath: string, bookId: string): Promise<void> => {
    try {
      // 通过 Tauri 读取文件
      const invoke = await getInvoke();
      const bytes = await invoke<number[]>('read_file_bytes', { path: filePath });
      const arrayBuffer = new Uint8Array(bytes).buffer;

      // 创建 File 对象
      const fileName = loaderHook.extractFileName(filePath);
      const file = new File([arrayBuffer], fileName + '.epub', {
        type: 'application/epub+zip',
      });

      state.book = await loaderHook.createBookFromFile(file);
      
      // 更新状态
      const book = state.book;
      state.sectionCount = book.sections?.length || 1;
      state.toc = loaderHook.convertToc(book.toc || []);
      
      // 首次加载（非缓存恢复）时，sectionCount 可能变化，需更新 totalPages
      if (state.totalPages === 1 && state.sectionCount > 1) {
         state.totalPages = state.sectionCount;
      }

      logError(`[EpubLifecycle] 书籍后台加载完成: ${bookId}`).catch(() => {});

      // 缓存元数据（排除 coverImage，它可能是 Blob 无法序列化）
      const bookInfoForCache: BookInfo = {
        title: book.metadata?.title,
        author: Array.isArray(book.metadata?.author) ? book.metadata?.author.join(', ') : book.metadata?.author,
        publisher: book.metadata?.publisher,
        language: book.metadata?.language,
        description: book.metadata?.description,
        pageCount: state.totalPages,
        format: 'epub',
        // coverImage 不存储，它可能是 Blob 无法序列化到 IndexedDB
      };

      await epubCacheService.saveMetadata(bookId, {
         bookInfo: bookInfoForCache,
         toc: state.toc,
         sectionCount: state.sectionCount,
      });

    } catch (e) {
      logError(`[EpubLifecycle] 书籍加载失败`, {
        error: String(e),
        stack: (e as Error)?.stack,
        bookId,
        filePath,
      }).catch(() => {});
      throw e;
    } finally {
      // Promise 保持引用，不置空
    }
  };

  /**
   * 加载 EPUB 文档
   */
  const loadDocument = async (filePath: string, expectedReadingMode: string | null): Promise<BookInfo> => {
    state.filePath = filePath;
    // 1. 生成 Quick ID
    state.bookId = generateQuickBookId(filePath);
    const bookId = state.bookId;

    // 2. 检查预加载缓存（仅纵向模式使用，横向模式跳过以避免时序问题）
    if (expectedReadingMode !== 'horizontal') {
      const preloadedBook = await epubPreloader.get(filePath);
      if (preloadedBook) {
        logError(`[EpubLifecycle] 命中预加载缓存，直接使用: ${bookId}`).catch(() => {});
        
        state.book = preloadedBook;
        state.sectionCount = preloadedBook.sections?.length || 1;
        state.toc = loaderHook.convertToc(preloadedBook.toc || []);
        state.totalPages = state.sectionCount;
        state.isReady = true;
        
        // 异步保存/更新元数据缓存
        const bookInfoForCache: BookInfo = {
          title: preloadedBook.metadata?.title,
          author: Array.isArray(preloadedBook.metadata?.author) 
            ? preloadedBook.metadata?.author.join(', ') 
            : preloadedBook.metadata?.author,
          publisher: preloadedBook.metadata?.publisher,
          language: preloadedBook.metadata?.language,
          description: preloadedBook.metadata?.description,
          pageCount: state.totalPages,
          format: 'epub',
        };
        
        epubCacheService.saveMetadata(bookId, {
          bookInfo: bookInfoForCache,
          toc: state.toc,
          sectionCount: state.sectionCount,
        }).catch(() => {});
        
        return {
          ...bookInfoForCache,
          coverImage: await loaderHook.getCoverImage(preloadedBook),
        };
      }
    } else {
      logError(`[EpubLifecycle] 横向模式跳过预加载缓存: ${bookId}`).catch(() => {});
    }

    // 3. 尝试获取元数据缓存（仅纵向模式使用）
    if (expectedReadingMode !== 'horizontal') {
      const metadata = await epubCacheService.getMetadata(bookId);

      if (metadata) {
        logError(`[EpubLifecycle] 命中元数据缓存（纵向模式），启用懒加载: ${bookId}`).catch(() => {});
        
        // 恢复状态
        state.toc = metadata.toc;
        state.sectionCount = metadata.sectionCount;
        state.totalPages = state.sectionCount;
        state.isReady = true;

        // 启动后台加载
        _bookLoadPromise = _lazyLoadBook(filePath, bookId);

        return {
          ...metadata.bookInfo,
          format: 'epub',
        };
      }
    } else {
      logError(`[EpubLifecycle] 横向模式跳过元数据缓存: ${bookId}`).catch(() => {});
    }

    // 3. 缓存未命中，执行完整加载
    logError(`[EpubLifecycle] 元数据未命中，执行完整加载`).catch(() => {});
    _bookLoadPromise = _lazyLoadBook(filePath, bookId);
    await _bookLoadPromise;
    
    // 标记就绪
    state.isReady = true;
    
    // 返回 BookInfo
    const book = state.book!;
    const bookInfo: BookInfo = {
      title: book.metadata?.title,
      author: Array.isArray(book.metadata?.author) ? book.metadata?.author.join(', ') : book.metadata?.author,
      publisher: book.metadata?.publisher,
      language: book.metadata?.language,
      description: book.metadata?.description,
      pageCount: state.totalPages,
      format: 'epub',
      coverImage: await loaderHook.getCoverImage(book),
    };
    
    return bookInfo;
  };

  /**
   * 确保书籍已加载
   */
  const ensureBookLoaded = async (): Promise<void> => {
    if (state.book) return;
    if (_bookLoadPromise) {
      await _bookLoadPromise;
    }
  };

  /**
   * 强制重新解析书籍
   */
  const reloadBook = async (): Promise<void> => {
    if (state.filePath && state.bookId) {
       state.isReady = false;
       try {
         // 更新 promise 以便 ensureBookLoaded 等待重载完成
         _bookLoadPromise = _lazyLoadBook(state.filePath, state.bookId);
         await _bookLoadPromise;
         state.isReady = true;
       } catch (e) {
         state.isReady = false;
         throw e;
       }
    }
  };

  /**
   * 重置状态
   */
  const reset = (): void => {
    if (state.book) {
      try {
        state.book.destroy();
      } catch {}
    }
    state.isReady = false;
    state.book = null;
    state.toc = [];
    state.totalPages = 1;
    state.sectionCount = 0;
    state.bookId = null;
    state.filePath = '';
    _bookLoadPromise = null;
  };

  return {
    state,
    loadDocument,
    ensureBookLoaded,
    reloadBook,
    reset,
  };
}

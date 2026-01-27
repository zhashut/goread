/**
 * 封面显示工具函数
 * 支持三种封面格式：
 * 1. 旧数据 Base64（无前缀）
 * 2. 旧数据 data URL（data:image/...;base64,xxx）
 * 3. 新数据「相对路径」字符串（例如 epub/123.jpg）
 */

import { convertFileSrc } from '@tauri-apps/api/core';
import { coverService, log, logError } from '../services';

/**
 * 封面类型枚举
 */
export type CoverType = 'none' | 'dataUrl' | 'base64' | 'filePath';

/**
 * 封面解析结果
 */
export interface CoverInfo {
  type: CoverType;
  value?: string;
}

// 缓存封面根目录路径
let coverRootCache: string | null = null;

// 拼接本地文件路径，尽量保持与系统风格一致（Windows 使用 \，其他使用 /）
function joinNativePath(root: string, relative: string): string {
  if (!root) return relative;
  const hasBackslash = root.includes('\\');
  const sep = hasBackslash ? '\\' : '/';
  const trimmedRoot = root.endsWith('\\') || root.endsWith('/') ? root.slice(0, -1) : root;
  const normalizedRelative = relative.replace(/[\\/]/g, sep);
  return `${trimmedRoot}${sep}${normalizedRelative}`;
}

/**
 * 获取封面根目录路径（带缓存）
 */
export async function getCoverRootPath(): Promise<string> {
  if (coverRootCache) {
    return coverRootCache;
  }
  
  try {
    const rootPath = await coverService.getCoverRootPath();
    if (rootPath) {
      coverRootCache = rootPath;
      return rootPath;
    }
  } catch (e) {
    await logError('Failed to get cover root path', { error: String(e) });
  }
  
  return '';
}

/**
 * 判断字符串是否为 Base64 编码
 * 规则：长度超过 200 且只包含 Base64 字符集
 */
function isBase64String(str: string): boolean {
  if (str.length < 200) {
    return false;
  }
  // 只包含 Base64 字符集
  return /^[A-Za-z0-9+/=]+$/.test(str);
}

/**
 * 解析封面字符串，判断其类型
 */
export function parseCoverImage(coverImage: string | null | undefined): CoverInfo {
  if (!coverImage || coverImage.trim() === '') {
    return { type: 'none' };
  }
  
  const trimmed = coverImage.trim();
  
  // data URL 格式
  if (trimmed.startsWith('data:')) {
    return { type: 'dataUrl', value: trimmed };
  }
  
  // Base64 格式（长字符串且只包含 Base64 字符）
  if (isBase64String(trimmed)) {
    return { type: 'base64', value: trimmed };
  }
  
  // 否则认为是文件路径
  return { type: 'filePath', value: trimmed };
}

/**
 * 根据封面信息生成 img src
 * 对于文件路径类型，需要先获取封面根目录
 */
export async function getCoverSrc(
  coverImage: string | null | undefined,
  coverRootPath?: string
): Promise<string | null> {
  const info = parseCoverImage(coverImage);
  
  switch (info.type) {
    case 'none':
      return null;
    
    case 'dataUrl':
      return info.value!;
    
    case 'base64':
      return `data:image/jpeg;base64,${info.value}`;
    
    case 'filePath': {
      // 文件路径需要拼接完整路径并转换为可访问的 URL
      const root = coverRootPath || await getCoverRootPath();
      if (!root) {
        return null;
      }

      // 拼接完整路径
      const fullPath = joinNativePath(root, info.value!);
      await log('Cover image fullPath (async)', 'info', { fullPath });

      // 使用 Tauri 的 convertFileSrc 转换为 WebView 可访问的 URL
      try {
        return convertFileSrc(fullPath);
      } catch (e) {
        await logError('Failed to convert cover file src', {
          error: String(e),
          fullPath,
        });
        return null;
      }
    }
    
    default:
      return null;
  }
}

/**
 * 同步版本的封面 src 获取（用于需要立即返回的场景）
 * 对于文件路径类型，需要传入已缓存的 coverRootPath
 */
export function getCoverSrcSync(
  coverImage: string | null | undefined,
  coverRootPath: string | null
): string | null {
  const info = parseCoverImage(coverImage);
  
  switch (info.type) {
    case 'none':
      return null;
    
    case 'dataUrl':
      return info.value!;
    
    case 'base64':
      return `data:image/jpeg;base64,${info.value}`;
    
    case 'filePath': {
      if (!coverRootPath) {
        // 没有根目录，无法构建路径，返回 null
        // 调用方应该异步获取 coverRootPath 后重新渲染
        return null;
      }
      const fullPath = joinNativePath(coverRootPath, info.value!);
      // log('Cover image fullPath (sync)', 'info', { fullPath }).catch(() => {});
      try {
        return convertFileSrc(fullPath);
      } catch {
        return null;
      }
    }
    
    default:
      return null;
  }
}

/**
 * 触发单本书的封面迁移（Base64 -> 文件）
 */
export async function migrateBookCover(bookId: number): Promise<string | null> {
  try {
    const result = await coverService.migrateBookCover(bookId);
    await log('migrateBookCover success', 'info', { bookId, result });
    return result;
  } catch (e) {
    await logError('Failed to migrate book cover', {
      bookId,
      error: String(e),
    });
    return null;
  }
}

/**
 * 渲染 PDF 首页为封面图片
 * 返回 Base64 编码的 JPEG 数据（不含 data: 前缀）
 */
async function convertDataUrlToJpegBase64(dataUrl: string): Promise<string | null> {
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = (e) => reject(e);
      img.src = dataUrl;
    });

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) {
      return null;
    }
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    context.drawImage(img, 0, 0);

    const jpegDataUrl = canvas.toDataURL('image/jpeg', 0.8);
    const parts = jpegDataUrl.split(',');
    if (parts.length < 2) {
      return null;
    }
    return parts[1];
  } catch {
    return null;
  }
}

async function renderPdfCover(filePath: string): Promise<string | null> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    
    const dataUrl: string = await invoke('pdf_render_page_base64', {
      filePath,
      pageNumber: 1,
      quality: 'thumbnail',
      width: 256,
      height: null,
    });

    const base64 = await convertDataUrlToJpegBase64(dataUrl);
    if (!base64) {
      throw new Error('Failed to convert PDF cover to JPEG');
    }
    return base64;
  } catch (e) {
    await logError('Failed to render PDF cover', {
      filePath,
      error: String(e),
    });
    return null;
  }
}

async function renderEpubCover(filePath: string): Promise<string | null> {
  try {
    const { EpubRenderer } = await import('../services/formats/epub/EpubRenderer');
    const { useEpubLoader } = await import('../services/formats/epub/hooks/useEpubLoader');
    const renderer = new EpubRenderer();
    const bookInfo: any = await renderer.loadDocument(filePath);

    let coverImage: string | undefined = bookInfo?.coverImage;

    // 命中元数据缓存时，coverImage 可能为空，需要等待书籍加载完成后获取
    if (!coverImage || typeof coverImage !== 'string') {
      const lifecycleHook = (renderer as any)._lifecycleHook;
      
      if (lifecycleHook?.ensureBookLoaded) {
        await lifecycleHook.ensureBookLoaded();
      }
      
      if (lifecycleHook?.state?.book) {
        const loaderHook = useEpubLoader();
        coverImage = await loaderHook.getCoverImage(lifecycleHook.state.book);
      }
    }

    await renderer.close().catch(() => {});

    if (!coverImage || typeof coverImage !== 'string') {
      return null;
    }

    const base64 = await convertDataUrlToJpegBase64(coverImage);
    if (!base64) {
      throw new Error('Failed to convert EPUB cover to JPEG');
    }

    return base64;
  } catch (e) {
    await logError('Failed to render EPUB cover', {
      filePath,
      error: String(e),
    });
    return null;
  }
}

/**
 * 批量重建封面（备份导入后调用）
 * 检查所有书籍的封面文件，对缺失的封面进行重建
 * @param onProgress 进度回调 (current, total, bookTitle)
 * @returns 重建结果统计
 */
export async function rebuildMissingCovers(
  onProgress?: (current: number, total: number, bookTitle: string) => void
): Promise<{ success: number; failed: number; skipped: number }> {
  const result = { success: 0, failed: 0, skipped: 0 };
  
  try {
    // 获取需要重建封面的书籍列表
    const booksNeedingRebuild = await coverService.getBooksNeedingCoverRebuild();
    const total = booksNeedingRebuild.length;
    
    if (total === 0) {
      await log('No books need cover rebuild', 'info');
      return result;
    }
    
    await log('Starting cover rebuild', 'info', { total });
    
    for (let i = 0; i < booksNeedingRebuild.length; i++) {
      const book = booksNeedingRebuild[i];
      
      // 报告进度
      onProgress?.(i + 1, total, book.title);
      
      try {
        if (book.format === 'pdf') {
          const coverData = await renderPdfCover(book.file_path);
          if (coverData) {
            await coverService.rebuildPdfCover(book.id, coverData);
            result.success++;
            await log('Rebuilt cover for PDF', 'info', {
              bookId: book.id,
              title: book.title,
            });
          } else {
            await coverService.clearBookCover(book.id);
            result.failed++;
            await logError('Failed to render PDF cover during rebuild', {
              bookId: book.id,
              title: book.title,
            });
          }
        } else if (book.format === 'epub') {
          const coverData = await renderEpubCover(book.file_path);
          if (coverData) {
            await coverService.rebuildEpubCover(book.id, coverData);
            result.success++;
            await log('Rebuilt cover for EPUB', 'info', {
              bookId: book.id,
              title: book.title,
            });
          } else {
            await coverService.clearBookCover(book.id);
            result.failed++;
            await logError('Failed to render EPUB cover during rebuild', {
              bookId: book.id,
              title: book.title,
            });
          }
        } else {
          await coverService.clearBookCover(book.id);
          result.skipped++;
        }
      } catch (e) {
        await logError('[CoverUtils] Error rebuilding cover for book', {
          bookId: book.id,
          error: String(e),
        });
        try {
          await coverService.clearBookCover(book.id);
        } catch {
        }
        result.failed++;
      }
      
      // 每处理一定数量后让出执行权
      if (i > 0 && i % 10 === 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
    
    await log('[CoverUtils] Cover rebuild completed', 'info', result);
  } catch (e) {
    await logError('[CoverUtils] Failed to get books needing cover rebuild', {
      error: String(e),
    });
  }
  
  return result;
}

/**
 * 为封面为空的 EPUB 书籍生成封面
 * 用于备份导入后，处理那些 cover_image 为空但文件存在的 EPUB 书籍
 * @param onProgress 进度回调 (current, total, bookTitle)
 * @returns 生成结果统计
 */
export async function generateMissingEpubCovers(
  onProgress?: (current: number, total: number, bookTitle: string) => void
): Promise<{ success: number; failed: number }> {
  const result = { success: 0, failed: 0 };
  
  try {
    // 获取封面为空但文件存在的 EPUB 书籍列表
    const epubBooksWithoutCover = await coverService.getEpubBooksWithoutCover();
    const total = epubBooksWithoutCover.length;
    
    if (total === 0) {
      await log('[CoverUtils] No EPUB books need cover generation', 'info');
      return result;
    }
    
    await log('[CoverUtils] Starting EPUB cover generation', 'info', { total });
    
    for (let i = 0; i < epubBooksWithoutCover.length; i++) {
      const book = epubBooksWithoutCover[i];
      
      // 报告进度
      onProgress?.(i + 1, total, book.title);
      
      try {
        const coverData = await renderEpubCover(book.file_path);
        if (coverData) {
          await coverService.rebuildEpubCover(book.id, coverData);
          result.success++;
          await log('[CoverUtils] Generated cover for EPUB', 'info', {
            bookId: book.id,
            title: book.title,
          });
        } else {
          result.failed++;
          await logError('[CoverUtils] Failed to generate EPUB cover', {
            bookId: book.id,
            title: book.title,
          });
        }
      } catch (e) {
        await logError('[CoverUtils] Error generating cover for EPUB', {
          bookId: book.id,
          error: String(e),
        });
        result.failed++;
      }
      
      // 每处理一定数量后让出执行权
      if (i > 0 && i % 10 === 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
    
    await log('[CoverUtils] EPUB cover generation completed', 'info', result);
  } catch (e) {
    await logError('[CoverUtils] Failed to get EPUB books without cover', {
      error: String(e),
    });
  }
  
  return result;
}

import { bookService, groupService, getInvoke, log, logError } from "./index";
import { pathToTitle, waitNextFrame } from "./importUtils";
import { getBookFormat, BookFormat } from "./formats";
import { resolveLocalPathFromUri } from "./resolveLocalPath";
import { generateQuickBookId } from "./formats/epub/cache";
import { txtPreloader } from "./formats/txt/txtPreloader";
import { parseCoverImage, migrateBookCover } from "../utils/coverUtils";

// 移动端检测
const isMobilePlatform = (): boolean => {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
};

// 大文件阈值（100MB），超过此大小在移动端需要更激进的内存清理
const LARGE_FILE_THRESHOLD_BYTES = 100 * 1024 * 1024;

// 移动端导入延迟（毫秒），给 GC 时间回收内存
const MOBILE_IMPORT_DELAY_MS = 500;
const MOBILE_LARGE_FILE_DELAY_MS = 800;

// EPUB 文件大小限制（MB），超过此大小需要使用流式读取或提示用户
const MAX_EPUB_SIZE_MB = 200;
const MAX_EPUB_SIZE_BYTES = MAX_EPUB_SIZE_MB * 1024 * 1024;

// EPUB Rust 引擎开关（后续可接入配置）
const enableRustEpubEngine = true;

// 格式特定的导入结果
interface ImportResult {
  info: any;
  coverImage: string | undefined;
  totalPages: number;
}

// PDF 格式导入
async function importPdfBook(filePath: string, invoke: any, logError: any): Promise<ImportResult> {
  let info: any = null;
  try {
    info = await (await invoke)('pdf_load_document', { filePath });
  } catch (err) {
    await logError('pdf_load_document failed during import', { error: String(err), filePath });
  }

  let coverImage: string | undefined = undefined;
  try {
    const dataUrl: string = await (await invoke)('pdf_render_page_base64', {
      filePath,
      pageNumber: 1,
      quality: 'thumbnail',
      width: 256,
      height: null,
    });
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = (e) => reject(e);
      img.src = dataUrl;
    });
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d")!;
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    context.drawImage(img, 0, 0);
    coverImage = canvas.toDataURL("image/jpeg", 0.8).split(",")[1];
  } catch (err) {
    await logError('pdf_render_page_base64 failed during import', { error: String(err), filePath });
  }

  const totalPages = Math.max(1, Number(info?.info?.page_count ?? 0));

  // Warmup cache for PDF
  try {
    await (await invoke)('pdf_warmup_cache', {
      filePath,
      strategy: 'first_pages',
      pageCount: 5,
    });
  } catch (err) {
    await logError('pdf_warmup_cache failed during import', { error: String(err), filePath });
  }

  return { info, coverImage, totalPages };
}

// Markdown 格式导入
async function importMarkdownBook(filePath: string, invoke: any, logError: any): Promise<ImportResult> {
  let info: any = null;
  try {
    info = await (await invoke)('markdown_load_document', { filePath });
  } catch (err) {
    await logError('markdown_load_document failed during import', { error: String(err), filePath });
  }

  // Markdown currently doesn't support cover image extraction
  // totalPages is always 1 for markdown (single scrollable document)
  return {
    info: { title: info?.title },
    coverImage: undefined,
    totalPages: 1,
  };
}

// HTML 格式导入
async function importHtmlBook(filePath: string, invoke: any, logError: any): Promise<ImportResult> {
  let info: any = null;
  try {
    info = await (await invoke)('html_load_document', { filePath });
  } catch (err) {
    await logError('html_load_document failed during import', { error: String(err), filePath });
  }

  // HTML currently doesn't support cover image extraction
  // totalPages is always 1 for HTML (single scrollable document)
  return {
    info: { title: info?.title },
    coverImage: undefined,
    totalPages: 1,
  };
}

// MOBI 格式导入
async function importMobiBook(filePath: string, _invoke: any, logError: any, _options?: { skipPreloaderCache?: boolean }): Promise<ImportResult> {
  let info: any = null;
  let coverImage: string | undefined = undefined;
  let totalPages = 1;

  try {
    const invoke = await getInvoke();
    const result = await invoke<{
      book_info: {
        title?: string | null;
        author?: string | null;
        page_count: number;
        cover_image?: string | null;
      };
      section_count: number;
    }>('mobi_prepare_book', {
      filePath,
      bookId: generateQuickBookId(filePath),
    });

    const bookInfo = result.book_info;
    info = {
      title: bookInfo?.title ?? pathToTitle(filePath),
      author: bookInfo?.author ?? undefined,
    };

    if (bookInfo?.cover_image && bookInfo.cover_image.startsWith('data:')) {
      coverImage = bookInfo.cover_image;
    }

    totalPages = Math.max(1, result.section_count);
  } catch (err) {
    await logError('MOBI import failed', { error: String(err), filePath });
  }

  return { info, coverImage, totalPages };
}

async function importEpubBook(filePath: string, _invoke: any, _logError: any, _options?: { skipPreloaderCache?: boolean }): Promise<ImportResult> {
  let info: any = null;
  let coverImage: string | undefined = undefined;
  let totalPages = 1;

  try {
    const invoke = await getInvoke();
    try {
      const stats = await invoke<{ size: number }>('get_file_stats', { path: filePath });
      const sizeMB = stats.size / (1024 * 1024);
      if (stats.size > MAX_EPUB_SIZE_BYTES) {
        await log(`[EPUB Import] 文件较大 (${sizeMB.toFixed(0)}MB)，可能需要较长时间`, 'warn', { filePath, sizeMB });
      } else {
        await log('[EPUB Import] 开始导入 EPUB 文件', 'info', { filePath, sizeMB });
      }
    } catch {
      // 获取大小失败，继续导入
    }

    if (enableRustEpubEngine) {
      try {
        await log('[EPUB Import] 调用 epub_prepare_book 开始', 'info', { filePath });

        const result = await invoke<{
          book_info: {
            title?: string | null;
            author?: string | null;
            description?: string | null;
            publisher?: string | null;
            language?: string | null;
            page_count: number;
            format: string;
            cover_image?: string | null;
          };
          toc: any[];
          section_count: number;
        }>('epub_prepare_book', {
          filePath,
          bookId: generateQuickBookId(filePath),
        });

        const bookInfo = result?.book_info;

        info = {
          title: bookInfo?.title ?? pathToTitle(filePath),
          author: bookInfo?.author ?? undefined,
        };

        if (bookInfo?.cover_image && bookInfo.cover_image.startsWith('data:')) {
          coverImage = bookInfo.cover_image;
        }

        totalPages = Math.max(1, Number(bookInfo?.page_count ?? result?.section_count ?? 1));

        await log('[EPUB Import] epub_prepare_book 成功', 'info', {
          filePath,
          sectionCount: result?.section_count ?? null,
          pageCount: bookInfo?.page_count ?? null,
        });

        return { info, coverImage, totalPages };
      } catch (e) {
        await logError('[EPUB Import] Rust epub_prepare_book failed', {
          error: String(e),
          filePath,
        });
      }
    }
  } catch (err) {
    await logError('EPUB import failed', { error: String(err), filePath });
  }

  return { info, coverImage, totalPages };
}

// TXT 格式导入
async function importTxtBook(filePath: string, invoke: any, logError: any): Promise<ImportResult> {
  let info: any = null;
  try {
    info = await (await invoke)('txt_load_document', { filePath });
  } catch (err) {
    await logError('txt_load_document failed during import', { error: String(err), filePath });
  }

  const totalPages = Math.max(
    1,
    Number(info?.metadata?.page_count ?? info?.metadata?.pageCount ?? 0)
  );

  // TXT 没有封面图片，页数使用后端目录解析得到的章节数作为初值
  return {
    info: { title: info?.title },
    coverImage: undefined,
    totalPages,
  };
}

// Generic import handler that dispatches by format
async function importByFormat(
  filePath: string,
  format: BookFormat,
  invoke: any,
  logError: any,
  options?: { skipPreloaderCache?: boolean }
): Promise<ImportResult> {
  switch (format) {
    case 'pdf':
      return await importPdfBook(filePath, invoke, logError);
    case 'markdown':
      return await importMarkdownBook(filePath, invoke, logError);
    case 'html':
      return await importHtmlBook(filePath, invoke, logError);
    case 'epub':
      return await importEpubBook(filePath, invoke, logError, options);
    case 'mobi':
      return await importMobiBook(filePath, invoke, logError, options);
    case 'txt':
      return await importTxtBook(filePath, invoke, logError);
    default:
      await logError('Unsupported format, skipping', { format, filePath });
      return { info: null, coverImage: undefined, totalPages: 1 };
  }
}

// 运行导入到已存在分组，并同步导入进度到 UI（标题/进度）
// 分批导入配置：每批处理书籍数量和批次间延迟时间
const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 500;

/**
 * 强制触发垃圾回收
 * 通过让出多帧给 GC 时间，移动端需要更长的等待
 */
async function forceGarbageCollection(isLargeFile: boolean): Promise<void> {
  // 让出多帧，给 GC 时间回收
  const frameCount = isLargeFile ? 5 : 3;
  for (let i = 0; i < frameCount; i++) {
    await new Promise(r => setTimeout(r, 50));
    await waitNextFrame();
  }
}

/**
 * 检测文件大小是否为大文件
 */
async function isLargeFile(filePath: string): Promise<boolean> {
  try {
    const invoke = await getInvoke();
    const stats = await invoke<{ size: number }>('get_file_stats', { path: filePath });
    return stats.size > LARGE_FILE_THRESHOLD_BYTES;
  } catch {
    return false;
  }
}

export const importPathsToExistingGroup = async (
  paths: string[],
  groupId: number
) => {
  const total = paths.length;
  const firstTitle = paths[0] ? pathToTitle(paths[0]) : "";

  // 广播开始事件
  window.dispatchEvent(
    new CustomEvent("goread:import:start", {
      detail: { total, title: firstTitle },
    })
  );

  let cancelled = false;
  const cancelHandler = () => {
    cancelled = true;
  };
  window.addEventListener("goread:import:cancel", cancelHandler as any, {
    once: false,
  });

  const isMobile = isMobilePlatform();

  for (let i = 0; i < paths.length; i++) {
    if (cancelled) break;

    // 分批处理：每批结束后等待一段时间，让 GC 有机会回收内存
    if (i > 0 && i % BATCH_SIZE === 0) {
      await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
    }

    const filePath = await resolveLocalPathFromUri(paths[i]);

    // 移动端大文件检测，用于后续内存清理策略
    const largeFile = isMobile ? await isLargeFile(filePath) : false;

    // 在处理前同步当前书籍标题到抽屉，current 保持为 i
    {
      const title = pathToTitle(filePath) || "Unknown";
      window.dispatchEvent(
        new CustomEvent("goread:import:progress", {
          detail: { current: i, total, title },
        })
      );
      // 让出一帧，以确保UI刷新
      await waitNextFrame();
    }

    const invoke = await getInvoke();

    // Detect format and import accordingly
    const format = getBookFormat(filePath);
    if (!format) {
      await logError('Unsupported file format, skipping', { filePath });
      continue;
    }

    await log('[Import] 开始导入书籍', 'info', {
      index: i + 1,
      total,
      filePath,
      format,
    });

    // 大文件且是 EPUB/MOBI 格式时，跳过预加载缓存存储，避免内存累积
    const skipCache = largeFile && (format === 'epub' || format === 'mobi');
    const { coverImage, totalPages } = await importByFormat(filePath, format, invoke, logError, {
      skipPreloaderCache: skipCache,
    });

    const title = pathToTitle(filePath) || "Unknown";
    const saved = await bookService.addBook(
      filePath,
      title,
      coverImage,
      totalPages,
    );

    try {
      const coverInfo = parseCoverImage(saved.cover_image);
      if (coverInfo.type === "base64" || coverInfo.type === "dataUrl") {
        await migrateBookCover(saved.id);
      }
    } catch (err) {
      await logError("Import cover migration failed", {
        error: String(err),
        filePath,
        bookId: saved.id,
      });
    }

    await groupService.moveBookToGroup(saved.id, groupId);

    if (format === 'txt') {
      try {
        await log('[Import][TXT] 导入后触发预热', 'info', {
          filePath,
          bookId: saved.id,
        });
        const meta = await txtPreloader.getOrLoad(filePath);
        const shouldPreloadChapters =
          (meta.total_bytes ?? 0) > 0 &&
          (meta.total_bytes ?? 0) <= 2 * 1024 * 1024 &&
          meta.chapters.length > 0 &&
          meta.chapters.length <= 500;
        if (shouldPreloadChapters) {
          await txtPreloader.preloadChapters(filePath, 0, meta.chapters.length);
        }
      } catch (e) {
        await logError('[Import][TXT] 导入预热失败', {
          error: String(e),
          filePath,
          bookId: saved.id,
        });
      }
    }

    await log('[Import] 导入书籍完成', 'info', {
      index: i + 1,
      total,
      filePath,
      bookId: saved.id,
      format,
    });

    // 完成一册后同步进度与标题
    window.dispatchEvent(
      new CustomEvent("goread:import:progress", {
        detail: { current: i + 1, total, title },
      })
    );
    await waitNextFrame();

    // 增强 GC 时机 - 每本书导入后强制清理内存
    // 移动端串行化 - 大文件导入后增加额外延迟
    if (isMobile) {
      await forceGarbageCollection(largeFile);
      const delayMs = largeFile ? MOBILE_LARGE_FILE_DELAY_MS : MOBILE_IMPORT_DELAY_MS;
      await new Promise(resolve => setTimeout(resolve, delayMs));
      await log(`[Import] 移动端内存清理完成，延迟 ${delayMs}ms`, 'info');
    }
  }

  window.removeEventListener("goread:import:cancel", cancelHandler as any);
  window.dispatchEvent(new CustomEvent("goread:import:done"));
  window.dispatchEvent(new CustomEvent("goread:groups:changed"));
  window.dispatchEvent(new CustomEvent("goread:books:changed"));
};

// 创建分组并导入书籍（同样同步进度）
export const createGroupAndImport = async (
  paths: string[],
  groupName: string
) => {
  const g = await groupService.addGroup(groupName.trim());
  await importPathsToExistingGroup(paths, g.id);
};

import { bookService, groupService } from "./index";
import { pathToTitle, waitNextFrame } from "./importUtils";
import { getBookFormat, BookFormat } from "./formats";

async function ensureLocalPath(filePath: string): Promise<string> {
  if (filePath.startsWith("content://")) {
    const bridge = (window as any).SafBridge;
    if (bridge && typeof bridge.copyToAppDir === "function") {
      try {
        const dest = bridge.copyToAppDir(filePath);
        if (typeof dest === "string" && dest) {
          return dest;
        }
      } catch (e) {
        console.error("复制 SAF 文件到应用目录失败:", e);
      }
    }
  }
  return filePath;
}

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

// EPUB 格式导入
async function importEpubBook(filePath: string, _invoke: any, logError: any): Promise<ImportResult> {
  let info: any = null;
  let coverImage: string | undefined = undefined;
  let totalPages = 1;

  try {
    // 动态导入 EpubRenderer 避免循环依赖
    const { EpubRenderer } = await import('./formats/epub/EpubRenderer');
    const renderer = new EpubRenderer();
    const bookInfo = await renderer.loadDocument(filePath);
    
    info = {
      title: bookInfo.title,
      author: bookInfo.author,
    };
    
    // 封面图片格式: "data:image/...;base64,xxxxx"
    if (bookInfo.coverImage) {
      const base64Part = bookInfo.coverImage.split(',')[1];
      if (base64Part) {
        coverImage = base64Part;
      }
    }
    
    totalPages = bookInfo.pageCount || 1;
    await renderer.close();
  } catch (err) {
    await logError('EPUB import failed', { error: String(err), filePath });
  }

  return { info, coverImage, totalPages };
}

// Generic import handler that dispatches by format
async function importByFormat(
  filePath: string,
  format: BookFormat,
  invoke: any,
  logError: any
): Promise<ImportResult> {
  switch (format) {
    case 'pdf':
      return await importPdfBook(filePath, invoke, logError);
    case 'markdown':
      return await importMarkdownBook(filePath, invoke, logError);
    case 'html':
      return await importHtmlBook(filePath, invoke, logError);
    case 'epub':
      return await importEpubBook(filePath, invoke, logError);
    default:
      await logError('Unsupported format, skipping', { format, filePath });
      return { info: null, coverImage: undefined, totalPages: 1 };
  }
}

// 运行导入到已存在分组，并同步导入进度到 UI（标题/进度）
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

  for (let i = 0; i < paths.length; i++) {
    if (cancelled) break;
    const filePath = await ensureLocalPath(paths[i]);

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

    const invoke = await import("../services/index").then(m => m.getInvoke());
    const { logError } = await import('./index');

    // Detect format and import accordingly
    const format = getBookFormat(filePath);
    if (!format) {
      await logError('Unsupported file format, skipping', { filePath });
      continue;
    }
    const { coverImage, totalPages } = await importByFormat(filePath, format, invoke, logError);

    const title = pathToTitle(filePath) || "Unknown";
    const saved = await bookService.addBook(
      filePath,
      title,
      coverImage,
      totalPages,
    );
    await groupService.moveBookToGroup(saved.id, groupId);

    // 完成一册后同步进度与标题
    window.dispatchEvent(
      new CustomEvent("goread:import:progress", {
        detail: { current: i + 1, total, title },
      })
    );
    await waitNextFrame();
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

import { getInvoke, getReaderSettings, saveReaderSettings, ReaderSettings, log, logError, bookService } from "./index";
import { rebuildMissingCovers, generateMissingEpubCovers, parseCoverImage, migrateBookCover } from "../utils/coverUtils";
import i18n from "../locales";

const BACKUP_EXT = "goread-backup";

const tSettings = (key: string, options?: any): string =>
  i18n.t(`settings:${key}`, options as any) as unknown as string;

const BACKUP_ERROR_KEY_MAP: { pattern: string; key: string }[] = [
  { pattern: "解析备份文件失败", key: "backup.errorParseBackupFailed" },
  { pattern: "备份文件缺少版本号", key: "backup.errorMissingData" },
  { pattern: "不支持的备份版本", key: "backup.errorUnsupportedVersion" },
  { pattern: "备份文件不是 GoRead 生成的备份", key: "backup.errorNotGoreadBackup" },
  { pattern: "备份文件缺少 data 字段", key: "backup.errorMissingData" },
  { pattern: "备份文件缺少数据表信息", key: "backup.errorMissingData" },
];

function getBackupErrorText(raw: string): string {
  const match = BACKUP_ERROR_KEY_MAP.find((item) => raw.includes(item.pattern));
  if (match) {
    return tSettings(match.key);
  }
  return tSettings("backup.importFailedWithReason", { reason: raw });
}

async function pickExportPath(): Promise<any | null> {
  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const fileName = `goread-backup-${now.getFullYear()}-${pad(
      now.getMonth() + 1
    )}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(
      now.getMinutes()
    )}.goread-backup`;
    const result: any = await save({
      filters: [
        {
          name: tSettings("backup.fileFilterName"),
          extensions: [BACKUP_EXT],
        },
      ],
      defaultPath: fileName,
    });
    if (!result) return null;
    return result;
  } catch {
    alert(tSettings("backup.dialogNotSupportedSave"));
    return null;
  }
}

async function pickImportPath(): Promise<any | null> {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected: any = await open({
      multiple: false,
      filters: [
        {
          name: tSettings("backup.fileFilterName"),
          extensions: [BACKUP_EXT],
        },
      ],
    });
    if (!selected) return null;
    if (Array.isArray(selected)) {
      const first = selected[0];
      if (!first) return null;
      return first;
    }
    return selected;
  } catch {
    alert(tSettings("backup.dialogNotSupportedOpen"));
    return null;
  }
}

export async function exportAppData(): Promise<boolean> {
  const target = await pickExportPath();
  if (!target) return false;

  try {
    const settings: ReaderSettings = getReaderSettings();
    const invoke = await getInvoke();
    const backupJson: string = await invoke("export_app_data", {
      readerSettings: settings,
    });

    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    await writeTextFile(target as any, backupJson);

    return true;
  } catch (e: any) {
    const msg =
      typeof e?.message === "string"
        ? e.message
        : typeof e === "string"
        ? e
        : JSON.stringify(e);
    throw new Error(msg);
  }
}

export async function importAppData(): Promise<boolean> {
  let ok = false;
  try {
    const { confirm } = await import("@tauri-apps/plugin-dialog");
    ok = await confirm(tSettings("backup.importConfirm"), { title: "GoRead" });
  } catch {
    ok = window.confirm(tSettings("backup.importConfirm"));
  }
  if (!ok) return false;

  const target = await pickImportPath();
  if (!target) return false;

  try {
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    const backupContent = await readTextFile(target as any);

    const invoke = await getInvoke();
    const settingsFromBackup: any = await invoke("import_app_data", {
      backupContent,
    });
    if (settingsFromBackup && typeof settingsFromBackup === "object") {
      saveReaderSettings(settingsFromBackup as Partial<ReaderSettings>);
    }
    
    try {
      const books = await bookService.getAllBooks();
      await log('[DataBackup] Starting cover migration check', 'info', { totalBooks: books.length });
      
      for (const book of books) {
        const coverInfo = parseCoverImage(book.cover_image);
        // 从文件路径推断格式
        const fileExt = book.file_path.split('.').pop()?.toLowerCase() ?? 'unknown';
        await log('[DataBackup] Checking book cover', 'info', {
          bookId: book.id,
          title: book.title,
          format: fileExt,
          coverType: coverInfo.type,
          coverLength: book.cover_image?.length ?? 0,
        });
        
        if (coverInfo.type === "base64" || coverInfo.type === "dataUrl") {
          await log('[DataBackup] Migrating cover for book', 'info', { bookId: book.id, title: book.title, coverType: coverInfo.type });
          await migrateBookCover(book.id);
        }
      }
    } catch (err) {
      await logError("[DataBackup] Cover migration after import failed", {
        error: String(err),
      });
    }

    try {
      const result = await rebuildMissingCovers((current, total, title) => {
        log('[DataBackup] Rebuilding covers', 'info', {
          current,
          total,
          title,
        }).catch(() => {});
      });
      await log('[DataBackup] Cover rebuild completed', 'info', result);
    } catch (err) {
      await logError('[DataBackup] Cover rebuild failed', {
        error: String(err),
      });
    }

    // 为封面为空的 EPUB 书籍生成封面
    try {
      const epubResult = await generateMissingEpubCovers((current, total, title) => {
        log('[DataBackup] Generating EPUB covers', 'info', {
          current,
          total,
          title,
        }).catch(() => {});
      });
      await log('[DataBackup] EPUB cover generation completed', 'info', epubResult);
    } catch (err) {
      await logError('[DataBackup] EPUB cover generation failed', {
        error: String(err),
      });
    }
    
    return true;
  } catch (e: any) {
    const msg =
      typeof e?.message === "string"
        ? e.message
        : typeof e === "string"
        ? e
        : JSON.stringify(e);
    throw new Error(getBackupErrorText(msg));
  }
}

export async function exitApp(): Promise<void> {
  const invoke = await getInvoke();
  await invoke("exit_app");
}

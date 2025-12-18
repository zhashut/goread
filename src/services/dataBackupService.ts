import { getInvoke, getReaderSettings, saveReaderSettings, ReaderSettings } from "./index";

const BACKUP_EXT = "goread-backup";

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
      filters: [{ name: "GoRead 备份文件", extensions: [BACKUP_EXT] }],
      defaultPath: fileName,
    });
    if (!result) return null;
    return result;
  } catch {
    alert("当前环境不支持文件保存对话框");
    return null;
  }
}

async function pickImportPath(): Promise<any | null> {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected: any = await open({
      multiple: false,
      filters: [{ name: "GoRead 备份文件", extensions: [BACKUP_EXT] }],
    });
    if (!selected) return null;
    if (Array.isArray(selected)) {
      const first = selected[0];
      if (!first) return null;
      return first;
    }
    return selected;
  } catch {
    alert("当前环境不支持文件打开对话框");
    return null;
  }
}

export async function exportAppData(): Promise<void> {
  const target = await pickExportPath();
  if (!target) return;

  try {
    const settings: ReaderSettings = getReaderSettings();
    const invoke = await getInvoke();
    const backupJson: string = await invoke("export_app_data", {
      readerSettings: settings,
    });

    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    await writeTextFile(target as any, backupJson);

    alert("导出成功");
  } catch (e: any) {
    const msg =
      typeof e?.message === "string"
        ? e.message
        : typeof e === "string"
        ? e
        : JSON.stringify(e);
    alert(`导出失败，请重试\n\n原因：${msg}`);
  }
}

export async function importAppData(): Promise<void> {
  let ok = false;
  try {
    const { confirm } = await import("@tauri-apps/plugin-dialog");
    ok = await confirm(
      "导入备份会覆盖当前应用内的所有数据（书架、分组、阅读记录、统计和阅读设置），此操作不可撤销。是否继续？",
      { title: "GoRead" }
    );
  } catch {
    ok = window.confirm(
      "导入备份会覆盖当前应用内的所有数据（书架、分组、阅读记录、统计和阅读设置），此操作不可撤销。是否继续？"
    );
  }
  if (!ok) return;

  const target = await pickImportPath();
  if (!target) return;

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
    alert("导入成功，应用将关闭，请重新打开以应用最新数据");
    await invoke("exit_app");
  } catch (e: any) {
    const msg =
      typeof e?.message === "string"
        ? e.message
        : typeof e === "string"
        ? e
        : JSON.stringify(e);
    alert(`导入失败，请重试\n\n原因：${msg}`);
  }
}

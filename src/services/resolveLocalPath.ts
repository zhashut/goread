import { logError } from './index';

export async function resolveLocalPathFromUri(filePath: string): Promise<string> {
  if (filePath.startsWith("content://")) {
    const bridge = (window as any).SafBridge;
    if (bridge && typeof bridge.copyToAppDir === "function") {
      try {
        const dest = bridge.copyToAppDir(filePath);
        if (typeof dest === "string" && dest) {
          return dest;
        }
      } catch (e) {
        await logError('复制 SAF 文件到应用目录失败', { error: String(e), filePath });
      }
    }
  }
  return filePath;
}


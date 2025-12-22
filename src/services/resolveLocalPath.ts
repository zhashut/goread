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
        console.error("复制 SAF 文件到应用目录失败:", e);
      }
    }
  }
  return filePath;
}


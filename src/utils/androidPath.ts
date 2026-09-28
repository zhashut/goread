/**
 * Android 存储路径归一化工具
 *
 * 背景：Android 上 /sdcard、/storage/self/primary 都是 /storage/emulated/0 的符号链接，
 * 同一个物理文件可能存在多种路径写法。若不归一化，会出现：
 *   1. 已导入书籍的 file_path 与扫描/浏览页返回的路径字符串不一致，「已导入」标记失效；
 *   2. 同一本书被重复导入（数据库 file_path 唯一约束只按字符串比较）。
 *
 * 归一化规则与 Rust 侧 src-tauri/src/commands/filesystem.rs 的 normalize_android_path 保持一致。
 */

/** Android 内部存储的真实路径 */
const ANDROID_INTERNAL_STORAGE = "/storage/emulated/0";

/** Android 内部存储的别名路径（均为指向内部存储的符号链接） */
const ANDROID_INTERNAL_STORAGE_ALIASES = ["/sdcard", "/storage/self/primary"];

const isAndroid = /Android/i.test(navigator.userAgent);

/**
 * 将 Android 别名路径归一化为内部存储真实路径。
 * 非 Android 平台或空路径原样返回。
 *
 * @example
 * normalizeAndroidPath('/sdcard/Download/a.epub')          // '/storage/emulated/0/Download/a.epub'
 * normalizeAndroidPath('/storage/self/primary/Books/a.txt') // '/storage/emulated/0/Books/a.txt'
 * normalizeAndroidPath('/sdcard')                          // '/storage/emulated/0'
 */
export function normalizeAndroidPath(path: string): string {
  if (!isAndroid || !path) return path;

  for (const alias of ANDROID_INTERNAL_STORAGE_ALIASES) {
    // 别名根目录本身
    if (path === alias) return ANDROID_INTERNAL_STORAGE;
    // 别名下的子路径
    if (path.startsWith(`${alias}/`)) {
      return `${ANDROID_INTERNAL_STORAGE}${path.slice(alias.length)}`;
    }
  }

  return path;
}

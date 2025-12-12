/**
 * zip.js ESM 包装器
 * 从 @zip.js/zip.js 重新导出用于 foliate-js 的函数
 */
export {
  configure,
  ZipReader,
  BlobReader,
  TextWriter,
  BlobWriter,
} from '@zip.js/zip.js';

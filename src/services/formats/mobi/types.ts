/**
 * MOBI 相关类型定义
 * 解析由 Rust 后端完成，前端统一使用 formats/types.ts 中的 TocItem
 */

/** MOBI 目录项类型 */
export interface MobiTocItem {
  label?: string;
  href?: string;
  subitems?: MobiTocItem[];
}

/** MOBI 导航点类型 */
export interface MobiLandmark {
  label?: string;
  type?: string[];
  href?: string;
}

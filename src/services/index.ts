/**
 * 服务模块入口
 * 统一导出所有服务模块供外部使用
 */

// ==================== 公共服务 ====================
export { getInvoke, log, logError } from './commonService';

// ==================== 类型 re-export ====================
export type { ReaderTheme } from './formats/types';

// ==================== 书籍服务 ====================
export { bookService, TauriBookService } from './bookService';
export type { IBookService } from './bookService';

// ==================== 分组服务 ====================
export { groupService, TauriGroupService } from './groupService';
export type { IGroupService } from './groupService';

// ==================== 书签服务 ====================
export { bookmarkService, TauriBookmarkService } from './bookmarkService';
export type { IBookmarkService } from './bookmarkService';

// ==================== 阅读器设置服务 ====================
export { getReaderSettings, saveReaderSettings } from './settingsService';
export type { ReaderSettings, LanguageSetting } from './settingsService';

// ==================== 阅读统计服务 ====================
export { statsService, TauriStatsService } from './statsService';
export type { IStatsService } from './statsService';

// ==================== 封面服务 ====================
export { coverService, TauriCoverService } from './cover';
export type { ICoverService, BookNeedingCoverRebuild } from './cover';

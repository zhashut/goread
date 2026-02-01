import { IStatsSummary, IDailyStats, IRangeStats, IBookReadingStats } from '../types';
import { getInvoke } from './commonService';

// 统计服务接口
export interface IStatsService {
  saveReadingSession(bookId: number, duration: number, startTime: number, readDate: string, pagesRead?: number): Promise<void>;
  getStatsSummary(): Promise<IStatsSummary>;
  getDailyStats(days: number): Promise<IDailyStats[]>;
  getReadingStatsByRange(rangeType: string, offset: number): Promise<IRangeStats>;
  getDayStatsByHour(date: string): Promise<number[]>;
  getBooksByDateRange(startDate: string, endDate: string): Promise<IBookReadingStats[]>;
  markBookFinished(bookId: number): Promise<void>;
  unmarkBookFinished(bookId: number): Promise<void>;
  hasReadingSessions(bookId: number): Promise<boolean>;
  invalidateCache(): void;
  isCacheValid(): boolean;
}

// 统计缓存类型
interface StatsCache {
  rangeStats: Map<string, IRangeStats>;
  books: Map<string, IBookReadingStats[]>;
  dayHourStats: Map<string, number[]>;
  summary: IStatsSummary | null;
  dailyStats: Map<number, IDailyStats[]>;
}

// 每日统计缓存管理 (自动过期: 跨天即失效)
class DailyStatsCache {
  private cache: StatsCache = {
    rangeStats: new Map(),
    books: new Map(),
    dayHourStats: new Map(),
    summary: null,
    dailyStats: new Map()
  };
  private cacheDate: string = '';

  constructor() {
    this.updateCacheDate();
  }

  private getTodayDate(): string {
    const now = new Date();
    return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  }

  private updateCacheDate() {
    this.cacheDate = this.getTodayDate();
  }

  private checkExpiry() {
    const today = this.getTodayDate();
    if (today !== this.cacheDate) {
      this.invalidate();
      this.cacheDate = today;
    }
  }

  invalidate() {
    this.cache.rangeStats.clear();
    this.cache.books.clear();
    this.cache.dayHourStats.clear();
    this.cache.summary = null;
    this.cache.dailyStats.clear();
  }

  // 通用获取方法：检查过期 -> 查缓存 -> 调接口 -> 写缓存
  async getOrFetch<T>(
    getter: (cache: StatsCache) => T | undefined | null,
    setter: (cache: StatsCache, val: T) => void,
    fetcher: () => Promise<T>
  ): Promise<T> {
    this.checkExpiry();

    const cached = getter(this.cache);
    if (cached !== undefined && cached !== null) {
      return cached;
    }

    const result = await fetcher();
    setter(this.cache, result);
    return result;
  }
}

// Tauri 统计服务实现（带今日缓存）
export class TauriStatsService implements IStatsService {
  private dailyCache = new DailyStatsCache();

  invalidateCache(): void {
    this.dailyCache.invalidate();
  }

  // 始终返回 true，因为现在的缓存是内部管理的，调用者无需关心 valid 状态
  // (为了兼容接口定义，暂时保留此方法)
  isCacheValid(): boolean {
    return true; 
  }

  async saveReadingSession(
    bookId: number,
    duration: number,
    startTime: number,
    readDate: string,
    pagesReadCount?: number
  ): Promise<void> {
    const invoke = await getInvoke();
    await invoke('save_reading_session', {
      bookId,
      duration,
      startTime,
      readDate,
      pagesReadCount
    });
    this.dailyCache.invalidate();
  }

  async getStatsSummary(): Promise<IStatsSummary> {
    return this.dailyCache.getOrFetch(
      c => c.summary,
      (c, v) => c.summary = v,
      async () => {
        const invoke = await getInvoke();
        return await invoke('get_stats_summary');
      }
    );
  }

  async getDailyStats(days: number): Promise<IDailyStats[]> {
    return this.dailyCache.getOrFetch(
      c => c.dailyStats.get(days),
      (c, v) => c.dailyStats.set(days, v),
      async () => {
        const invoke = await getInvoke();
        return await invoke('get_daily_stats', { days });
      }
    );
  }

  async getReadingStatsByRange(rangeType: string, offset: number): Promise<IRangeStats> {
    const cacheKey = `${rangeType}_${offset}`;
    return this.dailyCache.getOrFetch(
      c => c.rangeStats.get(cacheKey),
      (c, v) => c.rangeStats.set(cacheKey, v),
      async () => {
        const invoke = await getInvoke();
        return await invoke('get_reading_stats_by_range', { rangeType, offset });
      }
    );
  }

  async getDayStatsByHour(date: string): Promise<number[]> {
    return this.dailyCache.getOrFetch(
      c => c.dayHourStats.get(date),
      (c, v) => c.dayHourStats.set(date, v),
      async () => {
        const invoke = await getInvoke();
        return await invoke('get_day_stats_by_hour', { date });
      }
    );
  }

  async getBooksByDateRange(startDate: string, endDate: string): Promise<IBookReadingStats[]> {
    const cacheKey = `${startDate}_${endDate}`;
    return this.dailyCache.getOrFetch(
      c => c.books.get(cacheKey),
      (c, v) => c.books.set(cacheKey, v),
      async () => {
        const invoke = await getInvoke();
        return await invoke('get_books_by_date_range', { startDate, endDate });
      }
    );
  }

  async markBookFinished(bookId: number): Promise<void> {
    const invoke = await getInvoke();
    await invoke('mark_book_finished', { bookId });
    this.dailyCache.invalidate();
  }

  async unmarkBookFinished(bookId: number): Promise<void> {
    const invoke = await getInvoke();
    await invoke('unmark_book_finished', { bookId });
    this.dailyCache.invalidate();
  }

  async hasReadingSessions(bookId: number): Promise<boolean> {
    const invoke = await getInvoke();
    return await invoke('has_reading_sessions', { bookId });
  }
}

// 统计服务实例
export const statsService = new TauriStatsService();

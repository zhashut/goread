// 书籍数据模型接口
export interface IBook {
  id: number;
  title: string;
  file_path: string;
  cover_image?: string;
  current_page: number;
  total_pages: number;
  last_read_time?: number;
  group_id?: number;
  position_in_group?: number;
  created_at?: number;
  status?: number;        // 阅读状态：0=阅读中，1=已读完
  finished_at?: number | null;   // 完成时间戳
  recent_order?: number;  // 最近阅读排序值，值越大越靠前
  theme?: 'light' | 'dark' | null;
  reading_mode?: 'horizontal' | 'vertical' | null; // 阅读模式：horizontal=横向分页，vertical=纵向滚动
  precise_progress?: number;
}

export interface IGroup {
  id: number;
  name: string;
  book_count: number;
  created_at?: number;
}

export interface IBookmark {
  id: number;
  book_id: number;
  page_number: number;
  title: string;
  created_at?: number;
}

export interface ITocItem {
  title: string;
  page_number: number;
  children: ITocItem[];
}

// 阅读器设置
export interface IReaderSettings {
  theme: 'light' | 'dark';
  render_quality: 'low' | 'medium' | 'high';
  keep_screen_on: boolean;
  auto_save_progress: boolean;
}

// 应用状态管理
export interface IAppState {
  books: IBook[];
  groups: IGroup[];
  currentBook?: IBook;
  readerSettings: IReaderSettings;
  loading: boolean;
  error?: string;
}

// ==================== 阅读统计相关类型 ====================

// 阅读会话记录
export interface IReadingSession {
  id: number;
  book_id: number;
  start_time: number;
  duration: number;
  read_date: string;
  pages_read_count?: number;
  created_at?: number;
}

// 统计概览
export interface IStatsSummary {
  total_time_seconds: number;
  streak_days: number;
  finished_books: number;
}

// 每日统计
export interface IDailyStats {
  date: string;
  total_seconds: number;
}

// 书籍阅读统计
export interface IBookReadingStats {
  book_id: number;
  title: string;
  cover_image?: string;
  total_duration: number;
  progress: string;
  last_read: string;
}

// 时间范围统计数据（柱状图用）
export interface IRangeStats {
  labels: string[];
  values: number[];
  start_date: string;
  end_date: string;
  total_seconds: number;
  previous_total_seconds: number;
}

export interface FileEntry {
  type: "file" | "dir";
  name: string;
  path: string;
  size?: number;
  mtime?: number;
  children_count?: number;
}

export interface ScanResultItem extends FileEntry {
  imported?: boolean;
  type: "file";
}

// 外部文件打开事件载荷（Android/iOS 统一接口）
export interface ExternalFileOpenPayload {
  uri: string;
  mimeType?: string;
  displayName?: string;
  fromNewIntent?: boolean;
  platform?: 'android' | 'ios' | 'unknown';
}

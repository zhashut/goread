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
  created_at?: number;
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
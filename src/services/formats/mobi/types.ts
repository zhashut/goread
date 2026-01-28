/**
 * MOBI 相关类型定义
 */

/** MOBI 书籍对象类型（来自 foliate-js） */
export interface MobiBook {
  metadata: {
    identifier?: string;
    title?: string;
    author?: string[];
    publisher?: string;
    language?: string;
    description?: string;
    published?: string;
    subject?: string[];
    rights?: string;
    contributor?: string[];
  };
  toc?: MobiTocItem[];
  landmarks?: MobiLandmark[];
  sections: MobiSection[];
  getCover(): Promise<Blob | null>;
  destroy(): void;
  dir?: string;
  rendition?: {
    layout?: string;
    viewport?: { width?: string; height?: string };
  };
  // 解析 href 并返回章节索引和锚点定位函数
  resolveHref?(href: string): Promise<{
    index: number;
    anchor: (doc: Document) => Element | null;
  }>;
  // 分割 TOC href 为索引和位置信息
  splitTOCHref?(href: string): [number, any];
}

/** MOBI 目录项类型 */
export interface MobiTocItem {
  label?: string;
  href?: string;
  subitems?: MobiTocItem[];
}

/** MOBI 章节类型 */
export interface MobiSection {
  id: number;
  load(): Promise<string>;
  createDocument(): Promise<Document>;
  size: number;
  linear?: string;
  pageSpread?: string;
}

/** MOBI 导航点类型 */
export interface MobiLandmark {
  label?: string;
  type?: string[];
  href?: string;
}

export type TocNode = {
  title: string;
  page?: number;
  anchor?: string;  // 锚点标识（Markdown heading-0 等）
  children?: TocNode[];
  expanded?: boolean;
};


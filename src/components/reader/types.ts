export type TocNode = {
  title: string;
  page?: number;
  anchor?: string;  // 锚点标识（Markdown heading-0 等）
  children?: TocNode[];
  expanded?: boolean;
};

export type InteractionType = 'none' | 'creating' | 'moving' | 'resizing';
export type ResizeHandle = 'nw' | 'ne' | 'sw' | 'se';

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

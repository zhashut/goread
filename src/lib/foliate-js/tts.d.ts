/**
 * foliate-js TTS 类的类型声明
 * 对应 tts.js 中导出的 TTS 类
 */
export class TTS {
  doc: Document;
  highlight: (range: Range) => void;

  constructor(
    doc: Document,
    textWalker: (
      x: Range | Document | DocumentFragment,
      func: (
        strs: string[],
        makeRange: (startIndex: number, startOffset: number, endIndex: number, endOffset: number) => Range,
      ) => Generator<[string, Range]>,
      filterFunc?: (node: Node) => number,
    ) => Generator<[string, Range]>,
    highlight: (range: Range) => void,
    granularity?: string,
  );

  /** 从第一个 block 开始朗读，返回 SSML 字符串 */
  start(): string | undefined;
  /** 从当前 block 继续朗读（用于暂停恢复） */
  resume(): string | undefined;
  /** 切换到上一个 block */
  prev(paused?: boolean): string | undefined;
  /** 切换到下一个 block */
  next(paused?: boolean): string | undefined;
  /** 从指定 Range 位置开始朗读 */
  from(range: Range): string | undefined;
  /** 设置朗读标记，触发高亮 */
  setMark(mark: string): void;
  /** 返回当前 block 的 ranges 副本 */
  getRanges(): Map<string, Range>;
}
